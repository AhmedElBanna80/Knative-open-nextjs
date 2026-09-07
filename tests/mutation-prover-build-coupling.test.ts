import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { continueOnErrorProblem, type Job } from './helpers/blocking-gate';

/**
 * GUARD (sprint-7 A3, follow-up from #928/#1003).
 *
 * The mutation-prover fleet (`scripts/run-mutation-provers.mjs`) requires the
 * publishable closure to be BUILT first. `mutation-prove-cli-node-runtime`
 * grades `cli-node-runtime.test.ts`, whose baseline HARD-THROWS when
 * `packages/kn-next/dist/cli/kn-next.js` is absent — and `dist/` is gitignored,
 * so on a clean checkout that prover ABORTS before its first mutation
 * (`{"declared":4,"run":0}`, exit 1) and the runner correctly reds the lane.
 *
 * #928/#1003 fixed the nightly by adding a `lib -> db -> core` build step BEFORE
 * the prover-run step in `mutation-prover-nightly.yml`. But that coupling was
 * UNENFORCED: nothing asserted that a workflow which runs the fleet also builds
 * the closure first. If a future change wires `run-mutation-provers.mjs` into
 * another lane, or drops the build step from the nightly, the fleet aborts on a
 * clean checkout with NO guard flagging the missing prerequisite.
 *
 * WHAT THIS ASSERTS, per job that runs the fleet — in ANY workflow, present or
 * future, because the set is DISCOVERED by scanning every tracked workflow, not
 * enumerated:
 *
 *   1. the SAME job also carries a step that builds the publishable closure
 *      (produces `dist/cli/kn-next.js`);
 *   2. that build step PRECEDES the fleet-run step in the job's step array —
 *      building after the fleet is useless;
 *   3. the build step is NOT soft-failed (`continue-on-error`) — a soft-failed
 *      build would leave `dist/` absent and re-trigger the very abort.
 *
 * Parsed, not substring-matched, so step ordering and same-job co-location are
 * real rather than incidental adjacency in the file text.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FLEET_RUNNER = 'run-mutation-provers.mjs';

/** The bundle the fleet's cli-node-runtime prover needs on disk. */
const CLOSURE_BUNDLE = 'dist/cli/kn-next.js';

type Step = Record<string, unknown>;

function runText(step: Step): string {
  return typeof step.run === 'string' ? step.run : '';
}

function stepsOf(job: unknown): Step[] {
  if (!job || typeof job !== 'object') return [];
  const steps = (job as Record<string, unknown>).steps;
  return Array.isArray(steps) ? (steps as Step[]) : [];
}

/** A step that invokes the fleet runner. */
function isFleetStep(step: Step): boolean {
  return runText(step).includes(FLEET_RUNNER);
}

/**
 * A step that builds the publishable closure — i.e. produces
 * `packages/kn-next/dist/cli/kn-next.js`.
 *
 * `@getknext/core` is the package whose `build` emits that bin, so the canonical
 * form is `bun run --filter @getknext/core build`. An explicit mention of the
 * bundle path counts too, so an equivalent build command that names its output
 * is not a false negative. Deliberately narrow otherwise: this guard exists to
 * ensure the bundle is on disk, and a bare `build` that never reaches core does
 * not put it there. A future refactor that builds the closure by another route
 * widens this predicate WITH A REASON, which is the fail-closed behaviour we
 * want — a silent alias that skips core would leave the abort in place.
 */
function buildsClosure(step: Step): boolean {
  const t = runText(step);
  if (t.includes(CLOSURE_BUNDLE)) return true;
  return /@getknext\/core\b/.test(t) && /\bbuild\b/.test(t);
}

/**
 * The audit, on PARSED jobs. Returns one finding string per violation; empty
 * means the coupling holds everywhere the fleet runs.
 *
 * Also returns `fleetJobs`, the [workflow, jobId] pairs that run the fleet, so
 * the caller can assert non-vacuity — a scan that silently matches nothing
 * reports zero findings and reads exactly like a clean tree.
 */
