#!/usr/bin/env bash
#
# scripts/e2e-deploy-vinext.sh — knext deploy-script for the official Next.js
# compatibility harness on the **vinext single-executable axis** (#608, ADR-0048).
#
# Same harness contract as scripts/e2e-deploy.sh (the node-standalone lane): the
# harness invokes this once per fixture with cwd = the app's temp dir and reads
# EXACTLY ONE stdout line — the deployment URL. Everything else goes to stderr.
#
# WHAT IS DIFFERENT, and it is only one thing: the AXIS.
#
#   node lane:   next build → .next/standalone/server.js → boot on node
#   THIS lane:   vite build (vinext → nitro bun preset) → `bun build --compile
#                --bytecode` via knext's SHIPPED vinext-compile → boot the BINARY
#
# The corpus, the manifest, the shard count, the summary and the ledger are the
# node lane's, unchanged. That is the whole point: a number produced here is
# comparable to the node lane's 778/0 because only the artifact under test moved.
#
# ## Why the BINARY and not `.output/server/index.mjs`
#
# Booting the uncompiled nitro output under bun would be easier and would measure
# the wrong thing. Two divergences exist ONLY in the compiled artifact, and both
# are load-bearing for a real deployment:
#
#   * sharp's native addon cannot be `dlopen`ed from inside the binary's virtual
#     filesystem, so vinext-compile.mjs swaps sharp's loader for a shim that opens
#     a real file staged beside the executable (`native/`). Uncompiled, sharp
#     resolves normally and the shim is never exercised.
#   * the asset root baked into the binary is the BUILD machine's tree, so the
#     runtime has to re-derive it. Uncompiled, the baked root is simply correct.
#
# compat-smoke boots the uncompiled entry today, which is exactly the gap this
# lane exists to close. tests/compat-vinext-lane.test.ts fails if this script
# stops booting the binary.
#
# ## Honesty about what the first runs will show
#
# Most fixtures were never built by anything but `next build`. A fixture whose
# vite build or compile step fails is a REAL red on this axis — it is what "the
# compiled path is not corpus-verified" means concretely — and it is reported as
# a failure, never skipped. The first number is expected to be low. That is the
# deliverable: an honest number, not a green one.
set -euo pipefail

APP_DIR="$(pwd)"
LOG_FILE="${APP_DIR}/.adapter-build.log"
SERVER_LOG="${APP_DIR}/.adapter-server.log"
BUILD_LOG="${APP_DIR}/.adapter-vite-build.log"
BUILDER="vinext"

log() { echo "[e2e-deploy-vinext] $*" >&2; }

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p));});'
}

# ── 1. install the knext tarballs (same set, same source, as the node lane) ────
# @getknext/core is what SHIPS the compile script, so the fixture compiles with
# the artifact a user installs — not with a copy of it out of this repo.
find_tarball() { # <dir> <name-prefix> → newest matching tarball path (or empty)
  ls -1 "$1/$2"-*.tgz 2>/dev/null | sort | tail -n1 || true
}

TARBALLS_DIR="${KNEXT_E2E_TARBALLS_DIR:-}"
if [ -z "${TARBALLS_DIR}" ]; then
  log "ERROR: KNEXT_E2E_TARBALLS_DIR must point at the pre-packed @getknext/* tarballs"
  exit 1
fi
LIB_TGZ="$(find_tarball "${TARBALLS_DIR}" getknext-lib)"
DB_TGZ="$(find_tarball "${TARBALLS_DIR}" getknext-db)"
CORE_TGZ="$(find_tarball "${TARBALLS_DIR}" getknext-core)"
if [ -z "${LIB_TGZ}" ] || [ -z "${DB_TGZ}" ] || [ -z "${CORE_TGZ}" ]; then
  log "ERROR: adapter tarballs missing in ${TARBALLS_DIR} (need getknext-lib/-db/-core)"
  exit 1
fi

