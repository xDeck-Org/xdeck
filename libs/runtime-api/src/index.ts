export * from './capability';
export * from './device-capability';
// §9.94 B5.a (ADR-0019 D9) — provided-capability grammar (the provider half of the graph:
// `<namespace>:<name>@<semver>`, kernel-wins namespace enforcement).
export * from './provided-capability';
// §9.94 B5.b (ADR-0019 D9.2) — consumed-capability grammar (the consumer half:
// `<namespace>:<name>@<range>`, hard/soft deps resolved by the kernel registry).
export * from './consumed-capability';
// §9.52.18 — AI Skills: the plain-English GUIDANCE layer over the capability model
// (guidance-not-authority; pure resolver + types; Ai* = plane-agnostic, surfaced by Deckie).
export * from './ai-skill';
export * from './runtime';
export * from './errors';
export * from './manifest';
export * from './ports';
export * from './guard';
// §9.169 PR-10 — the reserved identity a deck's own integration class runs under (`core/deck-code`).
export * from './deck-code-identity';
export * from './method-mapping';
// §9.91.2 — field-level ABAC primitive (purpose-resolved minimum-necessary projection).
export * from './field-access';
// §9.91.2 PR-3 — row-scope WHERE-injection primitive.
export * from './row-scope';
// §9.91.6 PR-1 — statutory-egress deny primitive (PCPNDT-class non-disclosure floor).
export * from './statutory-egress';
// §9.91.3 PR-1 — clinical-retention / suppression-decision primitive.
export * from './retention';
// §9.94 B1 (ADR-0019 D5/D6) — package write-policy resolver primitive (the kernel
// consults it; packages shape a write, the kernel still enforces every gate).
export * from './write-policy';
// §9.94 B3 (ADR-0019 D8) — package-route contract primitive (manifest entry +
// request/response envelope + capability builder + pure path matcher/validators).
export * from './package-routes';
// §9.94 B4 (ADR-0019 D4) — edge gate-cache: a GrantsRepository decorator that resolves
// the capability gate offline from a bounded-staleness last-known-good snapshot.
export * from './edge-gate-cache';
// §9.50 Phase B Slice 7 — static analyzer.
//
// Also reachable via the `./static-analyzer` subpath (preferred for
// downstream consumers that want to signal the heavier `typescript`
// peer-dep at import time). The bare re-export below is the convenience
// path for the backend wrapper, whose tsconfig moduleResolution is
// classic-`node` and so cannot read the `exports` subpath map. The
// runtime cost is identical regardless — `static-analyzer.js` eagerly
// requires `typescript` at module load, and the backend has needed
// that since the analyzer first shipped.
export * from './static-analyzer';
// §9.166 Step 6 — the typed `xdeck.invoice` surface (the deck↔consumer invoice ledger).
export * from './invoice';
// §9.166 Step 6 — the in-memory invoice ledger for sibling-repo tests. Exported from the MAIN
// entry as well as `./testing` because it uses no jest globals (plain async functions), and
// consumers on classic `node` module resolution cannot reach a package subpath at all.
export * from './invoice-double';
