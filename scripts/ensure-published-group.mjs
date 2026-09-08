#!/usr/bin/env node
/**
 * ensure-published-group.mjs — the SELF-HEAL step for a PARTIAL publish
 * (sprint-8). Runs in `release.yml` AFTER `changeset publish` and BEFORE the
 * `verify-published-group.mjs --post` fail-closed assertion.
 *
 * WHY THIS EXISTS (twice-observed, transient)
 * -------------------------------------------
 * `bun run release` = `changeset publish`. For a bun workspace changesets shells
 * to per-package `npm publish` (getPublishTool: bun ∉ {npm,pnpm,yarn} → npm), and
 * a single per-package failure or registry read-after-write lag can leave a
 * SUBSET published. TWICE the `@getknext/*` fixed group went out partial —
 * `@getknext/core` + the `kn-next` alias landed at the target version but
 * `@getknext/lib`/`@getknext/db` did NOT — leaving `npm install @getknext/core`
 * broken (ETARGET on an unresolvable sibling). The `--post` guard DETECTS that
 * but cannot PREVENT it: `core` is already published and npm versions are
 * immutable. Both times a manual RE-RUN published the missing members and the
 * group became coherent — so the partial is transient/per-package, not a
 * systematic block (the token + config are fine).
 *
 * WHAT THIS DOES
 * --------------
 * Recover the partial WITHIN the run so it can never leave a broken `@latest`.
 * For every fixed-group member NOT yet resolvable on the registry at the target
 * version, re-publish JUST that member's already-built + workspace-rewritten
 * tarball (the same package dir `changeset publish` published, so its manifest
 * already carries `^<version>` sibling ranges from
 * scripts/rewrite-workspace-ranges.mjs — never a `workspace:` spec), with
 * bounded retries + backoff for read-after-write lag. It re-publishes ONLY the
 * missing members: a member already on the registry at the target is skipped,
 * because re-publishing an existing version is an immutable-403, and a
 * missing-but-just-published member is lag to wait out, not to re-push. If the
 * group is still incoherent after the bounded retries, it FAILS CLOSED (exit 1),
 * and `verify-published-group.mjs --post` remains the final assertion after it.
 *
 * FAIL-CLOSED ON AN UNREACHABLE REGISTRY, mirroring publish-preflight.mjs and
 * verify-published-group.mjs: an unanswerable "is it published?" is never read
 * as "coherent". The reachability probe hits a package that certainly exists.
 *
 * The pure retry logic is exported and unit-tested with an INJECTED resolver +
 * publish spawn (no network, no real publish); main() supplies the process
 * spawns. Every verdict is a return value or a thrown error the CLI maps to an
 * EXIT CODE — nothing reads command output.
 *
 * Usage: node scripts/ensure-published-group.mjs
 * Env:   PUBLISH_PREFLIGHT_REGISTRY (default https://registry.npmjs.org/),
 *        NODE_AUTH_TOKEN (npm auth for the re-publish)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workspaceRoots } from './lib/workspace-globs.mjs';
import {
  DEFAULT_REGISTRY,
  REACHABILITY_PROBE,
  RegistryUnreachableError,
} from './verify-published-group.mjs';

export { RegistryUnreachableError, DEFAULT_REGISTRY };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Bounded retry budget for read-after-write lag / a transient per-package fail. */
export const DEFAULT_MAX_ATTEMPTS = 6;

/** Exponential backoff, capped — deterministic so main() and tests agree. */
export function defaultBackoffMs(attempt) {
  return Math.min(30_000, 2_000 * 2 ** attempt);
}

/** Thrown when the group is STILL incoherent after the bounded retries. */
export class GroupStillIncoherentError extends Error {}

/**
 * Re-publish every fixed-group member missing at the target version until the
 * whole group resolves, or fail closed. Pure — the registry reads, the publish
 * spawn and the sleep are all injected.
 *
 * Contract:
 *   - THROWS `RegistryUnreachableError` if the probe fails at any check — an
 *     unreachable registry never certifies coherence.
 *   - Re-publishes a member AT MOST ONCE per run: once we have published it, a
 *     subsequent still-missing reading is read-after-write LAG (wait it out) —
 *     never a reason to re-publish (that would be an immutable-403).
 *   - Never publishes a member already resolvable at the target (present member).
 *   - THROWS `GroupStillIncoherentError` if any member still does not resolve at
 *     the target after `maxAttempts` rounds.
 *
 * @param {{
 *   members: string[],
 *   targetVersion: string,
 *   probe: () => boolean,
 *   resolves: (name: string, version: string) => boolean,
 *   publish: (name: string) => { ok: boolean, stderr?: string },
 *   sleep: (ms: number) => Promise<void>,
 *   maxAttempts?: number,
 *   backoffMs?: (attempt: number) => number,
 * }} input
 * @returns {Promise<{published: string[], attempts: number}>}
 */