# ── 2. install the vinext toolchain into the fixture ──────────────────────────
# PINNED, and pinned to the versions knext's own reference app builds with
# (apps/file-manager/package.json). A floating install would make a red file
# attributable to a vinext release rather than to knext, which is the same
# mistake the bun lane made with `bun-version: latest` and had to undo.
VINEXT_VERSION="${KNEXT_VINEXT_VERSION:-1.0.0-beta.8}"
VITE_VERSION="${KNEXT_VITE_VERSION:-8.2.2}"
NITRO_VERSION="${KNEXT_NITRO_VERSION:-3.0.260610-beta}"
# vinext@1.0.0-beta.8 declares `@vitejs/plugin-rsc@^0.5.34` as an (optional) peer.
# Because the toolchain install pulls this package explicitly, npm enforces that
# range even though the peer is optional — 0.5.26 does NOT satisfy `^0.5.34`, so
# every fixture install still aborts with `npm ERESOLVE` (a SECOND conflict edge
# that only surfaces after the react-family pin is fixed, since npm reports one
# edge at a time). Pinned at 0.5.34 the whole toolchain install resolves cleanly.
PLUGIN_RSC_VERSION="${KNEXT_PLUGIN_RSC_VERSION:-0.5.34}"
# The React family (react, react-dom, react-server-dom-webpack) is versioned in
# lockstep upstream and MUST be pinned together here. vinext@1.0.0-beta.8 declares
# a `react@^19.2.6` peer; the corpus fixtures otherwise pull react@19.2.4
# transitively via next@16.2, which does NOT satisfy that peer — every fixture
# install then aborts with `npm ERESOLVE` before it can build, reddening the whole
# axis for a reason that has nothing to do with the compiled artifact. Pinning the
# whole family at the version vinext's RSC transform was built against keeps the
# runtime coherent, which `--legacy-peer-deps` (accept-and-skew) would not.
REACT_VERSION="${KNEXT_REACT_VERSION:-19.2.6}"
# The `app-dir/scss` fixtures (29 in the v16.2.0 window) ship `sass@1.54.0` —
# Next.js's own pin — but the toolchain's `vite@8.2.2` declares
# `peerOptional sass@^1.70.0`, and 1.54.0 does NOT satisfy it. Without a coherent
# pin, `npm install` aborts with `Conflicting peer dependency: sass` (ERESOLVE)
# before the fixture builds, reddening every scss fixture as an INSTALL artifact
# rather than a real vinext SCSS result. The node lane never hits this (it pulls
# no vite). Pinned at a version satisfying BOTH next@16.2's `^1.3.0` and vite@8's
# `^1.70.0` — same discipline as the React family above, NOT `--legacy-peer-deps`.
SASS_VERSION="${KNEXT_SASS_VERSION:-1.104.0}"

# ── the compile toggle (diagnostic opt-in; DEFAULT = 1 = compiled) ─────────────
# The shipped-artifact lane boots the COMPILED single executable, and that is the
# unchanged default (KNEXT_COMPILE=1). `KNEXT_COMPILE=0` is a DIAGNOSTIC opt-in
# ONLY: it skips the `bun build --compile` step (§5-6) and boots the SAME vite
# build UNCOMPILED — the nitro `.output/server/index.mjs` under bun (§7) — so a
# runtime red can be PARTITIONED:
#
#   * fails compiled AND uncompiled → a vite-pipeline / runtime bug (present both ways)
#   * fails compiled ONLY           → a compile-step bug (sharp dlopen / asset-root /
#                                     bytecode — the single-exec-specific bucket)
#
# This is NOT a new default and NOT a softening of the lane: the manifest, corpus,
# shard count, summary and ledger are identical; only the artifact under test moves.
KNEXT_COMPILE="${KNEXT_COMPILE:-1}"

