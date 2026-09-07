import { describe, expect, it } from 'bun:test';
import { rewriteManifest, rewriteWorkspaceRange } from '../scripts/rewrite-workspace-ranges.mjs';

type Manifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/**
 * `scripts/rewrite-workspace-ranges.mjs` is the FIX for the release lane's
 * `workspace:` protocol leak. `changeset publish` falls back to `npm publish`
 * for a bun workspace (getPublishTool: bun ∉ {npm,pnpm,yarn} → npm), and
 * `npm publish`/`npm pack` invoked in a package subdir of a BUN-installed
 * workspace does NOT rewrite `workspace:^` — it ships it verbatim, so
 * `@getknext/core@0.4.0` went out depending on `@getknext/lib: workspace:^`
 * and every `npm install @getknext/core@0.4.0` fails with EUNSUPPORTEDPROTOCOL.
 *
 * This script rewrites the source manifests to concrete `^<version>` ranges
 * BEFORE `changeset publish` runs, so whatever tool publishes ships a
 * resolvable range. These tests pin the rewrite semantics (which mirror
 * bun/pnpm/npm workspace-protocol resolution).
 */

describe('rewriteWorkspaceRange — bun/pnpm/npm workspace-protocol semantics', () => {
  it('rewrites `workspace:^` to a caret over the sibling version', () => {
    expect(rewriteWorkspaceRange('workspace:^', '0.4.0')).toBe('^0.4.0');
  });

  it('rewrites `workspace:~` to a tilde over the sibling version', () => {
    expect(rewriteWorkspaceRange('workspace:~', '1.2.3')).toBe('~1.2.3');
  });

  it('rewrites `workspace:*` and bare `workspace:` to the exact sibling version', () => {
    expect(rewriteWorkspaceRange('workspace:*', '0.4.0')).toBe('0.4.0');
    expect(rewriteWorkspaceRange('workspace:', '0.4.0')).toBe('0.4.0');
  });

  it('strips the prefix from an explicit `workspace:<range>`, keeping the range', () => {
    expect(rewriteWorkspaceRange('workspace:^1.2.3', '9.9.9')).toBe('^1.2.3');
    expect(rewriteWorkspaceRange('workspace:1.2.3', '9.9.9')).toBe('1.2.3');
    expect(rewriteWorkspaceRange('workspace:>=1.0.0', '9.9.9')).toBe('>=1.0.0');
  });

  it('leaves a non-workspace range untouched', () => {
    expect(rewriteWorkspaceRange('^7.18.0', '0.4.0')).toBe('^7.18.0');
    expect(rewriteWorkspaceRange('>=16.0.0', '0.4.0')).toBe('>=16.0.0');
  });
});

describe('rewriteManifest — every dep group, fail-closed on an unknown sibling', () => {
  const versions = new Map([
    ['@getknext/lib', '0.4.0'],
    ['@getknext/db', '0.4.0'],
    ['@getknext/core', '0.4.0'],
  ]);

  it('rewrites workspace: deps across dependencies/peer/optional and reports the changes', () => {
    const pkg = {
      name: '@getknext/db',
      version: '0.4.0',
      dependencies: { '@getknext/lib': 'workspace:^', 'drizzle-orm': '^0.45.2' },
      peerDependencies: { 'drizzle-kit': '^0.31.0' },
    };
    const { changed, manifest, rewrites } = rewriteManifest(pkg, versions) as {
      changed: boolean;
      manifest: Manifest;
      rewrites: Array<{ group: string; dep: string; from: string; to: string }>;
    };
    expect(changed).toBe(true);
    expect(manifest.dependencies?.['@getknext/lib']).toBe('^0.4.0');
    // Both halves: the non-workspace deps are untouched.
    expect(manifest.dependencies?.['drizzle-orm']).toBe('^0.45.2');
    expect(manifest.peerDependencies?.['drizzle-kit']).toBe('^0.31.0');
    expect(rewrites).toContainEqual({
      group: 'dependencies',
      dep: '@getknext/lib',
      from: 'workspace:^',
      to: '^0.4.0',
    });
  });

  it('reports changed=false when there is no workspace: dep to rewrite', () => {
    const pkg = { name: '@getknext/lib', version: '0.4.0', dependencies: { pg: '^8.16.3' } };
    expect(rewriteManifest(pkg, versions).changed).toBe(false);
  });

  it('FAILS CLOSED when a workspace: dep names a sibling with no known version', () => {
    const pkg = {
      name: 'kn-next',
      version: '0.4.0',
      dependencies: { '@getknext/ghost': 'workspace:^' },
    };
    expect(() => rewriteManifest(pkg, versions)).toThrow(/@getknext\/ghost/);
  });
});
