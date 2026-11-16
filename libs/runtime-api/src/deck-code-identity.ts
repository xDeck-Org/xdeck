/**
 * §9.169 PR-10 — the identity a DECK's own integration class runs under in the sandbox.
 *
 * A pooled call needs an `XDeckContext.package`, and a deck's class belongs to no package, so it runs
 * as `core/deck-code`, version `0`. `core` is a namespace no package can claim: it sits in
 * `RESERVED_NAMESPACES` (apps/backend `tenant-package/services/namespace-sources.ts`), which the
 * namespace registry applies AFTER every source is unioned, so no install, seed or claim can ever
 * mint a package under it — the identity cannot collide with, or be impersonated by, a package.
 *
 * The identity holds NO master grants and never will: every handler of every integrator on the deck
 * shares it, so a grant row here would be a union across all of them (and `granted_by` wants a
 * person). Its grants are the run's parent-set {@link GuardContext.capabilityCeiling}, which
 * `RuntimeGuard.ensureGranted` reads per call and never caches (the grant cache is keyed by identity).
 */

import type { GuardContext } from './ports';

/** The `XDeckContext.package` a deck's own code runs as. */
export const DECK_CODE_PACKAGE = Object.freeze({ namespace: 'core', name: 'deck-code', version: '0' } as const);

/** `${namespace}/${name}` of {@link DECK_CODE_PACKAGE} — the `packageName` the guard sees. */
export const DECK_CODE_PACKAGE_NAME = 'core/deck-code';

/** Whether `ctx` is a deck's own code (the reserved `core/deck-code` identity), by exact package name. */
export function isDeckCodeIdentity(ctx: Pick<GuardContext, 'packageName'>): boolean {
  return ctx.packageName === DECK_CODE_PACKAGE_NAME;
}