# ── B3 port from the node lane (scripts/e2e-deploy.sh, #147): some fixtures ship
# hand-made packages INSIDE their own node_modules/ as test material — e.g.
# `app-dir/next-config-ts/import-from-node-modules` ships `node_modules/cjs` +
# `node_modules/esm` and its `next.config.ts` imports them. The toolchain
# `npm install` below reifies an ideal tree and PRUNES every fixture package not
# in it (the run log shows "removed N packages"), so the config load then fails
# with `Cannot find module 'cjs'` and the whole fixture reds at build. The node
# lane already snapshots these before its install and restores what the reify
# removed; port the same here. Snapshot package-level entries now; restore after.
NM_DIR="${APP_DIR}/node_modules"
NM_SNAP=""
NM_ENTRIES=""
nm_package_entries() { # <node_modules dir> → package-level entries, one per line
  (
    cd "$1" 2>/dev/null || exit 0
    for e in * @*/*; do
      if [ -e "${e}" ] || [ -L "${e}" ]; then
        case "${e}" in
          @*/*) echo "${e}" ;; # scoped package (scope children pruned individually)
          @*) : ;;             # bare scope dir — children emitted by the @*/* glob
          *) echo "${e}" ;;
        esac
      fi
    done
  )
}
if [ -d "${NM_DIR}" ]; then
  NM_SNAP="$(mktemp -d "${APP_DIR}/.knext-nm-snap.XXXXXX")"
  NM_ENTRIES="$(nm_package_entries "${NM_DIR}")"
  while IFS= read -r entry; do
    [ -n "${entry}" ] || continue
    mkdir -p "${NM_SNAP}/$(dirname "${entry}")"
    cp -RP "${NM_DIR}/${entry}" "${NM_SNAP}/${entry}" # -RP: preserve symlinks
  done <<EOF
${NM_ENTRIES}
EOF
fi

log "installing knext tarballs + the pinned vinext toolchain (vinext@${VINEXT_VERSION}, vite@${VITE_VERSION}, nitro@${NITRO_VERSION}, react@${REACT_VERSION})"
npm install --no-audit --no-fund --loglevel=error \
  "${LIB_TGZ}" "${DB_TGZ}" "${CORE_TGZ}" \
  "vinext@${VINEXT_VERSION}" \
  "vite@${VITE_VERSION}" \
  "nitro@${NITRO_VERSION}" \
  "@vitejs/plugin-rsc@${PLUGIN_RSC_VERSION}" \
  "react@${REACT_VERSION}" \
  "react-dom@${REACT_VERSION}" \
  "react-server-dom-webpack@${REACT_VERSION}" \
  "sass@${SASS_VERSION}" >&2

# Restore fixture-shipped node_modules packages the reify pruned (B3 port; see above).
if [ -n "${NM_SNAP}" ]; then
  while IFS= read -r entry; do
    [ -n "${entry}" ] || continue
    if [ ! -e "${NM_DIR}/${entry}" ] && [ ! -L "${NM_DIR}/${entry}" ]; then
      log "restoring fixture-shipped node_modules/${entry} (pruned by npm install reify)"
      mkdir -p "${NM_DIR}/$(dirname "${entry}")"
      cp -RP "${NM_SNAP}/${entry}" "${NM_DIR}/${entry}"
    fi
  done <<EOF
${NM_ENTRIES}
EOF
  rm -rf "${NM_SNAP}"
fi

# ── 3. the vite config vinext builds through ──────────────────────────────────
# Written only when the fixture has none: a fixture that ships its own vite
# config is telling us how it wants to be built, and overwriting it would test
# our config instead of the fixture.
#
# `preset: 'bun'` is not a preference — the bun-preset entry calls that runtime's
# global `serve()` at module top level, so the artifact is bun-only by
# construction (`node .output/server/index.mjs` exits 1). Code splitting is off
# because nitro-on-rolldown otherwise emits a second chunk re-exporting a
# namespace it never imports (the same finding as the reference app's config).
VITE_CONFIG="${APP_DIR}/vite.config.mjs"
if [ -e "${APP_DIR}/vite.config.ts" ] || [ -e "${APP_DIR}/vite.config.js" ] || [ -e "${VITE_CONFIG}" ]; then
  log "fixture ships its own vite config — using it verbatim"
