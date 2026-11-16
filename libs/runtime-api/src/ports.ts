/**
 * §9.50 Phase A Slice 3 — ports the runtime guard injects.
 *
 * Mirrors the approvals-engine port-injection pattern: the guard
 * library is sandbox-agnostic and DB-agnostic; the host (kernel
 * platform module that constructs the guard) supplies adapters.
 * Slice 4 ships the TypeORM-backed master-DB adapter.
 */

import type { Capability } from './capability';
import type { XDeckActor, DeckEnv } from './runtime';

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
  deckId: string;
  tenantSlug: string;
  env: 'dev' | 'uat' | 'prod';
  /**
   * §9.151 D5 PR-2 — which of the DECK's environments this call operates on
   * (see {@link DeckEnv}; distinct from `env`, the host's DEPLOYMENT env).
   * Derived from {@link XDeckContext.deckEnv} when the sandbox GuardContext is
   * built, i.e. from the worker's BIRTH-LOCKED identity — the same channel as
   * `deckId`, never the per-call overlay, because this selects a DATABASE and
   * a pooled worker must not be able to carry one call's target into another.
   * Absent ⇒ the deck's base (`prod`) database.
   */
  deckEnv?: DeckEnv;
  packageName: string;
  packageVersion: string;
  /**
   * §9.94 B5.c (ADR-0019 D9.1) — the verified requesting user, carried alongside the package
   * identity. Derived from {@link XDeckContext.actor} when the sandbox GuardContext is built
   * (parent-side, unspoofable). Enables per-user audit attribution + the broker's run-under-
   * the-consumer-user authz. ABSENT for system / job scope.
   */
  actor?: XDeckActor;
  /**
   * §9.94 B5.c (ADR-0019 D9.5) — broker-hop depth carried from {@link XDeckContext.brokerDepth},
   * so a brokered call can enforce {@link MAX_BROKER_DEPTH}. Absent ⇒ depth 0 (top-level).
   */
  brokerDepth?: number;
  /**
   * §9.166 Step 6 — set by the PARENT when a vertical's offline work, already done on an
   * appliance, is being replayed on the cloud. Never from the payload and never from the
   * worker: a package that could claim to be a replay could ask the ledger to skip minting
   * and adopt someone else's document.
   *
   * Under it the invoice ledger is LOOKUP-ONLY — `invoice.issue` for a key the box already
   * synced returns that invoice, and for an unknown key refuses (retryable
   * `DECK_INVOICE_AWAITING_EDGE_LEDGER`) instead of minting a SECOND, cloud-numbered document
   * for a sale the box already numbered. Absent ⇒ an ordinary call.
   *
   * Set only by `EdgeIngestService`, from the authenticated appliance, through
   * `PackageClassInvokeArgs.origin` and the per-call overlay; carried across the capability
   * broker to a provider's call as a fresh copy; stripped before the worker.
   */
  origin?: { kind: 'edge-replay'; edgeId: string };
  /**
   * §9.21 / §9.73 (row-973-erasure-readonly-bypass) — set by the PARENT, per call, when a
   * statutory erasure (or the retention sweep) runs a package teardown against an environment
   * database a plan downgrade made read-only. Carries only the id of a use the host opened and
   * audited (`ReadOnlyEnvErasureScope`); the host re-resolves it and checks the deck, env and
   * package against its own record, so an id alone grants nothing. Never from the payload,
   * never from the worker.
   *
   * Under it the entity write door permits only `delete` (and, for an anonymising use,
   * `update`), runs each one inside the scope's transaction, and refuses everything else.
   * Absent ⇒ an ordinary call, and a read-only env database refuses its writes.
   */
  erasureScope?: { ticketId: string };
  /**
   * §9.167 S12-K — the verified principal's sign-in, set by the PARENT per call from the verified
   * request at the two doors a person presses (the action door and the session package route):
   * the principal type, the time of their last full sign-in (unix seconds), and whether an API key
   * made the call. Read by the refund doors' recency check. Never from the payload, never posted
   * to the worker. Absent for a job, a schedule, a signed server call and a brokered call: no
   * person, so a refund there is refused.
   */
  signIn?: { principalType: string | null; lastAuthenticatedAt: number | null; viaApiKey: boolean };
  /**
   * §9.167 S12-K — held by the PARENT for this one call, beside {@link signIn}. A refund door that
   * refused for recency records it here, and the door that started the call answers from here with
   * the "confirm it's you" prompt, never from an error an app threw. Never posted to the worker.
   */
  stepUpSlot?: { refused: { reason: 'unknown' | 'future' | 'stale'; maxAgeSeconds: number } | null };
  /**
   * §9.166 (core-ledger-edge-lane) — held by the PARENT for this one call, beside {@link stepUpSlot}
   * and passed BY REFERENCE the same way. When a host door refuses with an error that declares
   * itself retryable (`retryable === true` and a string `code`, e.g. the invoice ledger’s
   * `DECK_INVOICE_AWAITING_EDGE_LEDGER`), the pool’s host-call handler records `{ code }` here: the
   * first one wins and is never overwritten. The caller that made the slot reads it after the call,
   * since the sandbox strips a host error to its message; the capability broker hands the same slot
   * to a provider’s call. Never posted to the worker, never set by the worker.
   */
  refusalSlot?: { retryable: { code: string } | null };
  /**
   * §9.169 PR-10 — the capability CEILING of this call: the set of capabilities the run may hold AT
   * MOST, set by the PARENT per call (an integrator handler's binding) and never by the worker or the
   * payload. {@link RuntimeGuard.ensureGranted} refuses a capability outside it BEFORE any grant is
   * read; a package identity must then also hold the master grant, while the deck-code identity
   * (`core/deck-code`) has no grants but this ceiling. Absent ⇒ an ordinary call: the grants decide.
   */
  capabilityCeiling?: readonly string[];
  /**
   * §9.169 PR-10 — the integrator handler run on whose authority the integrator door answers
   * (`xdeck.integrator.*`): the integrator a callout is confined to, the handler, and the run its
   * per-run ceilings are counted against. Set by the PARENT per call, never from the payload and
   * never from the worker (a run id is an authority, not a correlation id). Absent ⇒ that door refuses.
   */
  integratorRun?: { integratorId: string; handlerId: string; runId: string };
  /**
   * §9.169 PR-11 — the TRIAL this call is a dry run of ("Try it"). Set by the PARENT per call, like the ceiling
   * and the run: never from the payload and never from the worker, so no class can claim a trial. Every check
   * runs as in a run and every read is a real read of the deck; at the one write chokepoint the entity door
   * records the write instead of making it, and the callout door answers from the trial's mocks. Absent ⇒ a
   * real call.
   */
  dryRun?: { id: string };
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
  deckId: string;
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
  /**
   * §9.94 B5.c — the verified user the capability call ran under (from {@link GuardContext.actor}),
   * for per-user audit attribution. Absent for system / job scope.
   */
  actorUserId?: string;
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
  // Key: `${deckId}|${packageName}|${packageVersion}`
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
    return `${ctx.deckId}|${ctx.packageName}|${ctx.packageVersion}`;
  }
}
