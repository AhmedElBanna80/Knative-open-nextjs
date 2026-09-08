import { describe, expect, it } from 'bun:test';
import { jobs } from './helpers/release-workflow';

/**
 * GUARD for the release lane's in-run self-heal → post-coherence chain.
 *
 * ## The gap this exists to close (from the #1014 system-designer sign-off)
 *
 * The `release` job runs, in order:
 *   1. `Publish` (changesets/action) — NO `continue-on-error`, so a hard
 *      failure reds the job.
 *   2. `ensure-published-group.mjs` — the in-run self-heal, gated
 *      `if: !cancelled() && steps.gate.outcome == 'success'`, so it runs even
 *      when Publish HARD-FAILED on a partial (as long as the token was accepted).
 *   3. `verify-published-group.mjs --post` — the final independent authority
 *      that re-confirms the whole fixed group landed at one version.
 *
 * The defect: step 3 originally carried the implicit `if: success()`. Once
 * Publish hard-fails, `success()` is false, so on the hard-failed-Publish path
 * the heal in step 2 CAN succeed and make the group coherent, but the `--post`
 * authority in step 3 is SKIPPED — heal's work is never re-confirmed in that
 * run. (End state is still safe: the job fails loud and a re-run re-confirms.
 * But the final authority does not re-confirm heal in the same run.)
 *
 * The fix: the `--post` step must run in exactly the cases the heal step runs —
 * `if: !cancelled() && steps.gate.outcome == 'success'` — so heal's work is
 * always re-confirmed in-run. The job's overall conclusion STILL reflects the
 * Publish failure, because a later passing step never clears an earlier step's
 * failure and the Publish step is not `continue-on-error`.
 *
 * Both halves are asserted:
 *   - `--post` covers the heal-ran case (not bare `success()`), AND matches
 *     heal's condition exactly (it must run in precisely the cases heal does).
 *   - a failed Publish still fails the job (Publish is not continue-on-error and
 *     nothing downgrades its failure at the job level).
 */

const PUBLISH_JOB = 'release';

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: unknown;
}

function stepsOf(jobId: string): Step[] {
  const steps = jobs()[jobId]?.steps;
  return Array.isArray(steps) ? (steps as Step[]) : [];
}

/** `continue-on-error` is "on" in any form except a literal `false`/absent. */
function isBestEffort(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return value !== false;
}

const isHealStep = (s: Step): boolean =>
  typeof s.run === 'string' && s.run.includes('ensure-published-group.mjs');
const isPostStep = (s: Step): boolean =>
  typeof s.run === 'string' &&
  s.run.includes('verify-published-group.mjs') &&
  /(^|\s)--post(\s|$)/.test(s.run);
const isPublishStep = (s: Step): boolean =>
  typeof s.uses === 'string' && s.uses.includes('changesets/action');

/**
 * Normalise an `if:` expression to its semantic core so the comparison is not
 * defeated by `${{ … }}` wrapping or incidental whitespace. FAILS to a canonical
 * empty string when the `if:` is ABSENT (implicit `success()`), which is exactly
 * the wrong condition this guard must red on.
 */
function normaliseIf(step: Step): string {
  const raw = typeof step.if === 'string' ? step.if : '';
  return raw
    .replace(/\$\{\{/g, '')
    .replace(/\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('release.yml release job: the --post authority re-confirms heal in-run', () => {
  it('has the Publish → heal → --post chain', () => {
    const steps = stepsOf(PUBLISH_JOB);
    expect(steps.length, `\`${PUBLISH_JOB}\` has no steps`).toBeGreaterThan(0);
    expect(steps.some(isPublishStep), 'no changesets/action Publish step').toBe(true);
    expect(steps.some(isHealStep), 'no ensure-published-group.mjs heal step').toBe(true);
    expect(steps.some(isPostStep), 'no verify-published-group.mjs --post step').toBe(true);
  });

  it('runs the --post step in exactly the cases the heal step runs (covers hard-failed-Publish)', () => {
    const steps = stepsOf(PUBLISH_JOB);
    const heal = steps.find(isHealStep) as Step;
    const post = steps.find(isPostStep) as Step;

    const healIf = normaliseIf(heal);
    const postIf = normaliseIf(post);

    // The heal step must itself be gated on `steps.gate.outcome == 'success'`
    // and `!cancelled()` — this is the invariant the --post step must mirror.
    expect(
      healIf.includes('steps.gate.outcome') && healIf.includes("== 'success'"),
      `the heal step's \`if:\` no longer keys on \`steps.gate.outcome == 'success'\`; this guard's premise is stale. Re-derive the invariant.`,
    ).toBe(true);
    expect(healIf.includes('!cancelled()'), `the heal step no longer uses \`!cancelled()\``).toBe(
      true,
    );

    // The DEFECT: bare implicit `success()` (absent `if:`) skips --post the
    // moment Publish hard-fails, so heal's work is never re-confirmed in-run.
    expect(
      postIf.length > 0,
      `the \`--post\` step has no \`if:\` (implicit \`success()\`). On the hard-failed-Publish path \`success()\` is false, so the final coherence authority is SKIPPED even though the heal step ran and may have made the group coherent. Gate it \`if: !cancelled() && steps.gate.outcome == 'success'\` so it re-confirms heal in the same run.`,
    ).toBe(true);
    expect(
      postIf.includes('steps.gate.outcome') && postIf.includes("== 'success'"),
      `the \`--post\` step's \`if:\` does not cover the heal-ran case — it must key on \`steps.gate.outcome == 'success'\` like the heal step, or a hard-failed Publish skips the re-confirmation.`,
    ).toBe(true);

    // Match heal EXACTLY: --post must run in precisely the cases heal does.
    expect(
      postIf,
      `the \`--post\` step's \`if:\` (\`${postIf}\`) does not match the heal step's \`if:\` (\`${healIf}\`). They must be identical so \`--post\` re-confirms heal's work in exactly the runs heal executes — no wider, no narrower.`,
    ).toBe(healIf);
  });

  it('still fails the job when Publish fails (loud, not masked)', () => {
    const steps = stepsOf(PUBLISH_JOB);
    const publish = steps.find(isPublishStep) as Step;

    // Publish must NOT be continue-on-error: its hard failure has to red the job.
    expect(
      isBestEffort(publish['continue-on-error']),
      `the Publish step is \`continue-on-error\` — a hard-failed publish would then be swallowed and the lane greens on a partial. It must fail the job.`,
    ).toBe(false);

    // No job-level continue-on-error either — that would blanket-green Publish.
    expect(
      isBestEffort((jobs()[PUBLISH_JOB] as Record<string, unknown>)['continue-on-error']),
      `\`${PUBLISH_JOB}\` has a job-level \`continue-on-error\` — that masks a failed Publish. Remove it.`,
    ).toBe(false);

    // Making --post run on the heal-ran path must NOT resurrect the job to green.
    // A later passing step never clears an earlier step's failure in GitHub
    // Actions, so the only ways --post could mask Publish are (a) Publish being
    // best-effort (asserted above) or (b) --post itself being marked
    // continue-on-error. Guard (b) too.
    const post = steps.find(isPostStep) as Step;
    expect(
      isBestEffort(post['continue-on-error']),
      `the \`--post\` step is \`continue-on-error\` — combined with running on the heal-ran path, that could green a run whose Publish failed. Keep it fail-closed.`,
    ).toBe(false);
  });
});
