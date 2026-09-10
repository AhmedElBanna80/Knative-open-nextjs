/**
 * The `KNEXT_COMPILE` uncompiled-boot toggle on the vinext deploy script.
 *
 * The vinext compat lane always boots the COMPILED single executable — that is
 * the shipped artifact and its default is deliberately unchanged. This toggle
 * adds a DIAGNOSTIC opt-in (`KNEXT_COMPILE=0`) that boots the SAME vite build
 * UNCOMPILED (the nitro `.output/server/index.mjs` under bun), so a runtime red
 * can be partitioned into:
 *   * compile-step bugs   — sharp dlopen / asset-root / bytecode (single-exec only)
 *   * vite-pipeline/runtime bugs — present uncompiled too
 *
 * Two properties are load-bearing and each is guarded here, with a mutation named
 * in the comment that MUST turn it red:
 *
 *  1. **The default stays compiled.** `KNEXT_COMPILE` unset ⇒ `1` ⇒ the binary
 *     boot path. Flipping the default to `0` is the mutation this must catch —
 *     it would silently change what the shipped-artifact lane measures.
 *  2. **`KNEXT_COMPILE=0` takes the uncompiled path.** It skips the compile step
 *     (§5) and boots `${NITRO_ENTRY}` under bun (§7). Removing the toggle — so the
 *     script always compiles — is the mutation this must catch.
 *
 * The sibling `tests/compat-vinext-lane.test.ts` guards that the DEFAULT lane
 * still boots the binary and still counts the same corpus; nothing here softens
 * that. This file only proves the opt-in exists and is wired to the right paths.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SCRIPT = 'scripts/e2e-deploy-vinext.sh';

const script = (): string => readFileSync(resolve(repoRoot, DEPLOY_SCRIPT), 'utf8');

/** The script's own lines, with full-line `#` comments removed (prose is not code). */
const codeLines = (): string[] =>
  script()
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));

const firstIndex = (lines: string[], re: RegExp): number => lines.findIndex((l) => re.test(l));

describe('the vinext deploy script exposes a KNEXT_COMPILE toggle whose default is compiled', () => {
  it('defines KNEXT_COMPILE exactly once, defaulting to 1 (compiled) — never 0', () => {
    // The mutation this catches: flipping the default to `:-0`. The shipped lane
    // would then boot the uncompiled output while still claiming to measure the
    // single executable.
    const defs = codeLines().filter((l) => /KNEXT_COMPILE="\$\{KNEXT_COMPILE:-/.test(l));
    expect(defs.length, 'KNEXT_COMPILE must be defined exactly once, with a default').toBe(1);
    expect(defs[0]).toMatch(/KNEXT_COMPILE="\$\{KNEXT_COMPILE:-1\}"/);
    // Belt and braces: assert the default token is literally `1`, so a `:-0`
    // default fails HERE even if the regex above were ever loosened.
    const def = defs[0] ?? '';
    const m = def.match(/KNEXT_COMPILE:-(\d)\}/);
    expect(m?.[1], 'the default must be the compiled mode (1)').toBe('1');
  });
});

describe('the compile step (§5-6) is gated on the toggle and skipped when KNEXT_COMPILE=0', () => {
  it('resolves and invokes the shipped compile script INSIDE a `KNEXT_COMPILE != 0` gate', () => {
    // The mutation this catches: removing the toggle so the compile runs
    // unconditionally. The gate must appear before the compile invocation.
    const lines = codeLines();
    const gateIdx = firstIndex(lines, /if \[ "\$\{KNEXT_COMPILE\}" != "0" \]; then/);
    const compileIdx = firstIndex(lines, /bun run "\$\{COMPILE_SCRIPT\}"/);
    expect(gateIdx, 'a `KNEXT_COMPILE != 0` gate must exist').toBeGreaterThanOrEqual(0);
    expect(compileIdx, 'the compile invocation must exist').toBeGreaterThanOrEqual(0);
    expect(
      gateIdx,
      'the single-executable compile must be gated on KNEXT_COMPILE, not run unconditionally',
    ).toBeLessThan(compileIdx);
  });

  it('names the uncompiled-diagnostic skip in the else branch', () => {
    // A clear log line records which mode ran (the summary schema is produced by
    // the workflow, not this script, so the script records the mode itself).
    expect(script()).toContain('KNEXT_COMPILE=0');
    // And the run metadata carries the axis, so a ledger/evidence bundle names it.
    expect(script()).toMatch(/COMPILED=/);
  });
});

describe('KNEXT_COMPILE=0 boots the UNCOMPILED nitro output under bun; the default boots the binary', () => {
  it('still boots the compiled binary in the default path', () => {
    // Unchanged behaviour: the compiled branch execs the built executable.
    expect(script()).toMatch(/exec\s+"\$\{KNEXT_EXEC\}"/);
  });

  it('boots the uncompiled nitro entry (NITRO_ENTRY) under bun, exactly once', () => {
    // The mutation this catches: removing the uncompiled boot (so KNEXT_COMPILE=0
    // has nothing to boot). NITRO_ENTRY is the `.output/server/index.mjs` path.
    // Tolerates the keepalive-guard `--preload` (#1041): the boot is still a
    // single `exec bun … "${NITRO_ENTRY}"`, now with an optional preload flag.
    const boots = codeLines().filter((l) => /exec bun\b.*"\$\{NITRO_ENTRY\}"/.test(l));
    expect(boots.length, 'exactly one uncompiled bun boot of NITRO_ENTRY').toBe(1);
    // NITRO_ENTRY must actually be the uncompiled nitro output — the whole point.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts LITERAL shell text; ${APP_DIR} is a shell var, not a JS placeholder
    expect(script()).toContain('NITRO_ENTRY="${APP_DIR}/.output/server/index.mjs"');
  });

  it('places the uncompiled boot in the `else` of the boot-time `KNEXT_COMPILE != 0` gate', () => {
    // Ordering proof that the uncompiled boot is the KNEXT_COMPILE=0 branch, not a
    // second unconditional boot: gate → … → else → uncompiled boot, all in order.
    const lines = codeLines();
    const uncompiledIdx = firstIndex(lines, /exec bun\b.*"\$\{NITRO_ENTRY\}"/);
    expect(uncompiledIdx).toBeGreaterThanOrEqual(0);
    // The nearest gate + else above the uncompiled boot.
    const before = lines.slice(0, uncompiledIdx);
    const gateIdx = before.map((l) => /if \[ "\$\{KNEXT_COMPILE\}" != "0" \]; then/.test(l));
    const elseIdx = before.reduce((acc, l, i) => (/^\s*else\s*$/.test(l) ? i : acc), -1);
    const lastGate = gateIdx.reduce((acc, hit, i) => (hit ? i : acc), -1);
    expect(
      lastGate,
      'a KNEXT_COMPILE gate must precede the uncompiled boot',
    ).toBeGreaterThanOrEqual(0);
    expect(elseIdx, 'an else must precede the uncompiled boot').toBeGreaterThan(lastGate);
  });
});
