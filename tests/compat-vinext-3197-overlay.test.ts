/**
 * The vinext#3197 build-time overlay — wiring + fail-closed guard.
 *
 * TEMPORARY: knext overlays the installed vinext dist to work around
 * cloudflare/vinext#3197 (the vinext `ssr` vite-environment points nitro at the
 * context-bag server entry, which has no `.fetch`, so every dynamic route 500s
 * under the nitro bun preset). The confirmed one-line fix re-points that input to
 * vinext's own worker entry WHEN the nitro plugin is present. Remove the overlay
 * — and this test — when upstream releases the fix.
 *
 * Two properties are worth a guard, and each has a matching mutation:
 *
 *  1. **The overlay step is wired into the vinext lane's deploy script, before
 *     `vite build`, and is fail-closed.** Remove the step and the wiring test
 *     reds; turn the fail-closed shell guard into a swallow (`|| true`) and the
 *     fail-closed wiring test reds.
 *  2. **The patcher itself refuses to silently no-op.** A stale overlay (a vinext
 *     bump that moved the anchor) MUST red the lane, never quietly revert to the
 *     #3197 bug. Remove the anchor-count check in patch-vinext-3197.mjs and the
 *     "throws when the anchor is absent" tests red.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANCHOR,
  applyVinext3197Patch,
  REPLACEMENT,
  resolveVinextIndex,
} from '../scripts/patch-vinext-3197.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SCRIPT = 'scripts/e2e-deploy-vinext.sh';
const PATCH_SCRIPT = 'scripts/patch-vinext-3197.mjs';

const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

/** Deploy-script lines with full-line `#` comments stripped (executable half). */
function executable(rel: string): string {
  return read(rel)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * A synthetic vinext `dist/index.js` body that carries the real anchor and the
 * two symbols the replacement depends on, plus enough surrounding noise that a
 * bare `.replace` on the wrong thing would be visible. Not the real dist — the
 * patcher only ever LISTS and string-matches, never executes it.
 */
function syntheticDist(opts: { anchorCount?: number; withSymbols?: boolean } = {}): string {
  const { anchorCount = 1, withSymbols = true } = opts;
  const head = withSymbols
    ? [
        'const VIRTUAL_WORKER_ENTRY = "virtual:vinext-worker-entry";',
        'const VIRTUAL_SERVER_ENTRY = "virtual:vinext-server-entry";',
        'let hasNitroPlugin = false;',
      ].join('\n')
    : 'const VIRTUAL_SERVER_ENTRY = "virtual:vinext-server-entry";';
  const anchors = Array.from({ length: anchorCount }, () => `\t\t\t\t\t\t\t\t${ANCHOR}`).join('\n');
  return `${head}\n// build config for the ssr environment\n${anchors}\n// end\n`;
}

describe('the overlay step is wired into the vinext deploy script, before vite build', () => {
  it('invokes scripts/patch-vinext-3197.mjs', () => {
    // Removing the overlay step from the deploy script reds here.
    expect(executable(DEPLOY_SCRIPT)).toContain('patch-vinext-3197.mjs');
  });

  it('runs the overlay BEFORE `vite build` — patching after the build would be a no-op', () => {
    const body = executable(DEPLOY_SCRIPT);
    const patchAt = body.indexOf('patch-vinext-3197.mjs');
    const buildAt = body.indexOf('vite build');
    expect(patchAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(patchAt).toBeLessThan(buildAt);
  });

  it('is fail-closed: a failed patcher aborts the build (exit non-zero), never `|| true`', () => {
    const body = executable(DEPLOY_SCRIPT);
    // The invocation must be guarded by an `if ! node …` that exits non-zero, and
    // must NOT be a swallowed `… || true`. Turning the guard into a swallow reds
    // here.
    expect(body).toMatch(/if ! node "\$\{PATCH_SCRIPT\}"/);
    // The overlay invocation line itself carries no `|| true` swallow.
    const overlayLines = body.split('\n').filter((l) => l.includes('${PATCH_SCRIPT}'));
    expect(overlayLines.length).toBeGreaterThan(0);
    for (const line of overlayLines) expect(line).not.toContain('|| true');
    // And the guarded block exits the whole script on failure.
    const guardIdx = body.indexOf('if ! node "${PATCH_SCRIPT}"');
    expect(body.slice(guardIdx, guardIdx + 400)).toContain('exit 1');
  });

  it('ships the overlay script, marked TEMPORARY with the upstream reference', () => {
    const src = read(PATCH_SCRIPT);
    expect(src).toContain('TEMPORARY');
    expect(src).toContain('vinext#3197');
  });
});

describe('the overlay patcher re-points the SSR input, and is idempotent', () => {
  it('replaces the bare anchor with the nitro-gated worker-entry re-point', () => {
    const { text, already } = applyVinext3197Patch(syntheticDist());
    expect(already).toBe(false);
    expect(text).toContain(REPLACEMENT);
    // The bare `input: { index: VIRTUAL_SERVER_ENTRY },` no longer appears as a
    // standalone statement — it survives only inside the ternary's else branch.
    expect(text.split(ANCHOR).length - 1).toBe(0);
  });

  it('is idempotent — an already-patched source is returned unchanged', () => {
    const once = applyVinext3197Patch(syntheticDist()).text;
    const twice = applyVinext3197Patch(once);
    expect(twice.already).toBe(true);
    expect(twice.text).toBe(once);
  });
});

describe('the overlay patcher is FAIL-CLOSED — it never silently no-ops', () => {
  it('THROWS when the anchor is absent (a moved/minified anchor reds the lane)', () => {
    // This is the mutation the task names: delete the anchor-count check in
    // patch-vinext-3197.mjs and this assertion flips from throw to a silent
    // pass-through of the un-patched source.
    const stale = 'const VIRTUAL_SERVER_ENTRY = "x";\ninput: { index: SOMETHING_ELSE },\n';
    expect(() => applyVinext3197Patch(stale)).toThrow(/exactly once/);
  });

  it('THROWS when the anchor appears more than once (ambiguous target)', () => {
    expect(() => applyVinext3197Patch(syntheticDist({ anchorCount: 2 }))).toThrow(/exactly once/);
  });

  it('THROWS when a symbol the replacement depends on is missing', () => {
    // Anchor present but VIRTUAL_WORKER_ENTRY / hasNitroPlugin absent → the
    // re-point would not compile; refuse rather than emit a broken dist.
    expect(() => applyVinext3197Patch(syntheticDist({ withSymbols: false }))).toThrow(
      /symbols the installed dist no longer defines/,
    );
  });
});

describe('the patcher, RUN as a subprocess against a synthetic vinext install', () => {
  const scriptPath = resolve(repoRoot, PATCH_SCRIPT);

  /** Build an app root with node_modules/vinext/{package.json,dist/index.js}. */
  function makeApp(distBody: string): string {
    const app = mkdtempSync(join(tmpdir(), 'vinext-3197-app-'));
    const vinextDir = join(app, 'node_modules', 'vinext');
    mkdirSync(join(vinextDir, 'dist'), { recursive: true });
    writeFileSync(
      join(vinextDir, 'package.json'),
      JSON.stringify({
        name: 'vinext',
        version: '1.0.0-beta.8',
        exports: { '.': { import: './dist/index.js' } },
      }),
    );
    writeFileSync(join(vinextDir, 'dist', 'index.js'), distBody);
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
    return app;
  }

  function run(app: string) {
    return spawnSync(process.execPath, [scriptPath, app], { encoding: 'utf8', timeout: 30000 });
  }

  it('resolveVinextIndex finds vinext/dist/index.js via the export map, not require.resolve', () => {
    const app = makeApp(syntheticDist());
    try {
      const idx = resolveVinextIndex(app);
      expect(idx).toBe(join(app, 'node_modules', 'vinext', 'dist', 'index.js'));
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it('exits 0 and rewrites the dist when the anchor is present exactly once', () => {
    const app = makeApp(syntheticDist());
    try {
      const r = run(app);
      expect(r.status, r.stderr).toBe(0);
      const patched = readFileSync(join(app, 'node_modules', 'vinext', 'dist', 'index.js'), 'utf8');
      expect(patched).toContain(REPLACEMENT);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it('exits NON-ZERO (fail-closed) when the anchor is absent — never a silent success', () => {
    const app = makeApp('const VIRTUAL_SERVER_ENTRY = "x";\ninput: { index: MOVED },\n');
    try {
      const r = run(app);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/exactly once/);
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });
});