else
  cat >"${VITE_CONFIG}" <<'VITECONFIG'
import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    vinext(),
    nitro({
      preset: 'bun',
      rollupConfig: { output: { inlineDynamicImports: true } },
    }),
  ],
});
VITECONFIG
  log "wrote ${VITE_CONFIG} (vinext + nitro bun preset)"
fi

# ── 3b. normalize the fixture to knext-vinext's ESM app contract ──────────────
# knext's scaffolder writes `"type":"module"` into the package.json of EVERY app
# it generates (templates/app/package.json.hbs), and the vinext production build
# assumes ESM: without it, vite's rsc↔ssr module graph fails with UNRESOLVED_IMPORT
# on App-Router fixtures (verified by cross-flip on the real corpus). ESM is thus
# knext-vinext's de-facto app contract. The official corpus fixtures are CommonJS,
# so we merge `"type":"module"` into the fixture's package.json here — the SAME
# class of normalization as writing the per-fixture vite.config.mjs above, and
# nothing beyond it.
#
# This is normalization-to-contract, NOT softening: it MERGES one key (preserving
# the fixture's deps/scripts/everything else) and touches no fixture source or
# tests. A CommonJS-app limitation is tracked separately, and this axis's compat
# claim is scoped to ESM apps (see docs/compat-matrix.md, the vinext row).
FIXTURE_PKG="${APP_DIR}/package.json"
if [ -f "${FIXTURE_PKG}" ]; then
  node -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
    if (pkg.type !== "module") {
      pkg.type = "module";
      fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
    }
  ' "${FIXTURE_PKG}"
  log "normalized ${FIXTURE_PKG} to \"type\":\"module\" (knext-vinext ESM app contract)"
else
  log "no package.json in fixture — skipping ESM normalization"
fi

# ── 3b. TEMPORARY: apply the cloudflare/vinext#3197 overlay ───────────────────
# vinext@1.0.0-beta.8 points its `ssr` vite-environment build `input` at the
# context-bag server entry (`VIRTUAL_SERVER_ENTRY`) even when the nitro plugin is
# present. Nitro registers that environment as its SSR service and dispatches via
# `mod.default.fetch(...)`, but the context bag has no `.fetch`, so EVERY dynamic
# route 500s (`n.fetch is not a function`). The confirmed one-line fix re-points
# the input to vinext's own worker entry under nitro. Until upstream ships #3197,
# knext overlays the installed dist so the vinext lane builds with dynamic routes
# working (500→200). Remove this whole block when vinext releases the fix.
#
# FAIL-CLOSED: the patcher errors (exit non-zero) if its anchor is not found
# exactly once — a vinext version bump that moves the anchor reds THIS lane rather
# than silently reverting to the #3197 bug. It is idempotent and does not touch
# the node/cloudflare targets (the re-point is gated on `hasNitroPlugin`).
PATCH_SCRIPT="${KNEXT_REPO_ROOT:-}/scripts/patch-vinext-3197.mjs"
if [ ! -f "${PATCH_SCRIPT}" ]; then
  # Resolve relative to this script when KNEXT_REPO_ROOT is unset (harness runs
  # with cwd = the fixture dir, so the script cannot assume its own location).
  PATCH_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/patch-vinext-3197.mjs"
fi
if [ ! -f "${PATCH_SCRIPT}" ]; then
  log "ERROR: cannot locate scripts/patch-vinext-3197.mjs (the #3197 overlay) — refusing to build the vinext lane with dynamic routes broken"
  exit 1
