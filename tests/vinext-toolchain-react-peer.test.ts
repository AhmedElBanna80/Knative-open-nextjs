/**
 * The vinext-axis compat lane's toolchain install must satisfy vinext's react peer.
 *
 * ## The defect this guards (compat run 34030824905: 310 passed / 468 failed)
 *
 * Every one of the 468 failures was the identical `npm ERESOLVE`:
 *
 *   peer react@"^19.2.6" from vinext@1.0.0-beta.8
 *   Found: react@19.2.4
 *
 * `scripts/e2e-deploy-vinext.sh`'s toolchain install pinned
 * `react-server-dom-webpack@19.2.6` (vinext's RSC transform peer) but did NOT pin
 * `react`/`react-dom`. Each corpus fixture pulls `react@19.2.4` transitively via
 * `next@16.2`, which does not satisfy vinext-beta.8's `react@^19.2.6` peer, so
 * `npm install` aborts before the fixture ever builds — and the harness reports
 * "Custom deploy script failed" for every single case. The lane's number is then
 * a measurement of a broken install step, not of the vinext axis.
 *
 * ## Why a pin, not `--legacy-peer-deps`
 *
 * `--legacy-peer-deps` would make npm accept the mismatch, but it leaves a REAL
 * version skew between vinext's RSC transform (compiled against 19.2.6) and the
 * app's `react`/`react-dom` (19.2.4) — a latent correctness hazard the lane is
 * meant to surface honestly, not paper over. Pinning the whole React family at
 * the version vinext's runtime expects makes the toolchain coherent.
 *
 * ## What this guard asserts (scan, not a brittle line match)
 *
 * The single `npm install` that pulls the vinext toolchain must pin BOTH `react`
 * and `react-dom`, at the SAME version it pins `react-server-dom-webpack` — the
 * React family stays coherent. Removing either pin reds this test.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SCRIPT = 'scripts/e2e-deploy-vinext.sh';

/** Script body with full-line comments removed — a prose mention in the header
 *  must not satisfy an assertion about the executable install command. */
function code(): string {
  return readFileSync(resolve(repoRoot, DEPLOY_SCRIPT), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * The single `npm install` invocation that pulls the vinext toolchain, as one
 * logical line (backslash-newline continuations folded). Selected by the vinext
 * package it installs, so an unrelated `npm install` elsewhere cannot match.
 */
function toolchainInstall(): string {
  const folded = code().replace(/\\\n/g, ' ');
  const lines = folded
    .split('\n')
    .filter((l) => /\bnpm\s+i(nstall)?\b/.test(l) && /vinext@/.test(l));
  if (lines.length !== 1) {
    throw new Error(`expected exactly one vinext toolchain npm install, found ${lines.length}`);
  }
  return lines[0] as string;
}

/** The version each package family member is pinned to in the install command. */
function pinnedVersion(install: string, pkg: string): string | undefined {
  // Matches `"react@19.2.6"`, `react@19.2.6`, `"${VAR}"` etc. — capture the
  // right-hand side of the FIRST `<pkg>@` token. Anchored on a word boundary so
  // `react@` does not match inside `react-dom@` or `react-server-dom-webpack@`.
  const re = new RegExp(`(?:^|[\\s"'])${pkg.replace(/[-/]/g, '\\$&')}@([^\\s"']+)`);
  const m = install.match(re);
  return m?.[1];
}

describe('the vinext toolchain install satisfies vinext’s react peer', () => {
  it('pins react in the same install step as react-server-dom-webpack', () => {
    const install = toolchainInstall();
    expect(pinnedVersion(install, 'react-server-dom-webpack')).toBeDefined();
    const react = pinnedVersion(install, 'react');
    expect(
      react,
      'react is unpinned — the corpus fixture pulls react@19.2.4 via next@16.2, ' +
        'which does not satisfy vinext-beta.8’s react@^19.2.6 peer, so npm ERESOLVE ' +
        'aborts every fixture install before it can build',
    ).toBeDefined();
  });

  it('pins react-dom in the same install step', () => {
    const reactDom = pinnedVersion(toolchainInstall(), 'react-dom');
    expect(
      reactDom,
      'react-dom is unpinned — the same ERESOLVE that kills the react peer kills react-dom',
    ).toBeDefined();
  });

  it('pins the whole React family coherently at one version', () => {
    // A pin that leaves react and react-dom on DIFFERENT versions, or off the
    // version the RSC transform was built against, reintroduces the skew a plain
    // --legacy-peer-deps would. Assert all three move together.
    const install = toolchainInstall();
    const rsd = pinnedVersion(install, 'react-server-dom-webpack');
    const react = pinnedVersion(install, 'react');
    const reactDom = pinnedVersion(install, 'react-dom');
    expect(react).toEqual(rsd);
    expect(reactDom).toEqual(rsd);
  });

  it('does not fall back to --legacy-peer-deps to mask the skew', () => {
    // --legacy-peer-deps would make the ERESOLVE go away while leaving the real
    // version skew in place — an honesty regression for a lane whose whole point
    // is an honest number. If a future change adopts it, this test says so loudly.
    expect(toolchainInstall()).not.toContain('--legacy-peer-deps');
  });
});
