/**
 * §9.50 Phase A Slice 3 — RuntimeGuard. The capability enforcement
 * layer. Pure TS, sandbox-agnostic. The host process constructs one
 * guard per kernel boot, passing in a {@link GrantsRepository}
 * adapter; the sandbox host (separate follow-up sub-slice) calls
 * `ensureGranted` before invoking the wrapped `xdeck.*` method.
 *
 * Why this is its own object (not a free function):
 *  - **Caching** — grant sets are hot-path-read. The guard caches by
 *    (tenantId, packageName, packageVersion) with a short TTL so the
 *    grants table doesn't take 10k req/s. Cache lives on the instance,
 *    not module-level — multiple hosts in the same process don't share
 *    state.
 *  - **Test seam** — `clock()` injection lets specs simulate TTL
 *    elapse without `jest.useFakeTimers()` ceremony.
 *  - **Future invalidation** — when grants change (admin grants /
 *    revokes a capability), the host calls `invalidate(ctx)`. Without
 *    an instance, there's nowhere to keep the cache.
 */

import { ensureNotReserved, type Capability } from './capability';
import { CapabilityNotGrantedError, ReservedCapabilityError } from './errors';
import type { CapabilityAuditCallback, GrantsRepository, GuardContext } from './ports';

/**
 * §9.50 Phase B Slice 9 — narrowed shape `invalidate()` accepts.
 * Just the three fields that compose the cache key, so admin paths
 * that don't carry `tenantSlug` / `env` can call invalidate without
 * fabricating values. A full {@link GuardContext} is assignable.
 */
export type InvalidateKey = Pick<GuardContext, 'tenantId' | 'packageName' | 'packageVersion'>;

export interface RuntimeGuardOptions {
  /** Adapter the guard reads grants from. Required. */
  repository: GrantsRepository;
  /**
   * Cache TTL in milliseconds. Default 60_000 (60s) — short enough
   * that a revoke takes effect quickly without explicit invalidation,
   * long enough to absorb the typical request burst. Set to 0 to
   * disable caching entirely (every call hits the repository).
   */
  cacheTtlMs?: number;
  /**
   * Wall-clock injection. Defaults to `Date.now`. Specs override for
   * deterministic TTL behaviour.
   */
  clock?: () => number;
  /**
   * §9.50 Slice 8 — fires after every {@link ensureGranted} call with
   * the outcome (granted / not_granted / reserved). Host wires
   * `AsyncAuditWriter` behind this. MUST NOT throw — see callback
   * docstring. Undefined keeps the guard silent (test default).
   */
  auditCallback?: CapabilityAuditCallback;
}

interface CacheEntry {
  grants: ReadonlySet<Capability>;
  expiresAt: number;
}

export class RuntimeGuard {
  private readonly repository: GrantsRepository;
  private readonly cacheTtlMs: number;
  private readonly clock: () => number;
  private readonly auditCallback?: CapabilityAuditCallback;
  // Key: `${tenantId}|${packageName}|${packageVersion}` (same shape as ports).
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: RuntimeGuardOptions) {
    this.repository = options.repository;
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.clock = options.clock ?? (() => Date.now());
    this.auditCallback = options.auditCallback;
  }

  /**
   * Throws {@link CapabilityNotGrantedError} when `capability` is not
   * in the tenant's grants for this package. Throws {@link
   * ReservedCapabilityError} (via {@link ensureNotReserved}) when the
   * capability is reserved per §9.50.9.1 — the reservation check fires
   * FIRST so the operator sees the more specific reason even if the
   * grant table somehow had a stale row for a now-reserved capability.
   *
   * Resolves with `void` on success — caller proceeds with the wrapped
   * `xdeck.*` call.
   *
   * Emits an audit entry on EVERY path (success + both failure modes)
   * when an `auditCallback` was configured. Reservation precedence
   * means the reserved path emits before the not_granted path could.
   */
  async ensureGranted(capability: Capability, ctx: GuardContext): Promise<void> {
    try {
      ensureNotReserved(capability);
    } catch (err) {
      if (err instanceof ReservedCapabilityError) {
        this.emitAudit(capability, ctx, 'reserved', err.code);
      }
      throw err;
    }
    const grants = await this.loadGrants(ctx);
    if (!grants.has(capability)) {
      this.emitAudit(capability, ctx, 'not_granted', 'CAPABILITY_NOT_GRANTED');
      throw new CapabilityNotGrantedError(capability, ctx.packageName, ctx.tenantId);
    }
    this.emitAudit(capability, ctx, 'granted');
  }

  private emitAudit(
    capability: Capability,
    ctx: GuardContext,
    result: 'granted' | 'not_granted' | 'reserved',
    errorCode?: string
  ): void {
    if (!this.auditCallback) return;
    this.auditCallback({
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      env: ctx.env,
      packageName: ctx.packageName,
      packageVersion: ctx.packageVersion,
      capability,
      result,
      errorCode
    });
  }

  /**
   * Drop the cache entry for (tenantId, packageName, packageVersion).
   * Host calls this when the admin grants / revokes a capability or
   * when the package version changes. Other entries unaffected.
   *
   * Narrowed to {@link InvalidateKey} (the three fields used by the
   * cache key) so admin paths that don't carry `tenantSlug` / `env`
   * (e.g. `CapabilityGrantsService` building ctx from a URL) don't
   * have to fabricate those values. The full {@link GuardContext} is
   * still assignable.
   */
  invalidate(ctx: InvalidateKey): void {
    this.cache.delete(this.key(ctx));
  }

  /** Drop every cached grant set. Test isolation between cases. */
  invalidateAll(): void {
    this.cache.clear();
  }

  private async loadGrants(ctx: GuardContext): Promise<ReadonlySet<Capability>> {
    const key = this.key(ctx);
    const now = this.clock();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.grants;
    const grants = await this.repository.findGrants(ctx);
    if (this.cacheTtlMs > 0) {
      this.cache.set(key, { grants, expiresAt: now + this.cacheTtlMs });
    }
    return grants;
  }

  private key(ctx: InvalidateKey): string {
    return `${ctx.tenantId}|${ctx.packageName}|${ctx.packageVersion}`;
  }
}