function auditFleetBuildCoupling(
  jobs: Record<string, Job>,
  workflow = '<in-memory>',
): { findings: string[]; fleetJobIds: string[] } {
  const findings: string[] = [];
  const fleetJobIds: string[] = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = stepsOf(job);
    const fleetIdx = steps.findIndex(isFleetStep);
    if (fleetIdx === -1) continue;
    fleetJobIds.push(jobId);

    const buildIdx = steps.findIndex(buildsClosure);
    const where = `${workflow} job '${jobId}'`;

    if (buildIdx === -1) {
      findings.push(
        `${where} runs ${FLEET_RUNNER} but no step in the job builds the publishable ` +
          `closure (${CLOSURE_BUNDLE}) — the cli-node-runtime prover HARD-THROWS on a clean ` +
          'checkout and aborts the whole fleet. Add the lib -> db -> core build step before it.',
      );
      continue;
    }

    if (buildIdx >= fleetIdx) {
      findings.push(
        `${where} builds the closure at step ${buildIdx} but runs the fleet at step ` +
          `${fleetIdx} — the build must PRECEDE the fleet, building after it produces nothing ` +
          'the aborting prover can read.',
      );
    }

    const soft = continueOnErrorProblem(steps[buildIdx] as Job, `${where} closure-build step`);
    if (soft) {
      findings.push(
        `${soft} — a soft-failed build leaves ${CLOSURE_BUNDLE} absent, which re-triggers the ` +
          'fleet abort this coupling exists to prevent.',
      );
    }
  }
  return { findings, fleetJobIds };
}