fi
log "applying TEMPORARY cloudflare/vinext#3197 overlay to the installed vinext dist (fail-closed)"
if ! node "${PATCH_SCRIPT}" "${APP_DIR}" >&2; then
  log "ERROR: the vinext#3197 overlay could not be applied — its anchor moved (vinext version bump?). This lane will not build a #3197-fixed artifact until the overlay is re-derived."
  exit 1
fi

# The deployment identity the harness's skew/asset tests key on. Generated
# BEFORE the build so the build and the runtime agree.
DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-knext-vinext-$(date +%s)-$$}"
export NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}"

# ── 4. vite build → the nitro bun-preset .output ──────────────────────────────
log "running vite build (vinext → nitro bun preset; log → ${BUILD_LOG})"
if ! NODE_ENV=production npx --no-install vite build >"${BUILD_LOG}" 2>&1; then
  log "ERROR: vite build failed — the vinext axis cannot produce an artifact for this fixture"
  tail -n 120 "${BUILD_LOG}" >&2 || true
  exit 1
fi

NITRO_ENTRY="${APP_DIR}/.output/server/index.mjs"
if [ ! -f "${NITRO_ENTRY}" ]; then
  log "ERROR: vite build finished but ${NITRO_ENTRY} is absent — nothing to compile"
  tail -n 120 "${BUILD_LOG}" >&2 || true
  exit 1
fi

