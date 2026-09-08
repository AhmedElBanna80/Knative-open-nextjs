import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #922 — derive the CRD's reserved env-var names from the operator source of
 * truth instead of hand-copying them into a test literal.
 *
 * The authority is the CEL `XValidation` rule on `spec.env` in
 * `packages/kn-next-operator/api/v1alpha1/nextapp_types.go`: a conjunction of
 * `!('NAME' in self)` clauses that the apiserver rejects at admission. If the
 * operator gains a new injected variable and adds it there, a hand-copied list
 * silently goes stale and any guard built on it goes GREEN exactly when it is
 * wrong. Reading the names straight out of the Go source removes the drift.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

// HERE = packages/kn-next/src/__tests__/helpers → repo root is five up.
export const NEXTAPP_TYPES_GO = join(
    HERE,
    "..",
    "..",
    "..",
    "..",
    "..",
    "packages",
    "kn-next-operator",
    "api",
    "v1alpha1",
    "nextapp_types.go",
);

/**
 * Extract the reserved env-var names from Go source carrying the spec.env
 * XValidation rule. The reserved rule is the only one shaped as a conjunction
 * of `!('NAME' in self)` clauses (the sibling C_IDENTIFIER rule uses
 * `self.all(k, k.matches(...))` and matches nothing here), so scanning for that
 * clause shape isolates it without pinning to a line number.
 */
export function extractReservedEnvNames(goSource: string): string[] {
    const clauseRe = /!\(\s*'([A-Za-z_][A-Za-z0-9_]*)'\s+in\s+self\s*\)/g;
    const names = new Set<string>();
    for (const m of goSource.matchAll(clauseRe)) names.add(m[1]);
    return [...names];
}

/** Read the real operator source and derive the reserved names from it. */
export function reservedEnvNamesFromSource(): string[] {
    return extractReservedEnvNames(readFileSync(NEXTAPP_TYPES_GO, "utf-8"));
}