/** Every tracked workflow file, parsed. */
function trackedWorkflows(): Array<{ path: string; jobs: Record<string, Job> }> {
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--', '.github/workflows/*.yml', '.github/workflows/*.yaml'],
    { cwd: REPO_ROOT },
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  return listed.map((rel) => {
    const doc = parse(readFileSync(resolve(REPO_ROOT, rel), 'utf8')) as {
      jobs?: Record<string, Job>;
    } | null;
    return { path: rel, jobs: (doc?.jobs ?? {}) as Record<string, Job> };
  });
}

describe('A3: every workflow that runs the mutation-prover fleet builds the closure first', () => {
  it('discovers a NON-EMPTY set of fleet-running jobs (the scan is not vacuous)', () => {
    const workflows = trackedWorkflows();
    expect(workflows.length, 'no workflows were discovered').toBeGreaterThan(10);
    const fleetJobs = workflows.flatMap((w) =>
      auditFleetBuildCoupling(w.jobs, w.path).fleetJobIds.map((j) => `${w.path}:${j}`),
    );
    // Today exactly mutation-prover-nightly.yml's `run-mutation-provers` job. If
    // this drops to zero the audit below is proving nothing — the fleet moved or
    // was renamed and the guard would silently wave every workflow through.
    expect(
      fleetJobs,
      'no job in any workflow runs the fleet — the runner was renamed/moved and this guard is now inert',
    ).not.toEqual([]);
    expect(fleetJobs).toContain(
      '.github/workflows/mutation-prover-nightly.yml:run-mutation-provers',
    );
  });

  it('EVERY fleet-running job builds the closure, in order, without a soft-fail', () => {
    const findings = trackedWorkflows().flatMap(
      (w) => auditFleetBuildCoupling(w.jobs, w.path).findings,
    );
    expect(findings, findings.join('\n  ')).toEqual([]);
  });
});

describe('A3: MUTATION-PROOF — the audit reds on each way the coupling can break', () => {
  const buildStep: Step = {
    name: 'Build the publishable closure',
    run: 'bun run --filter @getknext/core build',
  };
  const fleetStep: Step = {
    name: 'Run every mutation prover',
    run: `node scripts/${FLEET_RUNNER}`,
  };
  const healthy = (): Record<string, Job> => ({
    lane: { steps: [{ ...buildStep }, { ...fleetStep }] } as Job,
  });

  it('the healthy shape produces NO finding (non-tripwire)', () => {
    const { findings, fleetJobIds } = auditFleetBuildCoupling(healthy());
    expect(findings).toEqual([]);
    expect(fleetJobIds).toEqual(['lane']);
  });

  it('(a) the build step REMOVED is a finding', () => {
    const jobs: Record<string, Job> = { lane: { steps: [{ ...fleetStep }] } as Job };
    const { findings } = auditFleetBuildCoupling(jobs);
    expect(findings.join(' ')).toMatch(/no step in the job builds the publishable closure/);
  });

  it('(b) the build step AFTER the fleet is a finding (ordering is real)', () => {
    const jobs: Record<string, Job> = {
      lane: { steps: [{ ...fleetStep }, { ...buildStep }] } as Job,
    };
    const { findings } = auditFleetBuildCoupling(jobs);
    expect(findings.join(' ')).toMatch(/must PRECEDE the fleet/);
  });

  it('(c) a soft-failed build step is a finding (continue-on-error: true)', () => {
    const jobs: Record<string, Job> = {
      lane: {
        steps: [{ ...buildStep, 'continue-on-error': true }, { ...fleetStep }],
      } as Job,
    };
    const { findings } = auditFleetBuildCoupling(jobs);
    expect(findings.join(' ')).toMatch(/continue-on-error/);
  });

  it('(c) a soft-fail EXPRESSION is a finding too (not just the literal true)', () => {
    const jobs: Record<string, Job> = {
      lane: {
        // A GitHub expression, not the literal `true` — built by concatenation
        // so the source is not itself a template placeholder.
        steps: [{ ...buildStep, 'continue-on-error': `$${'{{ true }}'}` }, { ...fleetStep }],
      } as Job,
    };
    const { findings } = auditFleetBuildCoupling(jobs);
    expect(findings.join(' ')).toMatch(/continue-on-error/);
  });

  it('(d) a SECOND workflow running the fleet with no build step reds — coverage is universal', () => {
    // The future-lane case: a new workflow wires in the fleet and forgets the
    // build. It must red on arrival, not slip through because today only the
    // nightly runs the fleet.
    const jobs: Record<string, Job> = {
      'some-new-lane': { steps: [{ run: 'node scripts/run-mutation-provers.mjs' }] } as Job,
    };
    const { findings, fleetJobIds } = auditFleetBuildCoupling(jobs, '.github/workflows/new.yml');
    expect(fleetJobIds).toEqual(['some-new-lane']);
    expect(findings.join(' ')).toMatch(/no step in the job builds the publishable closure/);
  });

  it('a build in a DIFFERENT job does not satisfy the coupling (same-job co-location)', () => {
    const jobs: Record<string, Job> = {
      builder: { steps: [{ ...buildStep }] } as Job,
      lane: { steps: [{ ...fleetStep }] } as Job,
    };
    const { findings } = auditFleetBuildCoupling(jobs);
    expect(findings.join(' ')).toMatch(/no step in the job builds the publishable closure/);
  });

  it('a job that never runs the fleet is ignored entirely (no false positives)', () => {
    const jobs: Record<string, Job> = { unrelated: { steps: [{ run: 'echo hi' }] } as Job };
    const { findings, fleetJobIds } = auditFleetBuildCoupling(jobs);
    expect(findings).toEqual([]);
    expect(fleetJobIds).toEqual([]);
  });

  it('the explicit-bundle-path form is accepted as a build (equivalent command)', () => {
    const jobs: Record<string, Job> = {
      lane: {
        steps: [{ run: 'make packages/kn-next/dist/cli/kn-next.js' }, { ...fleetStep }],
      } as Job,
    };
    expect(auditFleetBuildCoupling(jobs).findings).toEqual([]);
  });
});
