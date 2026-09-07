# Incident postmortem — 2026-09-08 npm release failures (workspace: leak + partial publish)

**Status:** resolved (mitigated by dist-tag rollback; recurrence prevented by the guard shipped in this PR).
**Severity:** SEV — `@getknext/core@latest` was uninstallable for all consumers.
**Packages:** the `@getknext/*` changesets `fixed` group — `@getknext/core`, `@getknext/lib`,
`@getknext/db`, and the `kn-next` alias. They must ship **together, at the same version, with resolvable
sibling ranges**, or `npm install` breaks.

## What happened (two distinct failures, same fragile lane)

### Incident #1 — partial publish (earlier)
`@getknext/core@0.3.1` and `@getknext/db@0.3.1` published, but `@getknext/lib` was **not** advanced to
`0.3.1` (stayed `0.2.0`). Since `core@0.3.1` declares `@getknext/lib@^0.3.1` (and `db@0.3.1` the same),
`npm install @getknext/core@0.3.1` failed until `lib@0.3.1` was later published. A member of a
ship-together group was published without its siblings.

### Incident #2 — `workspace:` protocol leak (the SEV)
`@getknext/core@0.4.0` and `@getknext/db@0.4.0` published with their sibling deps **unrewritten** —
`"@getknext/lib": "workspace:^"` instead of `"^0.4.0"`. npm/yarn do not understand the `workspace:`
protocol, so `npm install @getknext/core@0.4.0` failed hard:
`npm error code EUNSUPPORTEDPROTOCOL — Unsupported URL Type "workspace:"`. Because 0.4.0 was `@latest`,
`npm install @getknext/core` (no version) broke for **everyone**.

## Root causes

1. **`changeset publish` shells to `npm publish` in a bun workspace, and `npm publish` does not rewrite
   the `workspace:` protocol.** `@changesets/cli`'s `getPublishTool` only recognizes npm/pnpm/yarn; for
   a **bun** workspace (`bun ∉ {npm,pnpm,yarn}`) it falls back to running `npm publish` in each package
   subdir. `npm pack`/`npm publish` on a bun-installed workspace (which has no npm workspace metadata)
   ships `workspace:` **verbatim**. Only pnpm/bun/yarn rewrite it. → Incident #2.
   *Proof:* `bun pm pack packages/db` → `"@getknext/lib": "^0.4.0"`; `npm pack packages/db` →
   `"@getknext/lib": "workspace:^"`.

2. **The pre-publish audit packed with the WRONG tool, so it never saw the leak.**
   `scripts/audit-published.mjs` verifies sibling ranges by packing with **`bun pm pack`** — which
   rewrites `workspace:` — so the audit's tarball differed from what the real publish (`npm publish`)
   shipped. The audit was green while the published artifact was broken. A guard must pack with the
   **same tool the publish uses**.

3. **`changeset publish` is non-atomic and does not verify sibling resolvability.** It publishes each
   package independently (only if `name@version` isn't already on the registry) and never checks that a
   member's `^`-dependency on a sibling actually resolves on npm. A member's publish failing (or its
   version not being bumped) leaves the registry in a broken partial state with no error. → Incident #1.

4. **The manual publish-approval gate was removed (auto-publish) with no automated backstop.** The
   `npm-publish` environment's required-reviewers rule was turned off to make releases hands-off. That
   removed the last human who might have noticed a broken publish — without any mechanical check taking
   its place. (Auto-publish is a fine policy; it just requires the guards below.)

## Resolution

- **Immediate:** rolled `@latest` back to the known-good `0.3.1` for all three
  (`npm dist-tag add @getknext/{core,lib,db}@0.3.1 latest`); deprecated the broken 0.4.0. Installs
  restored.
- **Durable (this PR):**
  - `scripts/rewrite-workspace-ranges.mjs` rewrites publishable manifests' `workspace:` ranges to
    concrete `^<version>` **between build and publish** (runner-only; repo keeps `workspace:` as source
    of truth), so whatever tool `changeset publish` shells to ships resolvable ranges.
  - `scripts/verify-published-group.mjs`:
    - `--pre` (before the credentialed publish) packs each package with **`npm pack`** — the tool the
      publish actually uses — and reds the run if **any** tarball dep still carries `workspace:`, or the
      fixed group is version-incoherent. Fails **before** `NPM_TOKEN` is exercised.
    - `--post` (after publish) resolves every fixed-group member on the live registry at the target
      version — catching a partial publish — and fails closed on an unreachable registry.

## Prevention checklist (do not repeat)

- **Never assume the publish tool rewrites `workspace:`.** Any pre-publish tarball check MUST pack with
  the **same tool** the publish uses (`npm pack` here), never `bun pm pack`, which hides the leak.
- **A `fixed`/ship-together group must be verified coherent AND resolvable pre- and post-publish** — one
  version across members, every sibling `^`-dep satisfiable by a published sibling.
- **Auto-publish requires a fail-closed backstop.** Removing the human gate is only safe with the pre/post
  guards above wired into the release lane.
- **A green supply-chain audit is not proof the published artifact is good** unless the audit inspects the
  *actual* published tarball shape.

## Follow-ups (tracked, not blocking)
- Harden `verify-published-group.mjs` to reject a public package rewritten to point at a private/unpublished
  sibling (latent; not reachable today — no public package depends on `@getknext/ui`).
- `--post` `npm view` can transiently 404 a just-published member (registry read-after-write is eventually
  consistent) → fails safe (reds, never ships broken), but may need a short retry to avoid flakes.
