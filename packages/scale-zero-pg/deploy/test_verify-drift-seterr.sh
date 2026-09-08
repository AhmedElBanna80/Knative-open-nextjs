#!/usr/bin/env bash
# Regression test for _verify-drift.sh §H (issue #1023 item 1).
#
# THE BUG: §H runs under `set -eu`. A non-zero `python3` verdict (drift/unreachable)
# aborted the script IMMEDIATELY — before `H_RC=$?` was read — so the explicit
# `fail "...drift detected..."` message was DEAD and the two `mktemp` temp files
# ($H_CMFILE, $H_TGFILE) LEAKED. Behaviour was still fail-closed (the battery exited
# non-zero via `set -e`), but the intended message + cleanup never ran.
#
# THE FIX: capture the verdict with `python3 ... <<PY || H_RC=$?` so the failure is
# an OR-list (NOT fatal under `set -e`); then `rm -f` cleanup + the `fail` message
# run and the non-zero exit STILL propagates.
#
# This test reproduces the exact §H control structure in isolation, both ways, and
# proves: FIXED => fail message printed AND temp files gone AND exit non-zero;
# BROKEN (mutation) => message skipped AND temp files leak. No cluster needed.
set -u
FAILS=0
check() { if [ "$1" = "$2" ]; then echo "ok - $3"; else echo "FAIL - $3 (want '$2' got '$1')"; FAILS=$((FAILS+1)); fi; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ---- FIXED variant: the shape _verify-drift.sh §H now has --------------------
cat > "$WORK/fixed.sh" <<'SH'
set -eu
CMFILE=$(mktemp "$TMPDIR/cm.XXXXXX"); TGFILE=$(mktemp "$TMPDIR/tg.XXXXXX")
echo "$CMFILE" > "$TMPDIR/paths.txt"; echo "$TGFILE" >> "$TMPDIR/paths.txt"
fail() { echo "FAIL: $*" >&2; exit 1; }
H_RC=0
python3 - <<'PY' || H_RC=$?
import sys
sys.exit(1)  # simulate a drift/unreachable verdict
PY
rm -f "$CMFILE" "$TGFILE"
[ "$H_RC" -eq 0 ] || fail "prometheus config/scrape drift detected (issue #792)"
echo "should-not-reach"
SH

# ---- BROKEN variant: the pre-#1023 shape (no `|| H_RC=$?`) -------------------
cat > "$WORK/broken.sh" <<'SH'
set -eu
CMFILE=$(mktemp "$TMPDIR/cm.XXXXXX"); TGFILE=$(mktemp "$TMPDIR/tg.XXXXXX")
echo "$CMFILE" > "$TMPDIR/paths.txt"; echo "$TGFILE" >> "$TMPDIR/paths.txt"
fail() { echo "FAIL: $*" >&2; exit 1; }
python3 - <<'PY'
import sys
sys.exit(1)  # simulate a drift/unreachable verdict
PY
H_RC=$?
rm -f "$CMFILE" "$TGFILE"
[ "$H_RC" -eq 0 ] || fail "prometheus config/scrape drift detected (issue #792)"
echo "should-not-reach"
SH

run_variant() {
  d=$(mktemp -d)
  out=$(TMPDIR="$d" bash "$WORK/$1.sh" 2>&1); rc=$?
  # temp-file leak check: were the two mktemp files cleaned up?
  leaked=0
  while IFS= read -r p; do [ -e "$p" ] && leaked=$((leaked+1)); done < "$d/paths.txt"
  echo "$rc|$leaked|$out"
  rm -rf "$d"
}

# --- FIXED: message printed, temps cleaned, exit non-zero --------------------
res=$(run_variant fixed)
frc=${res%%|*}; rest=${res#*|}; fleak=${rest%%|*}; fout=${rest#*|}
check "$frc" "1" "FIXED exits non-zero on drift (fail-closed preserved)"
check "$fleak" "0" "FIXED cleans up both mktemp temp files"
case "$fout" in *"drift detected"*) check "yes" "yes" "FIXED emits the explicit fail message";; *) check "no" "yes" "FIXED emits the explicit fail message";; esac
case "$fout" in *should-not-reach*) check "reached" "not" "FIXED still aborts after fail (no continue)";; *) check "not" "not" "FIXED still aborts after fail (no continue)";; esac

# --- BROKEN: demonstrates the bug the fix closes ----------------------------
res=$(run_variant broken)
brc=${res%%|*}; rest=${res#*|}; bleak=${rest%%|*}; bout=${rest#*|}
check "$brc" "1" "BROKEN still exits non-zero (set -e abort — fail-closed was never the bug)"
case "$bout" in *"drift detected"*) check "printed" "skipped" "BROKEN SKIPS the fail message (the bug)";; *) check "skipped" "skipped" "BROKEN SKIPS the fail message (the bug)";; esac
check "$bleak" "2" "BROKEN LEAKS both mktemp temp files (the bug)"

echo "---"
if [ "$FAILS" -eq 0 ]; then echo "PASS: §H set -e RC-capture fix verified"; exit 0; else echo "FAILED: $FAILS assertion(s)"; exit 1; fi