# ── 5. compile the single executable — knext's SHIPPED script ─────────────────
# Resolved out of the INSTALLED @getknext/core so this lane exercises the same
# compile a `kn-next build --target=vinext` user gets. No repo-source fallback:
# silently compiling with an uninstalled copy would make the number describe an
# artifact nobody ships.
#
# Gated on KNEXT_COMPILE: in the default (compiled) mode we build the binary and
# boot it; in the diagnostic (KNEXT_COMPILE=0) mode BOTH the compile (§5) and the
# sharp-staging (§6, which exists only because the binary cannot dlopen its own
# vfs) are skipped, and the uncompiled nitro entry is booted directly under bun.
if [ "${KNEXT_COMPILE}" != "0" ]; then
  COMPILE_SCRIPT="${APP_DIR}/node_modules/@getknext/core/dist/adapters/vinext-compile.js"
  if [ ! -f "${COMPILE_SCRIPT}" ]; then
    log "ERROR: the installed @getknext/core ships no dist/adapters/vinext-compile.js (${COMPILE_SCRIPT}) — the packed tarball is not the shipped shape"
    exit 1
  fi

  KNEXT_EXEC="${APP_DIR}/knext-exec-e2e"
  log "compiling the single executable (bun, bytecode, minified) → ${KNEXT_EXEC}"
  if ! bun run "${COMPILE_SCRIPT}" --entry "${NITRO_ENTRY}" --outfile "${KNEXT_EXEC}" >&2; then
    log "ERROR: the single-executable compile failed for this fixture"
    exit 1
  fi
  if [ ! -x "${KNEXT_EXEC}" ]; then
    log "ERROR: ${KNEXT_EXEC} was not produced (or is not executable)"
    exit 1
  fi

  # ── 6. stage sharp's addon beside the binary ────────────────────────────────
  # The compiled binary cannot dlopen a path inside its own virtual filesystem, so
  # the addon has to be a real file next to the executable. Absent sharp is fine
  # and silent — a fixture that never touches next/image pulls no @img packages.
  for candidate in \
    "${APP_DIR}/node_modules/@img" \
    "${APP_DIR}/node_modules/.bun/node_modules/@img"; do
    if [ -d "${candidate}" ]; then
      mkdir -p "${APP_DIR}/native"
      cp -RL "${candidate}"/* "${APP_DIR}/native/" 2>/dev/null || true
      log "staged sharp native packages from ${candidate} → ${APP_DIR}/native"
      break
    fi
  done
else
  KNEXT_EXEC=""
  log "KNEXT_COMPILE=0 — DIAGNOSTIC uncompiled boot: skipping the single-executable compile (§5) and sharp staging (§6); the UNCOMPILED nitro output will be booted under bun (partitions compile-step bugs from vite-pipeline/runtime bugs)"
fi

# ── 7. boot the artifact on a free port ───────────────────────────────────────
# HOSTNAME is emptied rather than pinned (the node lane's B7a finding: a pinned
# 127.0.0.1 misclassifies same-origin middleware rewrites as external).
#
# Which artifact: the COMPILED binary in the default mode; the UNCOMPILED nitro
# entry under bun when KNEXT_COMPILE=0. Everything downstream (readiness, metadata,
# the single stdout URL line) is identical either way.
PORT="$(free_port)"
BUILD_ID="$(cat "${APP_DIR}/.next/BUILD_ID" 2>/dev/null || echo "${DEPLOYMENT_ID}")"

if [ "${KNEXT_COMPILE}" != "0" ]; then
  log "booting the compiled binary ${KNEXT_EXEC} on 0.0.0.0:${PORT}"
  (
    cd "${APP_DIR}"
    PORT="${PORT}" HOSTNAME="" NODE_ENV="production" \
      NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" \
      exec "${KNEXT_EXEC}"
  ) >"${SERVER_LOG}" 2>&1 &
  SERVER_PID=$!
else
  log "booting the UNCOMPILED vinext output ${NITRO_ENTRY} under bun on 0.0.0.0:${PORT}"
  (
    cd "${APP_DIR}"
    PORT="${PORT}" HOSTNAME="" NODE_ENV="production" \
      NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" \
      exec bun "${NITRO_ENTRY}"
  ) >"${SERVER_LOG}" 2>&1 &
  SERVER_PID=$!
fi

# ── 8. persist metadata BEFORE probing, so cleanup can always find it ─────────
# Same keys scripts/e2e-cleanup.sh + scripts/e2e-logs.sh read on the node lane,
# plus BUILDER/EXEC so a run's evidence names the axis it measured.
{
  echo "BUILD_ID=${BUILD_ID}"
  echo "DEPLOYMENT_ID=${DEPLOYMENT_ID}"
  echo "PORT=${PORT}"
  echo "PID=${SERVER_PID}"
  echo "RUNTIME=bun"
  echo "RUNTIME_VERSION=$(bun --version 2>/dev/null || echo unknown)"
  echo "BUILDER=${BUILDER}"
  echo "KNEXT_EXEC=${KNEXT_EXEC}"
  # Record WHICH artifact this run measured, so a ledger/evidence bundle names the
  # axis: COMPILED=true (default, the shipped single executable) vs COMPILED=false
  # (KNEXT_COMPILE=0 diagnostic, the uncompiled nitro output under bun).
  echo "COMPILED=$([ "${KNEXT_COMPILE}" != "0" ] && echo true || echo false)"
  echo "SERVER_LOG=${SERVER_LOG}"
  echo "BUILD_LOG=${BUILD_LOG}"
} >"${LOG_FILE}"

# ── 9. readiness: pid-liveness first, TCP probe second ────────────────────────
server_died() {
  log "ERROR: the binary (pid ${SERVER_PID}) exited before becoming ready"
  log "---- server log ----"
  cat "${SERVER_LOG}" >&2 || true
  exit 1
}

READY=0
for _ in $(seq 1 100); do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    server_died
  fi
  if node -e "require('net').connect(${PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 0.3
done

if [ "${READY}" != "1" ]; then
  log "ERROR: the binary never became ready on port ${PORT}"
  cat "${SERVER_LOG}" >&2 || true
  exit 1
fi

if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
  server_died
fi

log "deployment ready (vinext $([ "${KNEXT_COMPILE}" != "0" ] && echo "single executable" || echo "UNCOMPILED nitro output under bun")): build=${BUILD_ID} deployment=${DEPLOYMENT_ID} pid=${SERVER_PID}"

# ── 10. the ONLY stdout line: the deployment URL ──────────────────────────────
echo "http://localhost:${PORT}"
