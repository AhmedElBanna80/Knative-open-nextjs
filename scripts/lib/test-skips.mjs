/**
 * Every skip construct in a spec file, found by scanning (#927).
 *
 * WHY THIS EXISTS. Sprint 2's "no self-skipping guard survives" sweep was
 * reported as clean on the strength of an ad-hoc one-liner, and review showed
 * the report was wrong in two independent ways: the glob missed `apps/**` and
 * `examples/**` entirely, and the pattern list omitted `.skipIf` — which is the
 * form almost every real skip in this repo uses. Actual answer: ELEVEN files,
 * not one.
 *
 * A sweep whose result depends on remembering to include a directory and a
 * spelling is not a sweep. So the question is asked by a committed scan that
 * fails when the answer changes, and the answer itself is DECLARED in the tree
 * (`tests/declared-test-skips.test.ts`) so a new skip has to be argued for
 * rather than merely added.
 *
 * WHAT A SKIP COSTS, and why declaring is not bureaucracy: a `skipIf` predicate
 * that is false in CI reports the same green as a passing test. The repo has
 * `it.skipIf(!existsSync(artifact))` sites that simply vanish when the artifact
 * was not built — the exact "control that reports success while inert" class
 * sprint 1 named as the project's most common defect.
 */

import { blankNonCode } from './blank-non-code.mjs';

/**
 * The constructs that remove a test from the run.
 *
 * `.skipIf` is listed FIRST because leaving it out is what made the original
 * sweep wrong, and `.todo` counts because a todo is a test that does not run
 * while reading like one that does.
 */
export const SKIP_FORMS = Object.freeze([
  'describe.skipIf',
  'it.skipIf',
  'test.skipIf',
  'describe.skip',
  'it.skip',
  'test.skip',
  'describe.todo',
  'it.todo',
  'test.todo',
]);

/** Forms that vanish silently when their predicate is false at runtime. */
export const CONDITIONAL_FORMS = Object.freeze(SKIP_FORMS.filter((f) => f.endsWith('.skipIf')));

/**
 * Count each skip form in one spec's source.
 *
 * Counted on the BLANKED view so a comment discussing `it.skip` — several do,
 * including this module's own consumers — is not a finding, while a call is.
 * The longest form is matched first so `it.skipIf` is never counted as `it.skip`.
 *
 * @param {string} source
 * @returns {Record<string, number>} form -> count, omitting zeros
 */
export function scanSkips(source) {
  let code = blankNonCode(source);
  const counts = {};
  for (const form of [...SKIP_FORMS].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![.\\w$])${form.replace('.', '\\.')}\\s*\\(`, 'g');
    const n = (code.match(re) ?? []).length;
    if (n > 0) {
      counts[form] = n;
      // Consume the matches so a shorter form cannot re-count them.
      code = code.replace(re, ' '.repeat(form.length + 1));
    }
  }
  return counts;
}

/** Total skips in a source, across all forms. */
export function skipCount(source) {
  return Object.values(scanSkips(source)).reduce((a, b) => a + b, 0);
}

/** The filesystem-existence probes that make a skip vanish when a BUILD ARTIFACT is absent. */
const ARTIFACT_PROBE = /\b(existsSync|statSync|lstatSync)\s*\(/;

/** Identifier characters, for extracting the names a predicate references. */
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Capture the balanced `(...)` argument that immediately follows `index`.
 * `index` must point at the `(`. Returns the inner text (without the parens).
 */
function balancedArg(code, index) {
  let depth = 0;
  for (let i = index; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return code.slice(index + 1, i);
    }
  }
  return code.slice(index + 1);
}

/**
 * Map every `const|let|var <id> = <rhs>;` in the (blanked) source to its RHS
 * text, so a skip predicate that names a variable can be traced to what that
 * variable was computed from.
 */
function assignments(code) {
  const map = new Map();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
  for (const m of code.matchAll(re)) {
    const rhsStart = (m.index ?? 0) + m[0].length;
    const semi = code.indexOf(';', rhsStart);
    const rhs = code.slice(rhsStart, semi === -1 ? code.length : semi);
    map.set(m[1], rhs);
  }
  return map;
}

/** Does this identifier trace (within `depth` hops) to an artifact-existence probe? */
function identIsArtifactDerived(id, assigns, depth, seen) {
  if (seen.has(id)) return false;
  seen.add(id);
  const rhs = assigns.get(id);
  if (rhs === undefined) return false;
  if (ARTIFACT_PROBE.test(rhs)) return true;
  if (depth <= 0) return false;
  for (const ref of rhs.match(IDENT) ?? []) {
    if (ref !== id && identIsArtifactDerived(ref, assigns, depth - 1, seen)) return true;
  }
  return false;
}

/**
 * Count the conditional (`*.skipIf`) skips whose predicate depends on the
 * existence of a BUILD ARTIFACT — the skips that report the same green as a
 * passing test wherever the artifact was not built (#932). Env/availability
 * gates (`!bun`, a docker probe, an env var) are deliberately NOT counted: they
 * are a different class with their own lanes, and conflating them would demand a
 * build lane for a skip that gates on a runtime instead.
 *
 * Predicate-aware, tracing named variables one hop back to their assignment, so
 * `it.skipIf(skipReason !== null)` where `const skipReason = existsSync(...) ?`
 * is caught while `it.skipIf(!bun)` is not. A predicate that probes the
 * filesystem inline counts directly.
 *
 * @param {string} source
 * @returns {number}
 */
export function artifactGatedSkipCount(source) {
  const code = blankNonCode(source);
  const assigns = assignments(code);
  let count = 0;
  for (const form of CONDITIONAL_FORMS) {
    const re = new RegExp(`(?<![.\\w$])${form.replace('.', '\\.')}\\s*\\(`, 'g');
    for (const m of code.matchAll(re)) {
      const openParen = (m.index ?? 0) + m[0].length - 1;
      const predicate = balancedArg(code, openParen);
      let gated = ARTIFACT_PROBE.test(predicate);
      if (!gated) {
        for (const id of predicate.match(IDENT) ?? []) {
          if (identIsArtifactDerived(id, assigns, 3, new Set())) {
            gated = true;
            break;
          }
        }
      }
      if (gated) count++;
    }
  }
  return count;
}
