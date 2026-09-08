import { describe, expect, it } from 'bun:test';
import {
  ensureGroupPublished,
  GroupStillIncoherentError,
  RegistryUnreachableError,
} from '../scripts/ensure-published-group.mjs';

/**
 * `scripts/ensure-published-group.mjs` is the SELF-HEAL step wired into
 * `release.yml` AFTER `changeset publish` and BEFORE the `--post` coherence
 * guard. It exists because `changeset publish` has TWICE PARTIAL-published the
 * `@getknext/*` fixed group: `core`+`kn-next` landed at the target version but
 * `lib`/`db` did NOT, leaving `npm install @getknext/core` broken (ETARGET on an
 * unresolvable sibling). `verify-published-group.mjs --post` DETECTS that but
 * cannot PREVENT it (core is already published, immutable). A manual re-run then
 * published the missing members — proving the partial is transient/per-package.
 *
 * This step closes that gap in-run: for every fixed-group member NOT resolvable
 * at the target version, it re-publishes JUST that member's already-built +
 * workspace-rewritten tarball, with bounded retries + backoff for read-after-
 * write lag, then fails closed if the group is still incoherent.
 *
 * The pure decision/retry logic is unit-tested here with an INJECTED registry
 * resolver + publish spawn — no network, no real publish. Every verdict is a
 * return value or a thrown error the CLI maps to an exit code (never output
 * grep).
 */

const MEMBERS = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];
const TARGET = '0.5.0';

/** An injected publish spy that records which members it was asked to publish. */
function publishSpy(behaviour: (name: string) => boolean) {
  const calls: string[] = [];
  return {
    calls,
    publish: (name: string) => {
      calls.push(name);
      return { ok: behaviour(name), stderr: '' };
    },
  };
}

describe('ensureGroupPublished — re-publishes ONLY the missing members', () => {
  it('re-publishes exactly the members missing at the target, not the present ones', async () => {
    // core + kn-next landed; lib + db did NOT (the observed partial shape).
    const present = new Set(['@getknext/core', 'kn-next']);
    const { publish, calls } = publishSpy(() => true);

    const result = await ensureGroupPublished({
      members: MEMBERS,
      targetVersion: TARGET,
      probe: () => true,
      // After a member has been (re-)published, it resolves at the target.
      resolves: (name: string, version: string) =>
        version === TARGET && (present.has(name) || calls.includes(name)),
      publish,
      sleep: async () => {},
      maxAttempts: 5,
    });

    // Exactly the two missing members were re-published — core/kn-next never were.
    expect(calls.sort()).toEqual(['@getknext/db', '@getknext/lib']);
    expect(result.published.sort()).toEqual(['@getknext/db', '@getknext/lib']);
  });

  it('does nothing (no publish) when the whole group already resolves', async () => {
    const { publish, calls } = publishSpy(() => true);
    const result = await ensureGroupPublished({
      members: MEMBERS,
      targetVersion: TARGET,
      probe: () => true,
      resolves: (_name: string, version: string) => version === TARGET,
      publish,
      sleep: async () => {},
      maxAttempts: 5,
    });
    expect(calls).toEqual([]);
    expect(result.published).toEqual([]);
  });
});

describe('ensureGroupPublished — read-after-write lag', () => {
  it('publishes a missing member ONCE and waits out lag rather than re-publishing (immutability)', async () => {
    const { publish, calls } = publishSpy(() => true);
    // lib is missing; after we publish it, it stays unresolvable for one more
    // round (registry lag) before finally resolving. A second publish of an
    // already-published version would be a 403 — must NOT happen.
    let libResolveChecks = 0;
    const result = await ensureGroupPublished({
      members: MEMBERS,
      targetVersion: TARGET,
      probe: () => true,
      resolves: (name: string, version: string) => {
        if (version !== TARGET) return false;
        if (name === '@getknext/lib') {
          // published in round 0; first two post-publish checks lag → false,
          // then resolves.
          if (!calls.includes('@getknext/lib')) return false;
          libResolveChecks += 1;
          return libResolveChecks > 1;
        }
        return true;
      },
      publish,
      sleep: async () => {},
      maxAttempts: 5,
    });
    // lib published exactly once despite lag.
    expect(calls.filter((c) => c === '@getknext/lib').length).toBe(1);
    expect(result.published).toEqual(['@getknext/lib']);
  });
});

