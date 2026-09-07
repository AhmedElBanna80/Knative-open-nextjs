/**
 * #932 — the artifact-contract-reality check must have a lane that BUILDS the
 * artifact it asserts against, and must FAIL rather than skip when it is absent.
 *
 * `packages/kn-next/src/__tests__/artifact-contract-reality.test.ts` gates its
 * strongest case — "the vinext entry EXISTS in the sample's built `.output`" —
 * on a require-flag: with `KNEXT_REQUIRE_OUTPUT=1` a missing `.output` is a hard
 * FAILURE, and without it the case is skipped (a clean local checkout has no
 * build). That flag is only honest if some CI job BOTH sets it AND builds
 * `examples/bun-exec/.output` first — otherwise it is the #408 defect verbatim
 * ("the flag exists, CI never sets it"), which is exactly the green-by-skip #932
 * is about, moved one level out.
 *
 * So this file guards the WIRING, mirroring `compile-cache-health-bun-ci.test.ts`.
 * It asserts BOTH halves in one job:
 *   - the ARTIFACT half — the job runs `./build.sh` (via the example's
 *     `test:image` script), which emits `.output` on the host;
 *   - the FLAG half — the job runs the contract test by PATH with
 *     `KNEXT_REQUIRE_OUTPUT=1`.
 *
 * The "is this job actually blocking?" half is NOT textual and goes through the
 * parsed audit in `tests/helpers/blocking-gate.ts`, which fails closed on any
 * job-level key it does not recognise and walks the `needs` closure — so a
 * `needs:` on a skippable upstream, or a disarming `if:`/`continue-on-error:`,
 * reddens here rather than letting the gate silently stop gating.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditBlockingGate } from './helpers/blocking-gate';

const REPO_ROOT = resolve(__dirname, '..');
const CI_YML = resolve(REPO_ROOT, '.github/workflows/ci.yml');
const JOB_KEY = 'bun-exec-alpine-image:';
const TEST_PATH = 'packages/kn-next/src/__tests__/artifact-contract-reality.test.ts';

/** The job's own lines, bounded by the next top-level job key. */
function jobBlock(): string {
  const raw = readFileSync(CI_YML, 'utf8');

  // Non-vacuity: an unreadable or restructured workflow must fail loudly rather
  // than let every assertion below pass by absence.
  expect(raw.length, 'ci.yml is empty or unreadable').toBeGreaterThan(1000);
  expect(raw, 'ci.yml no longer looks like a workflow').toMatch(/^jobs:/m);

  const start = raw.indexOf(`  ${JOB_KEY}`);
  expect(start, `no ${JOB_KEY} job in ci.yml`).toBeGreaterThan(-1);

  const rest = raw.slice(start + JOB_KEY.length);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the artifact-contract-reality check is wired into a build lane (#932)', () => {
  it('runs the contract test by PATH', () => {
    // By PATH, not by a directory: the file lives under packages/, which the
    // main suite also runs, so "runs some tests" would not tell us this job runs
    // THIS file against a freshly-built `.output`. Renaming or moving it without
    // updating the job reds here.
    expect(jobBlock(), 'the job never runs the artifact-contract-reality test file').toContain(
      TEST_PATH,
    );
  });

  it('sets KNEXT_REQUIRE_OUTPUT=1, so a missing .output FAILS instead of skipping', () => {
    expect(
      jobBlock(),
      'the contract test runs WITHOUT KNEXT_REQUIRE_OUTPUT=1 — an absent .output would skip, not fail',
    ).toMatch(/KNEXT_REQUIRE_OUTPUT:\s*['"]?1['"]?/);
  });

  it('BUILDS the artifact first — the same job runs ./build.sh via test:image', () => {
    // The artifact half. `bun run test:image` runs alpine-image.docker-e2e,
    // which invokes `./build.sh` UNCONDITIONALLY and so emits
    // `examples/bun-exec/.output` on the host before the contract test reads it.
    // Without this the flag'd test would hard-fail every run (fail-closed by
    // design), which is loud, not silent — but the artifact belongs in the same
    // job so the two cannot drift onto different runners.
    expect(
      jobBlock(),
      'the job never builds the sample — no `bun run test:image` (./build.sh) step to emit .output',
    ).toMatch(/bun run test:image/);
  });

  it('the build step really invokes build.sh, which really emits .output', () => {
    // Cross-check the indirection above against the test the step runs: if
    // alpine-image.docker-e2e stops calling build.sh, the artifact half is a lie
    // and this reds even while the job text still says `test:image`.
    const dockerE2e = readFileSync(
      resolve(REPO_ROOT, 'examples/bun-exec/test/alpine-image.docker-e2e.test.ts'),
      'utf8',
    );
    expect(dockerE2e, 'the alpine e2e no longer runs ./build.sh').toMatch(/build\.sh/);
    const buildSh = readFileSync(resolve(REPO_ROOT, 'examples/bun-exec/build.sh'), 'utf8');
    expect(buildSh, 'build.sh no longer emits the vinext .output tree').toMatch(
      /\.output\/server\/index\.mjs/,
    );
  });

  it('runs unconditionally on a PR and its failure fails the run', () => {
    // PARSED, not text-matched — a disarming `if:`/`continue-on-error:` or a
    // skippable `needs:` upstream would leave every string assertion above green
    // while the gate stopped gating.
    const audit = auditBlockingGate({
      workflowPath: CI_YML,
      jobId: 'bun-exec-alpine-image',
      gateCommand: /artifact-contract-reality\.test\.ts/,
    });
    // Non-vacuity: an audit that parsed nothing must not pass by finding no
    // problem to report.
    expect(audit.jobsSeen, 'the audit parsed no jobs at all').toBeGreaterThan(5);
    expect(audit.gateStepsSeen, 'the audit never found the step that runs the contract test').toBe(
      1,
    );
    expect(audit.problems, audit.problems.join('\n')).toEqual([]);
  });

  it('the test file it points at really exists', () => {
    expect(() => readFileSync(resolve(REPO_ROOT, TEST_PATH), 'utf8')).not.toThrow();
  });
});
