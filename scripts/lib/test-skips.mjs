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
 * Capture the balanced `{...}` block that opens at `index` (which must point at
 * the `{`). Returns the inner text (without the braces).
 */
function balancedBlock(code, index) {
  let depth = 0;
  for (let i = index; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
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
 *
 * The RHS runs to the first `;` at brace/paren depth ZERO, not the first `;`
 * anywhere — so a variable assigned an arrow or function EXPRESSION with a block
 * body (`const f = () => { …; existsSync(…); … }`) keeps its whole body rather
 * than being truncated at the first inner statement, which would hide a probe.
 */
function assignments(code) {
  const map = new Map();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
  for (const m of code.matchAll(re)) {
    const rhsStart = (m.index ?? 0) + m[0].length;
    let depth = 0;
    let end = code.length;
    for (let i = rhsStart; i < code.length; i++) {
      const ch = code[i];
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
      else if (ch === ';' && depth <= 0) {
        end = i;
        break;
      }
    }
    map.set(m[1], code.slice(rhsStart, end));
  }
  return map;
}

/**
 * Map every locally-declared `function <name>(…) { … }` to its BODY text, so a
 * skip predicate that traces to a CALL of a local helper can be resolved one hop
 * further — into that helper's body — for the artifact probe. This is the repo's
 * own idiom: `const root = findBuild(); it.skipIf(root === null)(…)` where
 * `findBuild()`'s body does the `existsSync`. (Arrow/function EXPRESSIONS bound to
 * a name are handled by `assignments` above, which keeps their whole block body.)
 */
function functionBodies(code) {
  const map = new Map();
  const re = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (const m of code.matchAll(re)) {
    const parenOpen = (m.index ?? 0) + m[0].length - 1;
    // Skip past the parameter list to its matching ')'.
    let depth = 0;
    let close = -1;
    for (let i = parenOpen; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;
    const braceOpen = code.indexOf('{', close);
    if (braceOpen === -1) continue;
    map.set(m[1], balancedBlock(code, braceOpen));
  }
  return map;
}

/**
 * Does this identifier trace (within `depth` hops) to an artifact-existence
 * probe? Resolution is either through a variable assignment (`assigns`) or ONE
 * hop into a locally-defined function's body (`funcs`) — a predicate that names
 * a variable whose value is a call to a helper that itself probes the filesystem
 * is artifact-gated, and the helper body is inspected for the probe DIRECTLY (not
 * recursively), keeping the function trace to a single hop.
 */
function identIsArtifactDerived(id, assigns, funcs, depth, seen) {
  if (seen.has(id)) return false;
  seen.add(id);
  // One function hop: `id` names a local helper whose body probes the filesystem.
  const body = funcs.get(id);
  if (body !== undefined && ARTIFACT_PROBE.test(body)) return true;
  const rhs = assigns.get(id);
  if (rhs === undefined) return false;
  if (ARTIFACT_PROBE.test(rhs)) return true;
  if (depth <= 0) return false;
  for (const ref of rhs.match(IDENT) ?? []) {
    if (ref !== id && identIsArtifactDerived(ref, assigns, funcs, depth - 1, seen)) return true;
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
 * Predicate-aware, resolving named variables back to what they were computed
 * from, so `it.skipIf(skipReason !== null)` where `const skipReason = existsSync(...) ?`
 * is caught while `it.skipIf(!bun)` is not. A predicate that probes the
 * filesystem inline counts directly.
 *
 * The trace also follows ONE function hop: when a traced variable resolves to a
 * call of a locally-defined helper (`const root = findBuild()`), that helper's
 * BODY is inspected for the same probe — the repo's own artifact-gating idiom,
 * used by both sigterm e2e specs, which the variable-only tracer was blind to.
 *
 * SCOPE, stated rather than claimed complete: the function trace is a single hop
 * into a LOCAL `function`/arrow-expression body. A probe reached only through a
 * second helper the first one calls, an imported helper, or a method on an object
 * is NOT resolved — those remain a known blind spot, and the #932 guard's
 * guarantee ("a new artifact-gated skip without a lane reds") holds for the
 * inline, single-variable, and single-function-hop forms, not beyond them.
 *
 * @param {string} source
 * @returns {number}
 */
export function artifactGatedSkipCount(source) {
  const code = blankNonCode(source);
  const assigns = assignments(code);
  const funcs = functionBodies(code);
  let count = 0;
  for (const form of CONDITIONAL_FORMS) {
    const re = new RegExp(`(?<![.\\w$])${form.replace('.', '\\.')}\\s*\\(`, 'g');
    for (const m of code.matchAll(re)) {
      const openParen = (m.index ?? 0) + m[0].length - 1;
      const predicate = balancedArg(code, openParen);
      let gated = ARTIFACT_PROBE.test(predicate);
      if (!gated) {
        for (const id of predicate.match(IDENT) ?? []) {
          if (identIsArtifactDerived(id, assigns, funcs, 3, new Set())) {
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