describe('ensureGroupPublished — absorbs an already-published 403 as proof-of-publication', () => {
  // The bug this covers: on the HAPPY path the upstream `changeset publish` step
  // already shipped a member, but it is not yet registry-visible at round 0
  // (read-after-write lag). It is NOT in publishedThisRun (heal never published
  // it), so the loop calls publish() on an already-published, immutable version —
  // npm returns a 403 "cannot publish over the previously published versions".
  // That 403 is POSITIVE PROOF the member is on the registry: the healer must
  // ABSORB it (treat as published, no failure, no re-hammer), and let the normal
  // resolve loop confirm it once lag clears.
  it('treats an npm "cannot publish over" 403 as published and does not re-publish that member', async () => {
    // lib was shipped by upstream publish but lags; publishing it yields the
    // benign 403. After the first (absorbed) publish attempt, lag clears and it
    // resolves. Every other member resolves immediately.
    const calls: string[] = [];
    let libAttempted = false;
    const result = await ensureGroupPublished({
      members: MEMBERS,
      targetVersion: TARGET,
      probe: () => true,
      resolves: (name: string, version: string) => {
        if (version !== TARGET) return false;
        if (name === '@getknext/lib') return libAttempted; // visible only after lag clears
        return true;
      },
      publish: (name: string) => {
        calls.push(name);
        if (name === '@getknext/lib') {
          libAttempted = true;
          return {
            ok: false,
            stderr:
              'npm error code E403\n' +
              'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@getknext%2flib - ' +
              'You cannot publish over the previously published versions: 0.5.0.',
          };
        }
        return { ok: true, stderr: '' };
      },
      sleep: async () => {},
      maxAttempts: 5,
    });

    // lib was attempted exactly once (absorbed, never re-hammered) and the run
    // reports it as published — no throw.
    expect(calls.filter((c) => c === '@getknext/lib').length).toBe(1);
    expect(result.published).toContain('@getknext/lib');
  });
});

describe('ensureGroupPublished — fail closed', () => {
  it('throws GroupStillIncoherentError when a member stays missing after max retries', async () => {
    const { publish } = publishSpy(() => false); // publish never succeeds
    await expect(
      ensureGroupPublished({
        members: MEMBERS,
        targetVersion: TARGET,
        probe: () => true,
        resolves: (name: string, version: string) => version === TARGET && name !== '@getknext/lib', // lib never lands
        publish,
        sleep: async () => {},
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(GroupStillIncoherentError);
  });

  it('does NOT absorb a non-benign 403 (auth/forbidden) — keeps retrying and fails closed', async () => {
    // A 403 that is NOT "cannot publish over an existing version" (e.g. auth) is
    // a real failure: it must NOT be swallowed as proof-of-publication. A
    // swallowed 403 would mark lib published and STOP retrying it after round 0;
    // a real failure must be RE-ATTEMPTED every round. lib is genuinely missing
    // and every publish is auth-rejected, so the run both keeps retrying lib AND
    // fails closed rather than certifying a partial group.
    const libCalls: string[] = [];
    const maxAttempts = 3;
    await expect(
      ensureGroupPublished({
        members: MEMBERS,
        targetVersion: TARGET,
        probe: () => true,
        resolves: (name: string, version: string) => version === TARGET && name !== '@getknext/lib',
        publish: (name: string) => {
          if (name === '@getknext/lib') {
            libCalls.push(name);
            return {
              ok: false,
              stderr:
                'npm error code E403\n' +
                'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@getknext%2flib - ' +
                'Forbidden: you do not have permission to publish "@getknext/lib". Are you logged in?',
            };
          }
          return { ok: true, stderr: '' };
        },
        sleep: async () => {},
        maxAttempts,
      }),
    ).rejects.toBeInstanceOf(GroupStillIncoherentError);
    // Retried every round — NOT absorbed-and-skipped after the first attempt.
    expect(libCalls.length).toBe(maxAttempts);
  });

  it('throws RegistryUnreachableError when the reachability probe fails (never certifies from an unreachable registry)', async () => {
    const { publish } = publishSpy(() => true);
    await expect(
      ensureGroupPublished({
        members: MEMBERS,
        targetVersion: TARGET,
        probe: () => false,
        resolves: () => true,
        publish,
        sleep: async () => {},
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(RegistryUnreachableError);
  });
});
