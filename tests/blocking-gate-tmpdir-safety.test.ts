/**
 * The blocking-gate specs must not leak a `blocking-gate-*` dir into the repo
 * root when the suite is spawned with a relative `$TMPDIR` (#880).
 *
 * Root cause (reproduced on node AND bun): `os.tmpdir()` returns `$TMPDIR`
 * verbatim, so `TMPDIR=.` makes `mkdtempSync(join(tmpdir(), 'blocking-gate-'))`
 * create a RELATIVE dir at the process CWD — the repo root. The prefix was
 * never the bug; the BASE went relative. `tests/helpers/abs-tmp.ts` closes it
 * by validating the base and throwing loudly instead of leaking.
 *
 * Three checks, each attacking a different way the fix could regress:
 *  1. UNIT — `absTmpdir(<hostile>)` throws; `absTmpdir(<absolute-outside>)`
 *     returns. Mutation vector: delete the throw → this reds.
 *  2. EXECUTION — a child spawned with `TMPDIR=.` at the repo root, going
 *     through the helper exactly as the writers do, THROWS and creates no
 *     repo-root `blocking-gate-*`. Mutation vector: helper stops throwing → the
 *     child leaks → this reds.
 *  3. ROUTING — both #880 writers root their mkdtemp at `absTmpdir()`, never a
 *     raw `tmpdir()`. Mutation vector: a writer reverts to `tmpdir()` → this
 *     reds. This is the "revert a writer to raw tmpdir()" proof the diagnosis
 *     asks for, made deterministic.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';
import { absTmpdir } from './helpers/abs-tmp';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const HELPER = resolve(REPO_ROOT, 'tests/helpers/abs-tmp.ts');

/** The two #880 writers this fix must route. */
const WRITERS = ['tests/blocking-gate-helper.test.ts', 'tests/blocking-gate-triage.test.ts'];

/** Remove any `blocking-gate-*` that leaked into the repo root during a check. */
function sweepRepoRoot(): string[] {
  const leaked = readdirSync(REPO_ROOT).filter((e) => e.startsWith('blocking-gate-'));
  for (const e of leaked) rmSync(resolve(REPO_ROOT, e), { recursive: true, force: true });
  return leaked;
}

afterEach(() => {
  // Belt and braces: never let a red run of THIS file leave residue behind.
  sweepRepoRoot();
});

describe('absTmpdir rejects a relative / in-repo temp base (#880)', () => {
  it('throws on a relative base — `.` and `./x`', () => {
    expect(() => absTmpdir('.')).toThrow(/relative/i);
    expect(() => absTmpdir('./scratch')).toThrow(/relative/i);
  });

  it('throws when the base is inside the repo', () => {
    expect(() => absTmpdir(REPO_ROOT)).toThrow(/inside the repo/i);
    expect(() => absTmpdir(resolve(REPO_ROOT, 'tests'))).toThrow(/inside the repo/i);
  });

  it('returns an absolute base that sits outside the repo', () => {
    expect(absTmpdir('/tmp')).toBe('/tmp');
    expect(absTmpdir('/var/folders/xy/T')).toBe('/var/folders/xy/T');
  });

  it('names the offending value in the error, so the runner is diagnosable', () => {
    expect(() => absTmpdir('./bad-base')).toThrow(/bad-base/);
  });
});

describe('the writers do not leak into the repo root under a relative TMPDIR (#880)', () => {
  it('a child going through absTmpdir throws instead of creating a repo-root blocking-gate-*', () => {
    // Runs in the SAME runtime as the suite (`process.execPath`). Inline `-e`,
    // so no scratch file is written; the helper is imported by absolute path so
    // the child exercises the REAL fix, not a copy. TMPDIR=. + cwd=repo root is
    // the exact reproduction from the diagnosis.
    const code = `
      const { absTmpdir } = await import(${JSON.stringify(HELPER)});
      const { mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      try {
        const d = mkdtempSync(join(absTmpdir(), 'blocking-gate-'));
        console.log('LEAKED:' + d);
      } catch {
        console.log('THREW');
      }
    `;
    let out = '';
    try {
      out = execFileSync(process.execPath, ['-e', code], {
        cwd: REPO_ROOT,
        env: { ...process.env, TMPDIR: '.' },
        encoding: 'utf8',
      });
    } finally {
      // If the fix regressed, the child leaked a relative dir at the repo root.
      const leaked = sweepRepoRoot();
      expect(
        leaked,
        'a blocking-gate-* dir leaked into the repo root — the helper did not throw',
      ).toEqual([]);
    }
    expect(out).toContain('THREW');
    expect(out).not.toContain('LEAKED');
  });
});

describe('both #880 writers root their scratch at absTmpdir(), not raw tmpdir() (#880)', () => {
  it('every writer file exists — repoint this check if one moves', () => {
    for (const f of WRITERS) {
      expect(existsSync(resolve(REPO_ROOT, f)), `${f} moved — repoint this check`).toBe(true);
    }
  });

  it('no writer passes a raw tmpdir() to mkdtemp', () => {
    // Blanked source, so a `tmpdir` mentioned in a comment or string cannot
    // launder a real call. A regressed writer that reverts to
    // `mkdtempSync(join(tmpdir(), …))` reds here.
    const offenders: string[] = [];
    for (const f of WRITERS) {
      const code = blankNonCode(readFileSync(resolve(REPO_ROOT, f), 'utf8'));
      for (const m of code.matchAll(/\bmkdtemp(?:Sync)?\s*\(/g)) {
        const arg = code.slice(m.index + m[0].length, m.index + m[0].length + 140).split(';')[0];
        if (/\btmpdir\s*\(/.test(arg)) offenders.push(`${f}: mkdtemp(${arg.trim().slice(0, 60)}`);
      }
    }
    expect(
      offenders,
      'a writer passing raw tmpdir() leaks a repo-root blocking-gate-* under a relative $TMPDIR ' +
        '(#880). Route it through absTmpdir() from tests/helpers/abs-tmp.ts.',
    ).toEqual([]);
  });

  it('every writer imports absTmpdir', () => {
    for (const f of WRITERS) {
      const src = readFileSync(resolve(REPO_ROOT, f), 'utf8');
      expect(src, `${f} must import absTmpdir`).toContain('absTmpdir');
    }
  });
});
