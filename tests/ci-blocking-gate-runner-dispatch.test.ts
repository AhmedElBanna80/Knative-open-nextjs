import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GATES, resolveSpecRunner, runGateTest } from '../scripts/lib/ci-blocking-gate-proof.mjs';

/**
 * #960 — `runGateTest` must DISPATCH on the spec's framework.
 *
 * The whole ci.yml blocking-gate prover funnels through `runGateTest`. The gate
 * specs migrated to `bun:test`, and `runGateTest` still resolved VITEST
 * unconditionally — vitest collects NOTHING from a bun:test file, so every gate
 * reported `ran === 0`, the prover aborted at baseline, and the nightly lane
 * reddened reporting `declared 40 but ran 0`.
 *
 * The #902 fix already shipped `resolveSpecRunner`, which dispatches bun:test
 * specs to `scripts/bun-test.mjs`. It was simply never wired into `runGateTest`.
 * This asserts the wiring — and that the `ran` count survives the crossing,
 * because the prover uses `ran === 0` to distinguish a real green from a
 * `-t`-matched-nothing green.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

// A gate whose spec is a bun:test file — the shape that broke. Every GATES spec
// is bun:test today, so pick the first rather than hard-code a path.
const bunGate = GATES.find((g) => {
  const src = readFileSync(resolve(REPO_ROOT, g.spec), 'utf8');
  return /from\s+['"]bun:test['"]/.test(src);
});

describe('#960 runGateTest dispatches on spec framework', () => {
  it('a bun:test gate spec is dispatched through scripts/bun-test.mjs, not vitest', () => {
    expect(bunGate, 'expected at least one bun:test gate spec').toBeDefined();
    const runner = resolveSpecRunner(REPO_ROOT, bunGate!.spec);
    expect(runner.args.join(' ')).toContain('bun-test.mjs');
  });

  it('runs the selected assertion and counts it (ran > 0, green at baseline)', () => {
    // Before the fix this returned { ran: 0, noTestFiles: true } because vitest
    // collected nothing from the bun:test file — the exact nightly failure.
    const result = runGateTest(REPO_ROOT, bunGate!.spec, bunGate!.testName);
    expect(result.ran, `nothing ran for ${bunGate!.spec}:\n${result.out}`).toBeGreaterThan(0);
    expect(result.ok, `baseline not green for ${bunGate!.spec}:\n${result.out}`).toBe(true);
    expect(result.collected).toBe(true);
    expect(result.noTestFiles).toBe(false);
  });

  it('a non-matching -t collects the file but counts zero — the renamed-assertion signal', () => {
    // `ran === 0` WITH `collected === true` is what lets diagnoseNothingRan
    // attribute a rename rather than a moved spec. If bun output were parsed as
    // uncollected, that attribution would be wrong.
    const result = runGateTest(REPO_ROOT, bunGate!.spec, 'zzz no assertion has this title zzz');
    expect(result.ran).toBe(0);
    expect(result.collected).toBe(true);
    expect(result.noTestFiles).toBe(false);
  });
});
