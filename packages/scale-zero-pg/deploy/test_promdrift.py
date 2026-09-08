#!/usr/bin/env python3
"""Tests for promdrift.py — the OFFLINE, cluster-free drift-check LOGIC behind
_verify-drift.sh section H (issue #792).

WHY THESE EXIST
---------------
The live OKE Prometheus once ran a 5-week-stale `prometheus-config` ConfigMap: it
lacked the `appdb-operator` scrape job entirely, so `appdb_warm_hold_active` was
NEVER scraped and an alert silently ran on `or vector(0)`. Every scrape/rule change
merged to `60-prometheus.yaml` since July was dark on the plane — the worst failure
class (silent alert blindness), unobservable until it has already failed.

The existing `prometheus-config-sha256` reload contract (_validate.sh contract 27)
only runs offline over the MANIFEST — it cannot see the live cluster, so a stale
hash / stale ConfigMap / a scrape job Prometheus never learned about passes every
offline gate. This module is the drift-check LOGIC that compares the TRACKED config
against LIVE cluster data (fed in by _verify-drift.sh §H against OKE):

  1. live `prometheus-config` ConfigMap content hash == tracked `prom-config-hash`;
  2. live Prometheus Deployment `ks-pg.dev/prometheus-config-sha256` == same hash;
  3. every `job_name` in the tracked scrape config is present (and up) in the live
     Prometheus `/api/v1/targets`.

Fail-closed: if any live datum is missing/unreachable the verdict is FAIL, never
pass — a checker that goes green when it cannot see the plane is worse than none.

Stdlib only (unittest) — runs in CI without a cluster or pip installs.
"""
import hashlib
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

# promdrift.py is a script, not an importable package — load it by path (the
# same pattern test_skctl.py uses).
_spec = importlib.util.spec_from_file_location(
    "promdrift", os.path.join(HERE, "promdrift.py")
)
promdrift = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(promdrift)


# --- fixtures ---------------------------------------------------------------
# The MANIFEST's ConfigMap .data (block-scalar form: the extractor joins lines
# with "\n" and DROPS the final newline). This is `tracked_cm_data`.
TRACKED_CM_DATA = {
    "prometheus.yml": "global:\n  scrape_interval: 15s\nscrape_configs:\n  - job_name: pggw",
    "rules.yml": "groups:\n  - name: x\n    rules: []",
}

# The LIVE ConfigMap .data as kubectl APPLIES a `key: |` (clip) scalar — the same
# content but with ONE trailing newline per value. Check 1 MUST treat this as
# aligned with the manifest form (the healthy-cluster false-positive this closes).
LIVE_CM_DATA_APPLIED = {k: v + "\n" for k, v in TRACKED_CM_DATA.items()}

# The committed prom-config-hash / Deployment annotation (an opaque 64-hex token;
# check 2 is a pure string compare, no hashing). In the real wire this is
# `./_validate.sh prom-config-hash`.
TRACKED_ANNOTATION = "70d0c529c6ac10f51a479e4bf70681cca0986cc560fbfc435ebd5d2ba9496a14"

# The four always-on scrape jobs the tracked 60-prometheus.yaml declares.
TRACKED_JOBS = ["pggw", "kube-state-metrics", "pswatcher", "appdb-operator"]


def targets_json(jobs_up):
    """Build a /api/v1/targets response object with one 'up' active target per
    job name in jobs_up."""
    return {
        "status": "success",
        "data": {
            "activeTargets": [
                {"labels": {"job": j}, "health": "up"} for j in jobs_up
            ],
            "droppedTargets": [],
        },
    }


def base_call(**overrides):
    """A fully-aligned call; override single kwargs per test."""
    kw = dict(
        tracked_cm_data=TRACKED_CM_DATA,
        tracked_annotation=TRACKED_ANNOTATION,
        tracked_jobs=TRACKED_JOBS,
        live_cm_data=LIVE_CM_DATA_APPLIED,
        live_annotation=TRACKED_ANNOTATION,
        targets=targets_json(TRACKED_JOBS),
    )
    kw.update(overrides)
    return promdrift.check_prom_drift(**kw)


