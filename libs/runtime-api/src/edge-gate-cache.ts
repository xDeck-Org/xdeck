/**
 * §9.94 B4 (ADR-0019 D4) — the EDGE GATE-CACHE. A `GrantsRepository` decorator that
 * lets the kernel's capability gate resolve OFFLINE on an edge-deck.
 *
 * ── The gap it closes ───────────────────────────────────────────────────────────────
 * The kernel is co-located with the package runtime on the edge-deck (ADR-0019 D4), so
 * `xdeck.*` calls are local. But one gate input is still cloud-only: the per-tenant
 * capability GRANT set lives in the master DB (`TypeormGrantsRepositoryAdapter`). When the
 * edge is disconnected the authoritative lookup THROWS (master unreachable) and the gate
 * fails CLOSED — safe, but it blocks every otherwise-authorised offline write. D4's rule is
 * explicit: *cache the cloud-only input on the edge so the gate resolves offline; absent the
 * cache the gate fails closed, never open.*
 *
 * ── How it resolves (strictly additive; never fails open) ───────────────────────────
 *   • **Online** — read the authoritative repo, WRITE-THROUGH the result to the snapshot
 *     store (the edge's last-known-good), and return the fresh answer. Persistence is
 *     best-effort: a store-write failure NEVER masks the authoritative answer.
 *   • **Offline (authoritative throws) + a FRESH snapshot** — return the cached grant set;
 *     the gate resolves offline. This is the ONLY behaviour the decorator adds.
 *   • **Offline + NO snapshot, or a STALE one** — re-throw the authoritative error. The
 *     caller fails closed EXACTLY as it does today (no decorator). Staleness is bounded by
 *     {@link EdgeGateCacheOptions.maxStalenessMs}: a snapshot older than the offline grace
 *     window is treated as absent, so a capability revoked while the edge was offline cannot
 *     be honoured indefinitely — the exposure is capped at the window, then the gate closes.
 *
 * The decorator distinguishes "couldn't reach the authority" (a THROW → try the snapshot)
 * from "the authority says zero grants" (an empty Set → a valid answer, written through and
 * returned). It NEVER turns an infra error into a silent allow; the worst case is the
 * pre-existing fail-closed throw.
 *
 * Pure TS, sandbox/DB-agnostic — the host supplies the {@link GateSnapshotStore} adapter
 * (backend: Redis/CacheService today; an edge-deck repoints the SAME seam at its local
 * store). Mirrors the {@link RuntimeGuard} / {@link GrantsRepository} port-injection pattern.
 */

import type { Capability } from './capability';
import type { GrantsRepository, GuardContext } from './ports';

/**
 * The persisted last-known-good grant set for one (tenant, package, version) tuple.
 * `grants` is plain `string[]` (not `Capability[]`) so it serialises cleanly through any
 * JSON-backed store; the decorator re-narrows to `Capability` on read. `capturedAt` is the
 * authoritative-read wall-clock (ms) used for the staleness bound — NOT a store TTL.
 */
export interface GateSnapshot {
  grants: readonly string[];
  capturedAt: number;
}

/**
 * The persistence seam the edge gate-cache reads/writes. Tenant isolation is structural:
 * the key is {@link gateSnapshotKey} `(deckId|packageName|packageVersion)`, so one
 * tenant's snapshot can never satisfy another tenant's lookup. Implementations MUST be
 * total — a backing-store failure surfaces as `read → null` / a swallowed `write`, never a
 * throw (so a flaky store degrades to fail-closed, the safe direction).
 */
export interface GateSnapshotStore {
  /** The last-known-good snapshot for `key`, or `null` when absent/unreadable. */
  read(key: string): Promise<GateSnapshot | null>;
  /** Persist (overwrite) the snapshot for `key`. Best-effort; must not throw. */
  write(key: string, snapshot: GateSnapshot): Promise<void>;
}

