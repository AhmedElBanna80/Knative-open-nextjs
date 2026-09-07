import { describe, expect, it } from 'bun:test';
import {
  fixedGroupProblems,
  RegistryUnreachableError,
  registryGroupProblems,
  workspaceProtocolProblems,
} from '../scripts/verify-published-group.mjs';

/**
 * `scripts/verify-published-group.mjs` is the GUARD that keeps a broken
 * `@getknext/*` set off the registry after two live incidents:
 *
 *   1. PARTIAL PUBLISH — `core`+`db` shipped, `lib` skipped, so `core` needed a
 *      `lib` version that did not exist. (post-publish coherence catches this.)
 *   2. `workspace:` PROTOCOL LEAK — `core@0.4.0` shipped with
 *      `@getknext/lib: workspace:^` unrewritten, uninstallable everywhere.
 *      (pre-publish `workspace:` scan on the packed tarballs catches this.)
 *
 * The pure decision logic is unit-tested here without a network or a real
 * publish; the script wires it to `npm pack` (pre) and `npm view` (post).
 */

describe('workspaceProtocolProblems — the leak that shipped 0.4.0', () => {
  it('flags any dep group still carrying a workspace: spec', () => {
    const problems = workspaceProtocolProblems([
      {
        name: '@getknext/core',
        version: '0.4.0',
        dependencies: { '@getknext/lib': 'workspace:^', '@getknext/db': 'workspace:^' },
      },
    ]);
    expect(problems.length).toBe(2);
    expect(problems.join('\n')).toContain('@getknext/lib');
    expect(problems.join('\n')).toContain('workspace:');
  });

  it('is clean when every range has been rewritten to a concrete range', () => {
    const problems = workspaceProtocolProblems([
      {
        name: '@getknext/core',
        version: '0.4.0',
        dependencies: { '@getknext/lib': '^0.4.0', '@getknext/db': '^0.4.0', pino: '^9.6.0' },
        peerDependencies: { next: '>=16.0.0' },
      },
    ]);
    expect(problems).toEqual([]);
  });

  it('inspects peer and optional groups too, not just dependencies', () => {
    const problems = workspaceProtocolProblems([
      {
        name: 'x',
        version: '1.0.0',
        peerDependencies: { '@getknext/lib': 'workspace:*' },
        optionalDependencies: { '@getknext/db': 'workspace:~' },
      },
    ]);
    expect(problems.length).toBe(2);
  });
});

describe('fixedGroupProblems — the packed set must be internally coherent', () => {
  const fixed = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];

  const coherent = [
    { name: '@getknext/lib', version: '0.4.0', dependencies: {} },
    { name: '@getknext/db', version: '0.4.0', dependencies: { '@getknext/lib': '^0.4.0' } },
    {
      name: '@getknext/core',
      version: '0.4.0',
      dependencies: { '@getknext/lib': '^0.4.0', '@getknext/db': '^0.4.0' },
    },
    { name: 'kn-next', version: '0.4.0', dependencies: { '@getknext/core': '^0.4.0' } },
  ];

  it('passes a coherent, same-version, caret-satisfiable set', () => {
    expect(fixedGroupProblems(coherent, fixed)).toEqual([]);
  });

  it('flags a MISSING fixed-group member (the partial-publish shape)', () => {
    const missingLib = coherent.filter((m) => m.name !== '@getknext/lib');
    const problems = fixedGroupProblems(missingLib, fixed);
    expect(problems.join('\n')).toContain('@getknext/lib');
  });

  it('flags a member at a DIFFERENT version than the rest of the group', () => {
    const skewed = coherent.map((m) =>
      m.name === '@getknext/db' ? { ...m, version: '0.3.1' } : m,
    );
    const problems = fixedGroupProblems(skewed, fixed);
    expect(problems.join('\n')).toContain('0.3.1');
  });

  it('flags a sibling ^-dep the co-packed sibling does not satisfy', () => {
    const stale = coherent.map((m) =>
      m.name === '@getknext/db' ? { ...m, dependencies: { '@getknext/lib': '^0.3.0' } } : m,
    );
    const problems = fixedGroupProblems(stale, fixed);
    expect(problems.join('\n')).toContain('@getknext/lib');
  });

  it('flags a surviving workspace: sibling range as un-vouchable', () => {
    const leak = coherent.map((m) =>
      m.name === '@getknext/db' ? { ...m, dependencies: { '@getknext/lib': 'workspace:^' } } : m,
    );
    expect(fixedGroupProblems(leak, fixed).length).toBeGreaterThan(0);
  });
});

describe('registryGroupProblems — post-publish, the whole group must have landed', () => {
  const members = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];
  const target = '0.4.0';

  it('is clean when every member resolves to the target version', () => {
    const problems = registryGroupProblems({
      members,
      targetVersion: target,
      probeOk: true,
      viewVersion: () => '0.4.0',
    });
    expect(problems).toEqual([]);
  });

  it('flags a member the registry does not have (partial publish, incident #1)', () => {
    const problems = registryGroupProblems({
      members,
      targetVersion: target,
      probeOk: true,
      viewVersion: (name: string) => (name === '@getknext/lib' ? null : '0.4.0'),
    });
    expect(problems.join('\n')).toContain('@getknext/lib');
  });

  it('flags a member stuck at the previous version', () => {
    const problems = registryGroupProblems({
      members,
      targetVersion: target,
      probeOk: true,
      viewVersion: (name: string) => (name === '@getknext/db' ? '0.3.1' : '0.4.0'),
    });
    expect(problems.join('\n')).toContain('0.3.1');
  });

  it('FAILS CLOSED: an unreachable registry throws, never reads as coherent', () => {
    expect(() =>
      registryGroupProblems({
        members,
        targetVersion: target,
        probeOk: false,
        viewVersion: () => '0.4.0',
      }),
    ).toThrow(RegistryUnreachableError);
  });
});
