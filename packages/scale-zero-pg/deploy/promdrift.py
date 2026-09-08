#!/usr/bin/env python3
"""promdrift.py — the OFFLINE, cluster-free drift-check LOGIC for _verify-drift.sh
section H (issue #792): "merged != deployed" on the OBSERVABILITY plane.

THE INCIDENT
------------
The live OKE Prometheus once ran a 5-week-stale `prometheus-config` ConfigMap: it
lacked the `appdb-operator` scrape job entirely, so `appdb_warm_hold_active` was
NEVER scraped and the ComputePhantomKeepalive warm-hold subtraction silently ran on
`or vector(0)`. Every scrape/rule change merged to `60-prometheus.yaml` since
mid-July was DARK on the plane, undetected — silent alert blindness, the worst
failure class (efficacy unobservable until it has already failed).

The `prometheus-config-sha256` reload contract (_validate.sh contract 27) forces a
pod roll on a config edit, but it runs OFFLINE over the manifest only — it cannot
see the live cluster, so a stale hash / stale ConfigMap / a job Prometheus never
learned about passes every offline gate. This module closes that hole by comparing
the TRACKED config against LIVE cluster data (fed in by _verify-drift.sh §H against
the OKE plane):

  1. live `prometheus-config` ConfigMap content hash == tracked `prom-config-hash`;
  2. live Prometheus Deployment `ks-pg.dev/prometheus-config-sha256` == same hash;
  3. every `job_name` in the tracked scrape config is PRESENT and healthy in the
     live Prometheus `/api/v1/targets`.

`canonical_hash()` mirrors _validate.sh's `prom_config_hash` byte-for-byte (sorted
keys, "key\nvalue\n" concatenation, sha256) so the live ConfigMap `.data` and the
tracked manifest hash are comparable.

FAIL-CLOSED
-----------
If ANY live datum is missing/unreachable/unparseable (ConfigMap absent, annotation
empty, targets API down, tracked hash/jobs empty), the verdict is FAIL — never pass.
A checker that goes green when it cannot see the plane is worse than none (the same
rule the action-pin nightly and the §0 identity guard follow).

Stdlib only. Usable two ways:
  * as a library — `check_prom_drift(...)` returns a verdict dict; and
  * as a CLI the shell (_verify-drift.sh §H) invokes with a single JSON blob on
    stdin (or a file arg): exit 0 == aligned, non-zero == drift/unreachable.
"""
import hashlib
import json
import re
import sys


def canonical_hash(data):
    """sha256 of a ConfigMap .data map, canonicalised as _validate.sh's
    prom_config_hash does (sorted keys, each emitted as "key\\nvalue\\n") with ONE
    added normalisation: each value's TRAILING newlines are stripped before hashing.

    Why the normalisation: `prom_config_hash` hashes the MANIFEST block scalars,
    whose extractor joins lines with "\\n" and so drops the final newline; but a
    kubectl-applied `key: |` (clip) ConfigMap value KEEPS one trailing newline. So
    the live ConfigMap value is `<manifest-value>\\n` — hashing them raw diverges on
    a perfectly healthy cluster (a guaranteed false-positive). Stripping trailing
    newlines on BOTH sides makes an aligned cluster compare equal while still
    catching any real scrape/rule content drift. Returns "" for empty/missing data
    so callers fail closed rather than hash nothing."""
    if not data:
        return ""
    canon = "".join(
        "%s\n%s\n" % (k, data[k].rstrip("\n")) for k in sorted(data)
    )
    return hashlib.sha256(canon.encode()).hexdigest()


