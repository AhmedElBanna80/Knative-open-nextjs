/**
 * A guaranteed-absolute, outside-the-repo temp base for `mkdtemp*` (#880).
 *
 * ## Why this exists
 *
 * `os.tmpdir()` returns `$TMPDIR` verbatim when it is set. A runner that spawns
 * the suite with a RELATIVE `$TMPDIR` (`.` or `./x` — measured on both node and
 * bun) makes `os.tmpdir()` return that relative value, so
 * `mkdtempSync(join(tmpdir(), 'blocking-gate-'))` lands at the process CWD —
 * the repo root — and silently leaks a `blocking-gate-*` directory into the
 * checkout. That is the Aug 17–21 leak: the prefix was fine, the BASE went
 * relative under a hostile/stripped environment.
 *
 * `tests/temp-dirs-outside-the-repo.test.ts` scans for a mkdtemp prefix that is
 * not rooted at the temp directory, but it cannot see this: the call IS rooted
 * at `tmpdir()` — `tmpdir()` is simply lying about being absolute at runtime.
 * Only executing under the hostile env exposes it.
 *
 * ## What this does
 *
 * `absTmpdir()` returns `os.tmpdir()` when it is absolute AND outside the repo,
 * and otherwise THROWS a clear error naming the bad value. Failing loudly turns
 * the silent leak into a red run — a misconfigured runner is surfaced, never
 * papered over. A silent fallback to `/tmp` would hide the broken runner, so it
 * is deliberately not done.
 */

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repo root, found by walking up from this file for a `.git` entry (a
 * directory in a normal checkout, a FILE in a git worktree — `existsSync` sees
 * both). Falls back to two levels up (`tests/helpers/..` → repo root) if no
 * `.git` is found, which keeps the helper working from an exported tarball.
 */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  while (true) {
    if (existsSync(resolve(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(here, '..', '..');
}

/**
 * A temp base that is provably absolute and outside the repo. THROWS rather
 * than leaking when `$TMPDIR` (hence `os.tmpdir()`) is relative or points into
 * the checkout. `base` is injectable so the guard can be unit-tested against a
 * hostile value without mutating the process environment.
 */
export function absTmpdir(base: string = tmpdir()): string {
  const root = repoRoot();
  if (!isAbsolute(base)) {
    throw new Error(
      `refusing to create scratch dirs: TMPDIR is relative (\`${base}\`) — ` +
        `os.tmpdir() must be an absolute path outside the repo (${root}). ` +
        'A relative base resolves against the process CWD and leaks fixture dirs into the checkout (#880).',
    );
  }
  const resolved = resolve(base);
  if (resolved === root || resolved.startsWith(root + sep)) {
    throw new Error(
      `refusing to create scratch dirs: TMPDIR is inside the repo (\`${base}\`) — ` +
        `scratch dirs must live outside ${root} (#880).`,
    );
  }
  return base;
}
