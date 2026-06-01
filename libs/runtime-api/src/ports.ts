/**
 * §9.50 Phase A Slice 3 — ports the runtime guard injects.
 *
 * Mirrors the approvals-engine port-injection pattern: the guard
 * library is sandbox-agnostic and DB-agnostic; the host (kernel
 * platform module that constructs the guard) supplies adapters.
 * Slice 4 ships the TypeORM-backed master-DB adapter.
 */

import type { Capability } from './capability';

/**
 * Identity of the package whose call is being guarded. Required for
 * every {@link RuntimeGuard.ensureGranted} call so the error / audit
 * row + §9.49 log event carry the right (tenant, package, version)
 * tuple.
 *
 * `tenantSlug` + `env` are required from §9.50 Phase B Slice 9 onward
 * so the capability decision can emit a {@link TenantLogEvent} with
 * full identity (Slice 1 codec validates `tenantSlug` pattern +
 * `env: 'dev' | 'uat' | 'prod'`). Both fields are already carried in
 * `XDeckContext` at the production builder — no new lookup needed.
 */
export interface GuardContext {
  tenantId: string;
  tenantSlug: string;
  env: 'dev' | 'uat' | 'prod';
  packageName: string;
  packageVersion: string;
}

/**
 * Result of a single capability check, emitted to the audit callback
 * (Slice 8) regardless of outcome.
 *
 *  - `granted` — the capability was in the active grant set.
 *  - `not_granted` — the grant lookup returned a set that did not
 *    include the capability; `errorCode` is `'CAPABILITY_NOT_GRANTED'`.
 *  - `reserved` — the capability is in the §9.50.9.1 reserved list;
 *    `errorCode` is `'RESERVED_CAPABILITY'`. Reservation precedence
 *    means this result fires regardless of whether the grant set
 *    included the string.
 */
export type CapabilityCheckResult = 'granted' | 'not_granted' | 'reserved';

/**
 * Shape the audit callback receives on every {@link RuntimeGuard.ensureGranted}
 * call. The host (Slice 8 `PlatformRuntimeApiModule`) wraps this into an
 * `AuditLog` row via `AsyncAuditWriter`.
 *
 * `actorClassId` and `payloadDigest` are deferred to Slice 5a — the
 * guard sees neither today. Adding them is additive and won't break
 * existing callback consumers.
 */
export interface CapabilityAuditEntry {
  tenantId: string;
  /** Required from §9.50 Phase B Slice 9 — used by the §9.49 tenant-log
   * listener to construct a valid {@link TenantLogEvent}. Matches the
   * Slice 1 codec's slug pattern. */
  tenantSlug: string;
  /** Required from §9.50 Phase B Slice 9 — used by the §9.49 tenant-log
   * listener. Closed-set `'dev' | 'uat' | 'prod'`. */
  env: 'dev' | 'uat' | 'prod';
  packageName: string;
  packageVersion: string;
  capability: string;
  result: CapabilityCheckResult;
  /** Stable error code from `@xdeck/runtime-api` errors; absent for `granted`. */
  errorCode?: string;
}

/**
 * Callback the {@link RuntimeGuard} fires after every capability check.
 * MUST NOT throw — the guard does NOT catch callback errors, so a
 * throwing callback would surface as the caller's error. Host
 * implementations should be fire-and-forget (e.g. `AsyncAuditWriter`).
 */
export type CapabilityAuditCallback = (entry: CapabilityAuditEntry) => void;

/**
 * Adapter the guard consumes to look up the set of granted capabilities
 * for a (tenant, package, version) tuple.
 *
 * The full grant set is fetched as one batch and cached by the guard —
 * adapters DO NOT need to optimise per-capability checks. Returning an
 * empty set is the canonical "no grants" answer (not throwing).
 *
 * Implementations:
 *  - In-memory (this file's {@link InMemoryGrantsRepository}) for tests.
 *  - TypeORM-backed (Slice 4) for production — queries the master DB
 *    `tenant_package_capability_grant` table.
 */
export interface GrantsRepository {
  /** Returns the full grant set for (tenant, package, version). */
  findGrants(ctx: GuardContext): Promise<ReadonlySet<Capability>>;
}

/**
 * Simple in-memory adapter, useful for tests and for the guard's own
 * spec. Seeded at construction; mutate via {@link grant} / {@link revoke}
 * to model lifecycle transitions inside a single test.
 *
 * Not for production — production uses Slice 4's TypeORM adapter.
 */
export class InMemoryGrantsRepository implements GrantsRepository {
  // Key: `${tenantId}|${packageName}|${packageVersion}`
  private readonly store = new Map<string, Set<Capability>>();

  constructor(seed?: Array<GuardContext & { capabilities: Iterable<Capability> }>) {
    for (const entry of seed ?? []) {
      const key = this.key(entry);
      this.store.set(key, new Set(entry.capabilities));
    }
  }

  async findGrants(ctx: GuardContext): Promise<ReadonlySet<Capability>> {
    return this.store.get(this.key(ctx)) ?? new Set();
  }

  /** Add a capability to the (tenant, package, version) grant set. */
  grant(ctx: GuardContext, capability: Capability): void {
    const key = this.key(ctx);
    const set = this.store.get(key) ?? new Set<Capability>();
    set.add(capability);
    this.store.set(key, set);
  }

  /** Remove a capability from the grant set. */
  revoke(ctx: GuardContext, capability: Capability): void {
    const set = this.store.get(this.key(ctx));
    set?.delete(capability);
  }

  /** Drop every grant — test isolation between cases. */
  clear(): void {
    this.store.clear();
  }

  private key(ctx: GuardContext): string {
    return `${ctx.tenantId}|${ctx.packageName}|${ctx.packageVersion}`;
  }
}