def extract_manifest_cm_data(path):
    """Extract the `prometheus-config` ConfigMap's block-scalar `.data` map from a
    60-prometheus.yaml-style manifest, using the SAME indent-aware parser as
    _validate.sh's prom_config_hash (stdlib only — no pyyaml). Returns {key: value}
    (values as the manifest's dedented block text) or {} if not found."""
    text = open(path).read()
    cm = None
    for d in re.split(r"(?m)^---\s*$", text):
        if re.search(r"(?m)^kind:\s*ConfigMap\s*$", d) and "name: prometheus-config" in d:
            cm = d
            break
    if cm is None:
        return {}
    lines = cm.splitlines()
    data = {}
    i = 0
    while i < len(lines):
        m = re.match(r"^  ([^\s:]+):\s*\|\s*$", lines[i])
        if m:
            key = m.group(1)
            i += 1
            block = []
            while i < len(lines) and (lines[i].strip() == "" or lines[i].startswith("    ")):
                block.append(lines[i][4:] if lines[i].startswith("    ") else "")
                i += 1
            data[key] = "\n".join(block)
            continue
        i += 1
    return data


def _target_jobs(targets):
    """Return {job_name: healthy_bool} from a /api/v1/targets response object.
    A job is 'healthy' if it has at least one activeTarget with health == 'up'.
    Returns None if the object is missing/malformed (caller fails closed)."""
    if not isinstance(targets, dict):
        return None
    data = targets.get("data")
    if not isinstance(data, dict):
        return None
    active = data.get("activeTargets")
    if not isinstance(active, list):
        return None
    jobs = {}
    for t in active:
        if not isinstance(t, dict):
            continue
        labels = t.get("labels") or {}
        job = labels.get("job")
        if not job:
            continue
        up = str(t.get("health", "")).lower() == "up"
        jobs[job] = jobs.get(job, False) or up
    return jobs


def check_prom_drift(tracked_cm_data, tracked_annotation, tracked_jobs,
                     live_cm_data, live_annotation, targets):
    """Compare the TRACKED prometheus config against LIVE cluster data.

    Args:
      tracked_cm_data   : the MANIFEST's intended `prometheus-config` ConfigMap
                          `.data` dict (extract_manifest_cm_data). Check 1 compares
                          canonical_hash(live) vs canonical_hash(tracked) — both
                          normalised, so the applied-vs-manifest trailing-newline
                          quirk does not false-fire.
      tracked_annotation: the committed prom-config-hash (== `_validate.sh
                          prom-config-hash`, == the manifest annotation). Check 2
                          compares the LIVE annotation to this exact string.
      tracked_jobs      : list of job_name declared in the tracked scrape config.
      live_cm_data      : the live `prometheus-config` ConfigMap `.data` dict.
      live_annotation   : the live Prometheus Deployment
                          `ks-pg.dev/prometheus-config-sha256` annotation value.
      targets           : the parsed live `/api/v1/targets` response object (or None
                          if unreachable/unparseable).

    Returns {"ok": bool, "failures": [str]}. Fail-closed on any missing input.
    """
    failures = []

    # PRECONDITIONS — a missing tracked input means we cannot judge; fail closed.
    if not tracked_cm_data:
        failures.append(
            "tracked-configmap-missing: could not extract the prometheus-config "
            "ConfigMap data from 60-prometheus.yaml — parser broken? refusing to "
            "false-green (fail-closed)"
        )
    if not tracked_annotation:
        failures.append(
            "tracked-hash-missing: could not compute the tracked prom-config-hash "
            "(`_validate.sh prom-config-hash`) — refusing to false-green (fail-closed)"
        )
    if not tracked_jobs:
        failures.append(
            "tracked-jobs-missing: the scrape-config parser produced no job_name from "
            "60-prometheus.yaml — parser broken? refusing to false-green (fail-closed)"
        )

    # CHECK 1 — live ConfigMap content hash == tracked ConfigMap content hash.
    if not live_cm_data:
        failures.append(
            "configmap-unreachable: live `prometheus-config` ConfigMap .data is "
            "absent/unreadable — cannot compare content hash (fail-closed)"
        )
    elif tracked_cm_data:
        live_hash = canonical_hash(live_cm_data)
        tracked_hash = canonical_hash(tracked_cm_data)
        if live_hash != tracked_hash:
            failures.append(
                "configmap-hash-drift: live prometheus-config content hash %s != "
                "tracked content hash %s — the deployed ConfigMap is STALE (the "
                "5-week-stale-config incident). Re-apply deploy/60-prometheus.yaml."
                % (live_hash, tracked_hash)
            )

    # CHECK 2 — live Deployment annotation == committed prom-config-hash.
    if not live_annotation:
        failures.append(
            "annotation-unreachable: live Prometheus Deployment "
            "ks-pg.dev/prometheus-config-sha256 annotation is absent/unreadable "
            "(fail-closed)"
        )
    elif tracked_annotation and live_annotation != tracked_annotation:
        failures.append(
            "annotation-drift: live Deployment ks-pg.dev/prometheus-config-sha256 "
            "annotation %s != tracked prom-config-hash %s — the running pod was "
            "never rolled to the current config (merged!=deployed). Re-apply "
            "deploy/60-prometheus.yaml so the annotation rolls the pod."
            % (live_annotation, tracked_annotation)
        )

    # CHECK 3 — every tracked job_name is PRESENT and healthy in /api/v1/targets.
    live_jobs = _target_jobs(targets)
    if live_jobs is None:
        failures.append(
            "targets-unreachable: live Prometheus /api/v1/targets is "
            "unreachable/unparseable — cannot confirm scrape jobs (fail-closed)"
        )
    else:
        for job in tracked_jobs:
            if job not in live_jobs:
                failures.append(
                    "scrape-job-missing: tracked job_name '%s' is NOT present in the "
                    "live /api/v1/targets — Prometheus never learned this scrape job "
                    "(the appdb-operator incident: the metric was silently never "
                    "scraped). Re-apply deploy/60-prometheus.yaml." % job
                )
            elif not live_jobs[job]:
                failures.append(
                    "scrape-job-unhealthy: tracked job_name '%s' is present in "
                    "/api/v1/targets but NO target is health=up — the scrape is "
                    "failing (metric dark despite the job existing)." % job
                )

    return {"ok": not failures, "failures": failures}


