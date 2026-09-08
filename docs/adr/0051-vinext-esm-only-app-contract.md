# ADR-0051: the vinext build target supports ESM Next.js apps only

- **Status:** **Proposed (awaiting founder + architect endorsement).** Scoping what the product
  supports is a founder call — like ADR-0001 — so this ADR records the decision and its evidence
  but does **not** mark itself Accepted. It takes effect only once endorsed.
- **Date:** 2026-09-08
- **Amends / relates:** **ADR-0048** (vinext + Bun single executable as the only target) and
  **ADR-0042** (vinext + Bun bytecode as the default runtime). ADR-0042 already listed an "ESM
  migration burden" as a *consequence*; this ADR promotes it from an incidental cost to an explicit
  **support boundary**, which ADR-0042 never did.

## Context

ADR-0048 made the compiled `vinext` + Bun single executable the **only** supported build/runtime
target — `turbopack` and `node` are retired as user-selectable options. That decision has a
consequence its own text did not fully draw out: vinext builds through `vite build`
(vinext → nitro bun preset), and vite's rsc↔ssr module graph requires the app be **ESM**
(`"type":"module"` in `package.json`). Without it, a real App-Router build fails — vite aborts with
an `UNRESOLVED_IMPORT` on the rsc↔ssr boundary (verified by cross-flip on the real compat corpus).

The pieces are already aligned with an ESM-only assumption, just not stated as a boundary:

- the **scaffolder** writes `"type":"module"` into every app it generates
  (`templates/app/package.json.hbs`), so a `kn-next create` app is ESM from birth;
- the production build path (`packages/kn-next/src/adapters/vinext-build.ts`) assumes ESM;
- the **node** target *does* build CommonJS apps green (778/0 on the official suite), but node is
  no longer user-selectable per ADR-0048 — so that green does not rescue a CommonJS app on the
  shipped target.

The gap surfaced concretely on the vinext compat lane (`scripts/e2e-deploy-vinext.sh`): the official
corpus fixtures are CommonJS, and the lane must normalize each fixture to `"type":"module"` before
`vite build` to produce an honest number for ESM apps. That normalization needs a recorded support
boundary behind it, or the compat claim is unscoped.

## Decision (Proposed)

**The vinext target officially supports ESM Next.js apps only** — `"type":"module"` in the app's
`package.json`. Existing CommonJS apps must migrate: add `"type":"module"`, and use
`next.config.mjs` or `next.config.cjs` (a bare `next.config.js` becomes ESM under `type:module`).
The official-compatibility claim for the **vinext axis** is scoped accordingly: it is a claim about
ESM apps, and a CommonJS app on the vinext target is out of scope for that number.

## Options considered

| # | Option | Pros | Cons | Verdict |
|---|--------|------|------|---------|
| A | **ESM-only contract now; document it and track the CommonJS gap.** | Matches what the scaffolder + build already do; recovers the compat measurement honestly today; small, bounded migration for users. | Imposes a migration step on existing CommonJS apps. | **Recommended.** |
| B | Block shipping the vinext target until it also builds CommonJS apps. | No user migration burden. | Making `vite build` accept CommonJS App-Router apps is a nitro/rolldown campaign, likely partly upstream — it blocks the shipped target indefinitely on work knext may not own. | Rejected — disproportionate, possibly not knext's to fix. |
| C | Silently normalize CommonJS fixtures/apps to ESM under the hood without stating a boundary. | Zero visible burden. | Masks the gap; produces a compat number that does not describe what an unmodified CommonJS app would do; exactly the "softening" the lane's red-on-fail contract forbids. | Rejected — dishonest. |

## Consequences

- The vinext-axis compat measurement is recovered **honestly**: the lane normalizes fixtures to the
  ESM contract (one bounded key merge, guarded), and the published number is truthfully a claim
  about ESM apps.
- A **migration burden** lands on users with existing CommonJS apps — add `"type":"module"` and move
  `next.config` to `.mjs`/`.cjs`. This is documented for users (no issue/ADR numbers in that copy).
- The **node-vs-vinext CommonJS capability gap is real**: node builds CommonJS apps green but is not
  user-selectable; vinext is user-selectable but ESM-only. The gap is tracked, not hidden.
- The vinext row in `docs/compat-matrix.md` is scoped to ESM apps and points at the tracked gap.

## Action items

- The **CommonJS-on-vinext gap is tracked as issue #1033** — the single reference the compat matrix
  and lane point to.
- **Founder to endorse** the ESM-only contract (this ADR moves to Accepted only then); architect
  endorsement is the paired gate that requested this ADR be written.
- This ADR **amends/relates ADR-0048 and ADR-0042** — ADR-0042 recorded the ESM migration only as a
  consequence; this ADR states it as a support boundary. Update the cross-references in both when
  this is Accepted.
