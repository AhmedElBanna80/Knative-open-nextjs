#!/usr/bin/env node
//
// scripts/patch-vinext-3197.mjs
//
// TEMPORARY build-time overlay for cloudflare/vinext#3197.
// Remove when upstream releases the fix (re-point the SSR service to the worker
// entry under nitro).
//
// ## What is wrong upstream
//
// When vinext's vite plugin runs alongside the nitro plugin (knext's vinext
// single-executable lane: `vite build` → nitro bun preset → `bun --compile
// --bytecode`), nitro builds vinext's `ssr` vite environment into
// `_ssr/entry.mjs` and registers it as its SSR *service*, then dispatches every
// dynamic request via `mod.default.fetch(request)`. But vinext points that `ssr`
// environment's build `input` at `VIRTUAL_SERVER_ENTRY` — a CONTEXT BAG
// (`{ renderPage, matchPageRoute, handleApiRoute, … }`) with no `.default` and
// no `.fetch`. So `n.fetch` is `undefined` and every dynamic route 500s
// (`TypeError: n.fetch is not a function`). App-router routes are unaffected.
//
// ## The fix (one line, confirmed 500→200 on uncompiled bun AND the compiled
// --bytecode binary — see .claude/vinext-fork-fix-attempt.md)
//
//   input: { index: VIRTUAL_SERVER_ENTRY },
//     ->
//   input: { index: hasNitroPlugin ? VIRTUAL_WORKER_ENTRY : VIRTUAL_SERVER_ENTRY },
//
// `VIRTUAL_WORKER_ENTRY` is vinext's OWN existing worker entry (shipped for
// Cloudflare); its default export is a real WinterCG `{ async fetch(...) }`
// handler that pulls the full route table + render pipeline in. `hasNitroPlugin`
// is a flag vinext already computes in the same `config()` hook, so plain-pages
// / cloudflare / node targets are untouched — only the nitro target re-points.
//
// ## Fail-closed
//
// The whole point of overlaying a published dist is that it MUST rot loudly. If
// the anchor is not found EXACTLY once (a vinext version bump moved or minified
// it), this errors non-zero rather than silently no-op'ing — a stale overlay
// reds the lane instead of quietly reverting to the #3197 bug.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

// The exact line vinext emits for the `ssr` build environment's entry input.
// Unique in the beta.8 dist: it is the only `input: { index: … }` whose value is
// VIRTUAL_SERVER_ENTRY (the RSC/app/client environments use other constants).
export const ANCHOR = 'input: { index: VIRTUAL_SERVER_ENTRY },';

// The nitro-gated re-point. Reuses two constants vinext already defines in the
// same module (VIRTUAL_WORKER_ENTRY, VIRTUAL_SERVER_ENTRY) and the flag it
// already computes (hasNitroPlugin), so it needs no new imports.
export const REPLACEMENT =
  'input: { index: hasNitroPlugin ? VIRTUAL_WORKER_ENTRY : VIRTUAL_SERVER_ENTRY },';

// Constants the replacement leans on. Their absence means the dist changed shape
// enough that the one-line re-point is no longer valid — fail rather than guess.
const REQUIRED_SYMBOLS = [
  'const VIRTUAL_WORKER_ENTRY = "virtual:vinext-worker-entry";',
  'let hasNitroPlugin = false;',
];

/**
 * Pure transform. Given vinext's `dist/index.js` source text, return the patched
 * text. Idempotent: a source already carrying REPLACEMENT is returned unchanged.
 *
 * Fail-closed: throws unless the anchor is present EXACTLY once (or the file is
 * already patched), and unless every symbol the replacement depends on exists.
 *
 * @param {string} source
 * @returns {{ text: string, already: boolean }}
 */
export function applyVinext3197Patch(source) {
  if (source.includes(REPLACEMENT)) {
    return { text: source, already: true };
  }

  const occurrences = source.split(ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `vinext#3197 overlay: expected the anchor ${JSON.stringify(ANCHOR)} exactly once, ` +
        `found ${occurrences}. The installed vinext dist has moved the SSR-environment input — ` +
        'this overlay is stale and must be re-derived against the new vinext version before the ' +
        'vinext lane can build with #3197 fixed. Refusing to no-op (fail-closed).',
    );
  }

  const missing = REQUIRED_SYMBOLS.filter((sym) => !source.includes(sym));
  if (missing.length > 0) {
    throw new Error(
      `vinext#3197 overlay: the replacement depends on symbols the installed dist no longer ` +
        `defines: ${missing.join(', ')}. Refusing to apply a re-point that would not compile ` +
        '(fail-closed).',
    );
  }

  const text = source.replace(ANCHOR, REPLACEMENT);
  if (!text.includes(REPLACEMENT)) {
    // Defensive: replace() cannot silently no-op here (we counted the anchor),
    // but assert the post-condition rather than trust it.
    throw new Error('vinext#3197 overlay: replacement did not take effect (fail-closed).');
  }
  return { text, already: false };
}

/**
 * Resolve vinext's installed `dist/index.js` from a fixture/app root.
 *
 * `require.resolve('vinext')` does NOT work: vinext's package `exports` declares
 * only an `import` condition (no `require`/`default`), so CJS resolution throws
 * `No "exports" main defined`. Walk `node_modules/vinext/package.json` up from
 * the app root instead, and resolve the module the plugin actually loads —
 * `exports['.'].import`, which is `./dist/index.js`.
 *
 * @param {string} appRoot
 * @returns {string}
 */
export function resolveVinextIndex(appRoot) {
  let dir = resolve(appRoot);
  for (;;) {
    const pkgPath = join(dir, 'node_modules', 'vinext', 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const dot = pkg.exports?.['.'];
      const rel =
        (typeof dot === 'string' ? dot : dot?.import) ??
        pkg.module ??
        pkg.main ??
        './dist/index.js';
      return join(dirname(pkgPath), rel);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`vinext is not installed under any node_modules above ${appRoot}`);
    }
    dir = parent;
  }
}

function main(argv) {
  const appRoot = argv[2] ? resolve(argv[2]) : process.cwd();
  let target;
  try {
    target = resolveVinextIndex(appRoot);
  } catch (err) {
    console.error(
      `[patch-vinext-3197] ERROR: cannot resolve vinext from ${appRoot}: ${err.message}`,
    );
    return 1;
  }

  let source;
  try {
    source = readFileSync(target, 'utf8');
  } catch (err) {
    console.error(`[patch-vinext-3197] ERROR: cannot read ${target}: ${err.message}`);
    return 1;
  }

  let result;
  try {
    result = applyVinext3197Patch(source);
  } catch (err) {
    console.error(`[patch-vinext-3197] ERROR: ${err.message}`);
    return 1;
  }

  if (result.already) {
    console.error(`[patch-vinext-3197] already applied to ${target} — nothing to do`);
    return 0;
  }

  writeFileSync(target, result.text);
  console.error(
    `[patch-vinext-3197] applied cloudflare/vinext#3197 overlay to ${target} ` +
      '(SSR env input → worker entry under nitro). TEMPORARY; remove when upstream ships the fix.',
  );
  return 0;
}

// ESM "run as script" guard.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