def run_cli_from_obj(obj):
    """Run the check from a decoded JSON object and print a human verdict.
    Returns a process exit code: 0 aligned, 1 drift/unreachable, 2 bad input."""
    if not isinstance(obj, dict):
        print("FAIL: promdrift input is not a JSON object (fail-closed)",
              file=sys.stderr)
        return 2
    res = check_prom_drift(
        tracked_cm_data=obj.get("tracked_cm_data", {}) or {},
        tracked_annotation=obj.get("tracked_annotation", "") or "",
        tracked_jobs=obj.get("tracked_jobs", []) or [],
        live_cm_data=obj.get("live_cm_data", {}) or {},
        live_annotation=obj.get("live_annotation", "") or "",
        targets=obj.get("targets"),
    )
    if res["ok"]:
        n = len(obj.get("tracked_jobs", []) or [])
        print(
            "ok - prometheus config drift: live ConfigMap hash == tracked "
            "prom-config-hash AND Deployment annotation == tracked hash AND all %d "
            "tracked scrape job(s) present+up in /api/v1/targets (issue #792)" % n
        )
        return 0
    for f in res["failures"]:
        print("  PROMDRIFT: " + f, file=sys.stderr)
    print(
        "FAIL: prometheus config/scrape DRIFT — the deployed observability plane "
        "diverges from the tracked config; merged scrape/rule changes are DARK. "
        "See above (issue #792).",
        file=sys.stderr,
    )
    return 1


def main(argv):
    """CLI entry: read a JSON blob from a file arg or stdin, print verdict, exit."""
    raw = ""
    if len(argv) > 1 and argv[1] not in ("-", "--stdin"):
        with open(argv[1]) as fh:
            raw = fh.read()
    else:
        raw = sys.stdin.read()
    try:
        obj = json.loads(raw)
    except Exception as e:  # unparseable input == cannot judge == fail closed
        print("FAIL: promdrift could not parse its JSON input (%s) — fail-closed"
              % e, file=sys.stderr)
        return 2
    return run_cli_from_obj(obj)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
