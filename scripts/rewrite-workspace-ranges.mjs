#!/usr/bin/env node
/**
 * rewrite-workspace-ranges.mjs — the FIX for the release lane's `workspace:`
 * protocol leak (sprint-8 T1). Run in `release.yml` BETWEEN the build and
 * `changeset publish`.
 *
 * ROOT CAUSE (measured, not assumed)
 * ----------------------------------
 * `bun run release` = `changeset publish`. `@changesets/cli`'s `getPublishTool`
 * only knows npm/pnpm/yarn; for a bun workspace `bun ∉ {npm,pnpm,yarn}` so it
 * falls back to `npm publish` (getPublishPlan.mjs). And `npm publish` /
 * `npm pack`, invoked in a package SUBDIR of a workspace that was installed by
 * BUN (not npm), does NOT rewrite the `workspace:` protocol — it ships it
 * verbatim. MEASURED on packages/db@0.4.0:
 *     bun pm pack -> "@getknext/lib": "^0.4.0"        (rewritten, correct)
 *     npm pack    -> "@getknext/lib": "workspace:^"   (raw, uninstallable)
 * So `@getknext/core@0.4.0` and `@getknext/db@0.4.0` went to npm with
 * `workspace:^` deps and `npm install @getknext/core@0.4.0` fails with
 * `EUNSUPPORTEDPROTOCOL — Unsupported URL Type "workspace:"`. The pre-publish
 * audit (`audit-published.mjs`) packs with `bun pm pack`, which rewrites, so it
 * never saw the leak — a false-confidence mismatch with the real publish tool.
 *
 * THE FIX
 * -------
 * Rewrite the `workspace:` ranges in the SOURCE manifests to concrete ranges
 * before `changeset publish` runs, so whatever tool publishes ships a
 * resolvable range. This is tool-agnostic: it does not matter whether
 * changesets shells to `npm publish` or `bun publish` afterwards. The rewrite
 * is ephemeral (CI runner only) — the repo keeps `workspace:` as its source of
 * truth; only the published tarball carries the concrete range.
 *
 * Semantics mirror bun/pnpm/npm workspace-protocol resolution:
 *   workspace:^        -> ^<siblingVersion>
 *   workspace:~        -> ~<siblingVersion>
 *   workspace:* | :    -> <siblingVersion>            (exact)
 *   workspace:<range>  -> <range>                     (prefix stripped)
 *
 * FAIL-CLOSED: a `workspace:` dep naming a sibling with no known version throws
 * rather than emitting a nonsense range — a broken publish must not proceed.
 *
 * Locally runnable: `node scripts/rewrite-workspace-ranges.mjs`.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workspaceRoots } from './lib/workspace-globs.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_PREFIX = 'workspace:';

/** Every group that can carry a `workspace:` spec into a published manifest. */
export const DEP_GROUPS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
];

/**
 * Resolve a single `workspace:` range against the sibling's concrete version.
 * A non-`workspace:` range is returned unchanged.
 *
 * @param {string} range the declared range, e.g. `workspace:^`
 * @param {string} siblingVersion the sibling package's concrete version
 * @returns {string} the concrete range
 */
export function rewriteWorkspaceRange(range, siblingVersion) {
  if (typeof range !== 'string' || !range.startsWith(WORKSPACE_PREFIX)) return range;
  const spec = range.slice(WORKSPACE_PREFIX.length);
  if (spec === '' || spec === '*') return siblingVersion;
  if (spec === '^') return `^${siblingVersion}`;
  if (spec === '~') return `~${siblingVersion}`;
  // An explicit range after the protocol (`workspace:^1.2.3`, `workspace:>=1`):
  // strip the protocol and keep the author's range verbatim.
  return spec;
}

/**
 * Rewrite every `workspace:` dependency in a manifest to a concrete range.
 * Pure — returns a NEW manifest, never mutates the input.
 *
 * @param {Record<string, unknown>} pkg the parsed package.json
 * @param {Map<string,string>} versionByName every workspace package's version
 * @returns {{changed: boolean, manifest: Record<string, unknown>,
 *   rewrites: Array<{group: string, dep: string, from: string, to: string}>}}
 */
export function rewriteManifest(pkg, versionByName) {
  const manifest = structuredClone(pkg);
  const rewrites = [];
  for (const group of DEP_GROUPS) {
    const deps = manifest[group];
    if (!deps || typeof deps !== 'object') continue;
    for (const [dep, range] of Object.entries(deps)) {
      if (typeof range !== 'string' || !range.startsWith(WORKSPACE_PREFIX)) continue;
      const siblingVersion = versionByName.get(dep);
      if (siblingVersion === undefined) {
        // Fail closed: a workspace: dep must name a real workspace sibling, or
        // the concrete range we would emit is a fabrication.
        throw new Error(
          `${pkg.name ?? '<unknown>'} ${group} on ${dep} is '${range}', but ${dep} is not a ` +
            'workspace package with a known version — cannot rewrite it to a concrete range',
        );
      }
      const to = rewriteWorkspaceRange(range, siblingVersion);
      deps[dep] = to;
      rewrites.push({ group, dep, from: range, to });
    }
  }
  return { changed: rewrites.length > 0, manifest, rewrites };
}

/** Read every workspace manifest as `{ dir, name, version, private }` + raw. */
function readWorkspace() {
  const manifests = [];
  for (const root of workspaceRoots()) {
    const base = join(REPO_ROOT, root);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(base, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof pkg.name !== 'string') continue;
      manifests.push({ path: manifestPath, pkg });
    }
  }
  return manifests;
}

function readIgnoreList() {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, '.changeset/config.json'), 'utf8'));
  return Array.isArray(config.ignore) ? config.ignore : [];
}

function main() {
  const workspace = readWorkspace();
  const versionByName = new Map(
    workspace
      .filter((w) => typeof w.pkg.version === 'string')
      .map((w) => [w.pkg.name, w.pkg.version]),
  );
  const ignored = new Set(readIgnoreList());

  // The set `changeset publish` publishes: public, versioned, not ignored.
  const publishable = workspace.filter(
    (w) => w.pkg.private !== true && !ignored.has(w.pkg.name) && typeof w.pkg.version === 'string',
  );

  let total = 0;
  for (const { path, pkg } of publishable) {
    const { changed, manifest, rewrites } = rewriteManifest(pkg, versionByName);
    if (!changed) continue;
    // Two-space JSON + trailing newline: the repo's manifest style, so a diff
    // (were this ever committed) is minimal.
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    total += rewrites.length;
    for (const r of rewrites) {
      console.log(
        `[rewrite-workspace-ranges] ${manifest.name} ${r.group}.${r.dep}: ${r.from} -> ${r.to}`,
      );
    }
  }
  console.log(
    total === 0
      ? '[rewrite-workspace-ranges] no workspace: ranges found in the publishable set.'
      : `[rewrite-workspace-ranges] rewrote ${total} workspace: range(s) to concrete versions.`,
  );
}

// Entrypoint-guarded so the pure helpers can be imported by the spec without
// touching the filesystem. The workflow invokes this file directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