export async function ensureGroupPublished({
  members,
  targetVersion,
  probe,
  resolves,
  publish,
  sleep,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffMs = defaultBackoffMs,
}) {
  const publishedThisRun = new Set();

  const stillMissing = () => {
    if (!probe()) {
      throw new RegistryUnreachableError(
        'cannot reach the registry — refusing to certify the published group from an ' +
          'unreachable registry',
      );
    }
    return members.filter((name) => !resolves(name, targetVersion));
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const missing = stillMissing();
    if (missing.length === 0) {
      return { published: [...publishedThisRun], attempts: attempt + 1 };
    }
    for (const name of missing) {
      // Already re-published this run but not yet resolvable → read-after-write
      // lag. Do NOT re-publish (immutable-403); the backoff below waits it out.
      if (publishedThisRun.has(name)) continue;
      const result = publish(name);
      if (result?.ok) publishedThisRun.add(name);
    }
    await sleep(backoffMs(attempt));
  }

  // Final authority read after the last backoff.
  const remaining = stillMissing();
  if (remaining.length > 0) {
    throw new GroupStillIncoherentError(
      `after ${maxAttempts} attempts these fixed-group members still do not resolve to ` +
        `${targetVersion} on the registry: ${remaining.join(', ')} — a partial publish could ` +
        'not be healed in-run. Re-run the release once the underlying registry issue clears.',
    );
  }
  return { published: [...publishedThisRun], attempts: maxAttempts };
}

// ── process wiring ─────────────────────────────────────────────────────────

/** Read every workspace manifest as `{ dir, name, version }`. */
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
      manifests.push({ dir: join(base, entry.name), name: pkg.name, version: pkg.version });
    }
  }
  return manifests;
}

function readChangesetConfig() {
  return JSON.parse(readFileSync(join(REPO_ROOT, '.changeset/config.json'), 'utf8'));
}

/** `npm view <name>@<version> version` — TRUE iff npm exited 0 (branch on exit code). */
function npmResolvesAt(name, version, registry) {
  const run = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['view', `${name}@${version}`, 'version', '--registry', registry],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (run.error) return false;
  return run.status === 0;
}

function npmProbe(registry) {
  const run = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['view', REACHABILITY_PROBE, 'version', '--registry', registry],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return !run.error && run.status === 0;
}

/**
 * `npm publish` in the member's package dir. The dir already holds the built
 * dist/ and the workspace-rewritten manifest (`^<version>` siblings), and
 * publishConfig (`access: public`, `provenance: true`) rides along — the same
 * artifact `changeset publish` shipped, so a re-publish is byte-faithful.
 */
function npmPublish(dir, registry) {
  const run = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['publish', '--registry', registry],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
  );
  return { ok: !run.error && run.status === 0, stderr: run.stderr || '' };
}

function die(message) {
  console.error(`\n[ensure-published-group] FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  const registry = process.env.PUBLISH_PREFLIGHT_REGISTRY || DEFAULT_REGISTRY;
  const config = readChangesetConfig();
  const fixedGroup = config.fixed?.[0] ?? [];
  if (fixedGroup.length === 0) die('no fixed group in .changeset/config.json to ensure');

  const workspace = readWorkspace();
  const dirByName = new Map(workspace.map((w) => [w.name, w.dir]));
  const versionByName = new Map(workspace.map((w) => [w.name, w.version]));

  // The fixed group is one version by construction; read it from any member.
  const targetVersion = versionByName.get(fixedGroup[0]);
  if (typeof targetVersion !== 'string') {
    die(`could not read a target version for ${fixedGroup[0]}`);
  }

  for (const name of fixedGroup) {
    if (!dirByName.has(name)) {
      die(`fixed-group member ${name} has no workspace directory — cannot re-publish it`);
    }
  }

  let result;
  try {
    result = await ensureGroupPublished({
      members: fixedGroup,
      targetVersion,
      probe: () => npmProbe(registry),
      resolves: (name, version) => npmResolvesAt(name, version, registry),
      publish: (name) => {
        console.log(
          `[ensure-published-group] ${name} is missing at ${targetVersion} — re-publishing ` +
            `from ${dirByName.get(name)}…`,
        );
        return npmPublish(dirByName.get(name), registry);
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  } catch (err) {
    if (err instanceof RegistryUnreachableError || err instanceof GroupStillIncoherentError) {
      die(`${registry}: ${err.message}`);
    }
    throw err;
  }

  if (result.published.length === 0) {
    console.log(
      `\n[ensure-published-group] PASS: the whole fixed group already resolves to ` +
        `${targetVersion} — nothing to heal.`,
    );
  } else {
    console.log(
      `\n[ensure-published-group] PASS: healed a partial publish — re-published ` +
        `${result.published.join(', ')} and the whole group now resolves to ${targetVersion}.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