class PromDriftTest(unittest.TestCase):
    # --- the happy path: everything aligned -> PASS -------------------------
    # Also the KEY regression: LIVE_CM_DATA_APPLIED carries the clip-scalar
    # trailing newline the manifest form lacks; an aligned cluster MUST still pass.
    def test_all_aligned_passes(self):
        res = base_call()
        self.assertTrue(res["ok"], f"aligned cluster should PASS, got {res['failures']}")
        self.assertEqual(res["failures"], [])

    def test_applied_trailing_newline_is_not_drift(self):
        # canonical_hash must normalise the trailing newline so the applied
        # ConfigMap and the manifest form hash equal (the healthy-cluster
        # false-positive this design closes).
        self.assertEqual(
            promdrift.canonical_hash(LIVE_CM_DATA_APPLIED),
            promdrift.canonical_hash(TRACKED_CM_DATA),
        )
        self.assertTrue(base_call(live_cm_data=LIVE_CM_DATA_APPLIED)["ok"])

    # --- CHECK 1: ConfigMap content hash drift ------------------------------
    def test_configmap_hash_mismatch_fails(self):
        stale = dict(LIVE_CM_DATA_APPLIED)
        stale["prometheus.yml"] = stale["prometheus.yml"].replace("pggw", "STALE")
        res = base_call(live_cm_data=stale)
        self.assertFalse(res["ok"])
        joined = " ".join(res["failures"])
        self.assertIn("configmap-hash", joined)
        # names the drift with both hashes
        self.assertIn(promdrift.canonical_hash(stale), joined)
        self.assertIn(promdrift.canonical_hash(TRACKED_CM_DATA), joined)

    # --- CHECK 2: Deployment annotation drift -------------------------------
    def test_annotation_mismatch_fails(self):
        res = base_call(live_annotation="0" * 64)  # a stale 2026-07-13-era annotation
        self.assertFalse(res["ok"])
        joined = " ".join(res["failures"])
        self.assertIn("annotation", joined)
        self.assertIn("0" * 64, joined)

    # --- CHECK 3: the EXACT incident — appdb-operator job absent ------------
    def test_missing_scrape_job_fails_and_names_it(self):
        live_jobs = [j for j in TRACKED_JOBS if j != "appdb-operator"]
        res = base_call(targets=targets_json(live_jobs))
        self.assertFalse(res["ok"])
        joined = " ".join(res["failures"])
        self.assertIn("appdb-operator", joined)
        self.assertIn("scrape-job", joined)

    # --- CHECK 3b: a tracked job present but NOT up (health) -----------------
    def test_scrape_job_present_but_down_fails(self):
        t = targets_json(TRACKED_JOBS)
        for at in t["data"]["activeTargets"]:
            if at["labels"]["job"] == "appdb-operator":
                at["health"] = "down"
        res = base_call(targets=t)
        self.assertFalse(res["ok"])
        self.assertIn("appdb-operator", " ".join(res["failures"]))

    # --- FAIL-CLOSED: unreachable / empty live data must FAIL, never pass ----
    def test_empty_configmap_fails_closed(self):
        self.assertFalse(base_call(live_cm_data={})["ok"], "empty ConfigMap must FAIL closed")

    def test_missing_annotation_fails_closed(self):
        self.assertFalse(base_call(live_annotation="")["ok"], "missing annotation must FAIL closed")

    def test_unreachable_targets_fails_closed(self):
        self.assertFalse(base_call(targets=None)["ok"], "unreachable targets must FAIL closed")

    def test_empty_tracked_annotation_fails_closed(self):
        self.assertFalse(base_call(tracked_annotation="")["ok"], "empty tracked hash must FAIL closed")

    def test_empty_tracked_cm_data_fails_closed(self):
        self.assertFalse(base_call(tracked_cm_data={})["ok"], "empty tracked cm data must FAIL closed")

    def test_empty_tracked_jobs_fails_closed(self):
        self.assertFalse(base_call(tracked_jobs=[])["ok"], "empty tracked jobs must FAIL closed")

    # --- canonical_hash: normalised sorted-key formula ----------------------
    def test_canonical_hash_formula(self):
        # sorted-key "key\nvalue\n" over TRAILING-NEWLINE-STRIPPED values, sha256.
        canon = "".join(
            "%s\n%s\n" % (k, TRACKED_CM_DATA[k].rstrip("\n"))
            for k in sorted(TRACKED_CM_DATA)
        )
        self.assertEqual(
            promdrift.canonical_hash(TRACKED_CM_DATA),
            hashlib.sha256(canon.encode()).hexdigest(),
        )

    # --- canonical_hash: FIXED VECTOR guarding the exact normalisation ------
    # test_canonical_hash_formula above recomputes the expected value with the
    # SAME rstrip("\n") formula, so an over-normalisation regression (rstrip("\n")
    # -> strip()) stays GREEN there (the M6 mutation the #1022 review flagged).
    # This test pins a LITERAL expected hash for an input carrying leading,
    # internal, and non-newline trailing whitespace. rstrip("\n") strips ONLY
    # trailing newlines, so all that whitespace is KEPT and hashed; strip() would
    # additionally drop the leading newline/spaces and the trailing spaces/tab,
    # producing a DIFFERENT hash and reddening this assertion. The constant is
    # computed for rstrip("\n") semantics — do NOT recompute it from the code.
    def test_canonical_hash_fixed_vector_pins_rstrip_semantics(self):
        data = {
            "a.yml": "\n  leading-and-internal\n  keep me  \n",
            "b.yml": "   spaced-value\ttab-kept\n\n",
        }
        # LITERAL: sha256 of sorted-key "key\nvalue\n" with value.rstrip("\n"),
        # where the leading newline/spaces and trailing spaces/tab are PRESERVED.
        self.assertEqual(
            promdrift.canonical_hash(data),
            "66ca52146e630c18a4780bafe8970a6ac5b2c739998d8be2d5c69bcf0ff8e84e",
        )

    # --- extract_manifest_cm_data pulls the two block scalars from the real manifest
    def test_extract_manifest_cm_data_from_real_manifest(self):
        data = promdrift.extract_manifest_cm_data(
            os.path.join(HERE, "60-prometheus.yaml")
        )
        self.assertEqual(set(data), {"prometheus.yml", "rules.yml"})
        self.assertIn("job_name: appdb-operator", data["prometheus.yml"])

    # --- the CLI wrapper the shell calls: exit 0 pass / non-zero fail --------
    def test_cli_pass_and_fail(self):
        good = {
            "tracked_cm_data": TRACKED_CM_DATA,
            "tracked_annotation": TRACKED_ANNOTATION,
            "tracked_jobs": TRACKED_JOBS,
            "live_cm_data": LIVE_CM_DATA_APPLIED,
            "live_annotation": TRACKED_ANNOTATION,
            "targets": targets_json(TRACKED_JOBS),
        }
        self.assertEqual(promdrift.run_cli_from_obj(good), 0)
        bad = dict(good)
        bad["targets"] = targets_json([j for j in TRACKED_JOBS if j != "appdb-operator"])
        self.assertNotEqual(promdrift.run_cli_from_obj(bad), 0)


if __name__ == "__main__":
    unittest.main()