/** Observability hook payload — fired whenever the gate resolves from a cached snapshot. */
export interface EdgeGateCacheFallbackInfo {
  ctx: GuardContext;
  /** Age of the served snapshot in ms (`now - capturedAt`). */
  ageMs: number;
  /** The authoritative error that triggered the fallback. */
  cause: unknown;
}

export interface EdgeGateCacheOptions {
  /** The real (master-DB) grant lookup. */
  authoritative: GrantsRepository;
  /** Where last-known-good snapshots live (Redis today; the edge's local store on-prem). */
  store: GateSnapshotStore;
  /**
   * The offline grace window in ms. A snapshot older than this is treated as ABSENT →
   * fail closed. Bounds how long a capability revoked-while-offline can still be honoured.
   * Must be `> 0`; `0`/negative disables the offline fallback entirely (always fail closed).
   */
  maxStalenessMs: number;
  /** Wall-clock injection; defaults to `Date.now`. Specs override for deterministic ages. */
  clock?: () => number;
  /** Fired (best-effort) on every snapshot fallback so the host can log/metric the degraded path. */
  onFallback?: (info: EdgeGateCacheFallbackInfo) => void;
}

/** The cache key for a (tenant, package, version) tuple — identical shape to the guard's own. */
export function gateSnapshotKey(ctx: GuardContext): string {
  return `${ctx.deckId}|${ctx.packageName}|${ctx.packageVersion}`;
}

export class EdgeGateCacheRepository implements GrantsRepository {
  private readonly authoritative: GrantsRepository;
  private readonly store: GateSnapshotStore;
  private readonly maxStalenessMs: number;
  private readonly clock: () => number;
  private readonly onFallback?: (info: EdgeGateCacheFallbackInfo) => void;

  constructor(options: EdgeGateCacheOptions) {
    this.authoritative = options.authoritative;
    this.store = options.store;
    this.maxStalenessMs = options.maxStalenessMs;
    this.clock = options.clock ?? (() => Date.now());
    this.onFallback = options.onFallback;
  }

  async findGrants(ctx: GuardContext): Promise<ReadonlySet<Capability>> {
    let grants: ReadonlySet<Capability>;
    try {
      grants = await this.authoritative.findGrants(ctx);
    } catch (err) {
      // Authority unreachable (master DB down / edge offline) — NOT "zero grants".
      // Try the last-known-good snapshot; fail closed (re-throw) if there isn't a fresh one.
      return this.fallback(ctx, err);
    }
    // Online success (incl. a legitimately-empty set) — refresh the edge's last-known-good.
    await this.persist(ctx, grants);
    return grants;
  }

  /** Write-through. Best-effort: a store failure must NEVER mask the authoritative answer. */
  private async persist(ctx: GuardContext, grants: ReadonlySet<Capability>): Promise<void> {
    try {
      await this.store.write(gateSnapshotKey(ctx), {
        grants: Array.from(grants) as string[],
        capturedAt: this.clock()
      });
    } catch {
      // Swallow — the caller already has the fresh authoritative grant set; a failed
      // snapshot write only means the NEXT offline read may fall back to an older snapshot.
    }
  }

  /**
   * Offline path. Returns the cached grants only when a snapshot exists AND is within the
   * staleness window; every other case re-throws the original authoritative error so the
   * caller fails closed exactly as it does without this decorator (D4: never fail open).
   */
  private async fallback(ctx: GuardContext, cause: unknown): Promise<ReadonlySet<Capability>> {
    if (this.maxStalenessMs <= 0) throw cause; // offline fallback disabled → fail closed
    let snapshot: GateSnapshot | null = null;
    try {
      snapshot = await this.store.read(gateSnapshotKey(ctx));
    } catch {
      // A throwing store is treated as "no snapshot" — fall through to the fail-closed throw.
      snapshot = null;
    }
    if (!snapshot) throw cause; // no cached input → fail closed
    const ageMs = this.clock() - snapshot.capturedAt;
    if (ageMs > this.maxStalenessMs) throw cause; // beyond the offline grace window → fail closed
    this.onFallback?.({ ctx, ageMs, cause });
    return new Set(snapshot.grants as Capability[]);
  }
}
