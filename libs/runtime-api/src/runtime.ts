/**
 * §9.50 — the `xdeck` runtime global injected into every executing
 * package class. This file declares the SHAPE; the implementation
 * (Slice 3 — runtime guard layer) consumes these types to wrap each
 * call with a capability check.
 *
 * **Stability contract.** Per §9.50.9, the runtime API never breaks —
 * new methods land in new domains, deprecation is slow. Packages
 * declare a minimum API version (`runtimeApi: ">=1.0.0"`) and incompatible
 * installs are refused. Every shape here is part of that contract.
 *
 * **Payload digests, not payloads, in audit.** Payload shapes are
 * carried by these interfaces for typing purposes; the audit log
 * (Slice 8) writes only SHA-256 digests, not the raw content.
 */

import type { InvoiceAPI } from './invoice';

/**
 * Always-available identity context. No capability needed — every
 * package class can read `xdeck.context` regardless of grants.
 *
 * Provided by the sandbox at construction; `traceId` / `spanId` are
 * minted per top-level invocation so capability calls correlate with
 * the originating trigger / cron / endpoint.
 */
/**
 * §9.151 D5 PR-2 — one of the DECK's environments (§9.88: each is its own
 * database, `tenant_<slug>__<env>`, with `prod` the unsuffixed base).
 *
 * **Not the same thing as {@link XDeckContext.env}.** That field is the
 * DEPLOYMENT environment of the host process (`NODE_ENV`) and is a closed
 * three-value set validated by the §9.49 tenant-log codec. This one identifies
 * WHICH of a deck's own databases a call operates on — a deck on a production
 * deployment can have `uat`/`sit`/`dev1` environments of its own. Conflating
 * them is what made package installs land in the base database only.
 *
 * Mirrors `TenantEnv` from `@xdeck/shared-types`. It is DUPLICATED rather than
 * imported on purpose: this library is the contract packages install, and it
 * carries **no dependencies** (peer-only) so a package never pulls the
 * platform's type surface in with it. The backend asserts at COMPILE TIME that
 * `TenantEnv` stays assignable to this type, so the two cannot drift silently
 * (see `deck-env-contract.spec.ts`).
 */
export type DeckEnv = 'prod' | 'uat' | 'sit' | 'dev' | `dev${number}` | `uat${number}` | `sit${number}`;

export interface XDeckContext {
  deckId: string;
  tenantSlug: string;
  /** Deployment environment of the host — `'dev' | 'uat' | 'prod'`. */
  env: 'dev' | 'uat' | 'prod';
  /**
   * §9.151 D5 PR-2 — which of the DECK's environments this call operates on
   * (see {@link DeckEnv}). Absent ⇒ the deck's base (`prod`) database, which is
   * what every pre-D5 call site does.
   *
   * Set by the host at dispatch and **birth-locked** onto the sandbox worker
   * alongside `deckId` — a class can read it but can never choose it, because
   * it selects a database. Read it when a class needs to know which
   * environment it is running against; never to gate security decisions (the
   * host already scopes every capability call by it).
   */
  deckEnv?: DeckEnv;
  package: {
    namespace: string;
    name: string;
    version: string;
  };
  /** Stable per top-level invocation; spans across all capability calls. */
  traceId: string;
  /** Stable per capability call within a trace. */
  spanId: string;
  /**
   * §9.150 — the VERIFIED acting user for THIS call, when a real user triggered it (action /
   * package route). Parent-set per-invocation via the sandbox overlay (like traceId/spanId — a
   * pooled worker serves many users), so a class can read attribution but NEVER forge it.
   * Absent for system / job / cron / anonymous-surface scope.
   */
  actor?: XDeckActor;
  /**
   * §9.166 — WHERE this package is running: `cloud` (the platform) or `appliance` (an on-site deck box).
   *
   * Set by the HOST from its own process runtime (`isEdgeRuntime()`) when it builds the context a class is
   * born with, and written over anything a caller or a payload carried: a class can read it but never choose
   * it. A package uses it to refuse, BEFORE any write, an act the appliance cannot do (online money: no
   * gateway key ever lives on a box), so a person meets a named refusal rather than a half-written bill.
   *
   * Absent ⇒ an older host: treat it as `cloud`. The kernel refuses cloud-only acts on an appliance by its
   * own rule whatever a package does, so this field is never the security boundary — only the early word.
   */
  plane?: 'cloud' | 'appliance';
}

/**
 * §9.94 B5.c (ADR-0019 D9.1) — the VERIFIED requesting user. It is the load-bearing input of the
 * capability broker: a brokered package→package call runs under THIS actor's authz, never the
 * provider's or the consumer-package's (no confused-deputy). It is PER-INVOCATION (a worker is
 * pooled + reused across different users), so it travels on the per-call overlay (parent-set from
 * the JWT at dispatch — unspoofable), NOT the immutable worker-init context, and is merged into the
 * host-side {@link GuardContext} for the duration of each call. ABSENT for system/job scope.
 */
export interface XDeckActor {
  userId: string;
  roles: readonly string[];
  /**
   * §9.150 — human display name of the acting user, resolved parent-side at dispatch (JWT-verified
   * principal, never caller-supplied). Lets a class stamp accept/approve ATTRIBUTION ("Confirmed by
   * <name>") that anonymous surfaces can render without a master-DB lookup the sandbox cannot do.
   * Optional: device/system principals may have none.
   */
  displayName?: string;
  /**
   * §9.91.8 PR-4b-4 — the purpose-of-use the actor ASSERTS for this dispatch (an opaque kebab id,
   * e.g. 'treatment', 'billing'). Carried in the dispatch BODY and validated at the DTO gate
   * (never a header — proxy whitelists silently drop those). Asserting a purpose grants NOTHING
   * by itself: field/row policy rules key on role AND purpose, so a caller can only select among
   * rules written for their role — while the assertion is recorded on the PHI audit trail
   * (claim accountability). Absent ⇒ null carrier ⇒ fail-closed for classified entities.
   */
  purpose?: string | null;
  /**
   * The principal class of the verified caller. Parent-set from the JWT-verified principal
   * at dispatch — never caller-supplied.
   *
   *   'user'     — a deck member (the default when absent). Authorized by role RBAC.
   *   'device'   — a TenantDevice principal (§9.76 item-139). Authorized by
   *                {@link deviceCapabilities}, never role RBAC.
   *   'step_up'  — a PLATFORM principal holding a §9.71/§9.93 elevation onto this deck.
   *   'consumer' — a §9.61 ClienX consumer on the §9.150 B consumer surface, acting on
   *                their OWN deck-local link. Authorized at the route, not by role.
   *   'system'   — a server-to-server caller (a signed public-hmac door). No human
   *                principal at all.
   *   'api_key'  — a deck's API key acting as its own deck principal, with the one
   *                deck role its owner gave it. A program: no person, no session.
   *   'integrator' — a deck's integrator acting the same way: its own deck principal,
   *                with the one deck role its owner gave it. A program too.
   *
   * **Why 'consumer' and 'system' were added (§9.91.13).** The record-scope write floor has
   * always BRANCHED on both — see the consumer/system early-returns in
   * entity-capability.service.ts, and ReadAccessContext carries the full five — but this
   * type named only three, so the package-route ingress literally could not express the
   * kind it had already verified, and every class invoked from a consumer route saw no
   * kind and therefore read as 'user'.
   *
   * Nothing was unsafe: that floor treats kind-less AND role-less as anonymous and
   * returns the same answer 'consumer' would. What was impossible was a CLASS knowing who
   * it serves — and a clinical surface needs exactly that, because a vital a PATIENT typed
   * is not a measurement. The alternative, inferring the kind from role emptiness, is the
   * inference this platform's own dispatcher records as a shipped regression.
   *
   * **Why 'step_up' is named rather than left to fall through as 'user'.** It has no
   * tenant-DB user row, so `getEffectivePermissions` resolves EMPTY and the RBAC gate
   * denied it with "user lacks any of the required permission(s)" — a message about a
   * user that does not exist, for a principal whose authorization lives somewhere else
   * entirely (the grant + its scope). Naming the class lets the dispatcher refuse for
   * the REAL reason instead of reporting an empty permission set, and gives the
   * eventual decision — whether an elevated platform principal may dispatch deck data
   * actions at all, and under which scope — one explicit place to be made rather than
   * an accident of falling through a gate written for someone else.
   */
  principalKind?: 'user' | 'device' | 'step_up' | 'consumer' | 'system' | 'api_key' | 'integrator';
  /**
   * §9.91.13 PR-3b-ii — the deck-local §9.61 `customer_links` row id the verified consumer
   * session is bound to. Present ONLY when {@link principalKind} === 'consumer', stamped by the
   * kernel consumer-route dispatcher from the session the door already verified — never from a
   * payload. It is the typed successor of the `consumer:<linkId>` sentinel in `userId`, which
   * nothing may parse: a (core) capability that acts FOR the consumer (a self-profile write)
   * takes its subject from here and refuses any identity a package supplies. Not PII — the
   * class already receives the same id on `args.caller`.
   */
  customerLinkId?: string;
  /**
   * §9.76 — the device's granted §9.50 closed-vocabulary capabilities (e.g.
   * 'entity:read:QueueEntry'), carried from the JWT (set at registration; the strategy
   * re-reads the live device row per request, so suspend/revoke bites within the token TTL).
   * Present only when {@link principalKind} === 'device'. The dispatcher's permission gate
   * consults THIS for devices — no role lookup, no DB grant lookup.
   */
  deviceCapabilities?: readonly string[];
}

/**
 * §9.94 B5.c — the max broker-hop depth. A consumer→provider→provider… chain deeper than this
 * is refused (`BROKER_DEPTH_EXCEEDED`). Bounds runaway recursion / cycles without needing a
 * full visited-set across the (pooled, immutable-init) sandbox boundary.
 */
export const MAX_BROKER_DEPTH = 8;

/** Payload for `xdeck.capabilities.invoke` — the kernel-brokered package→package call (§9.94 B5.c). */
export interface CapabilitiesInvokePayload {
  /** The consumed capability to invoke, `<namespace>:<name>@<range>` (D9). */
  capability: string;
  /** The argument passed to the resolved provider's capability handler. */
  input?: Record<string, unknown>;
}

// ── Notifications ────────────────────────────────────────────────────

export type NotificationVariant = 'plain-text' | 'action-card' | 'banner' | 'toast' | 'modal' | 'inline';

export interface NotificationSendPayload {
  /** Target user id (tenant-scope). */
  userId: string;
  /** Which of the 6 variants the tenant renders. */
  variant: NotificationVariant;
  /** Variant-specific body shape — opaque to the runtime, validated by the tenant's renderer. */
  body: Record<string, unknown>;
  /** Optional correlation key for de-dup. */
  dedupKey?: string;
}

export interface NotificationResult {
  /** Server-minted id for the persisted notification row. */
  id: string;
  /** True when the same `dedupKey` was already delivered within the window. */
  deduplicated: boolean;
}

export interface NotificationBroadcastPayload {
  variant: NotificationVariant;
  body: Record<string, unknown>;
  /** Optional role filter — defaults to every active tenant user. */
  roleFilter?: string[];
}

export interface NotificationAPI {
  /** Requires capability `notification:send-in-app`. */
  send(payload: NotificationSendPayload): Promise<NotificationResult>;
  /** Requires capability `notification:broadcast`. Counts against tenant rate limit. */
  broadcast(payload: NotificationBroadcastPayload): Promise<{ delivered: number }>;
}

// ── Email / SMS / WhatsApp / Push ────────────────────────────────────

export interface EmailSendPayload {
  to: string | string[];
  subject: string;
  /** Template id from the tenant's template library — rendered server-side. */
  templateId: string;
  /** Template substitution context — keys depend on the template. */
  data: Record<string, unknown>;
  /** Optional reply-to override (defaults to tenant's configured sender). */
  replyTo?: string;
}

export interface EmailSendResult {
  /** Provider-assigned id from the tenant's configured email provider. */
  providerMessageId: string;
}

export interface EmailAPI {
  /** Requires capability `email:send`. Counts against tenant email quota + cost. */
  send(payload: EmailSendPayload): Promise<EmailSendResult>;
}

export interface SmsSendPayload {
  to: string;
  templateId: string;
  data: Record<string, unknown>;
}

export interface SmsAPI {
  /** Requires capability `sms:send`. Counts against tenant SMS quota + cost. */
  send(payload: SmsSendPayload): Promise<{ providerMessageId: string }>;
}

interface WhatsAppSendPayloadBase {
  to: string;
  templateId: string;
  data: Record<string, unknown>;
}

/**
 * §9.152 PR-2 — every WhatsApp send declares its intent.
 *
 * Promotional traffic is governed by TRAI TCCCPR + DPDP and may go out only
 * against active consent for that exact `(purpose, channel)`; transactional
 * traffic is not gated. A package cannot opt out of declaring which it is:
 * the platform treats an absent or unrecognised category as MARKETING and
 * demands consent, because an opaque payload cannot prove transactional-ness
 * and a mis-classification is a regulatory violation, not a bug report.
 *
 * `principalId` is the consent-ledger subject (the recipient), and `purpose`
 * must match the purpose the consent was granted for — consent for "offers"
 * does not authorise "surveys".
 */
export type WhatsAppSendPayload =
  | (WhatsAppSendPayloadBase & { category: 'transactional' })
  | (WhatsAppSendPayloadBase & { category: 'marketing'; principalId: string; purpose: string });

export interface WhatsAppAPI {
  /**
   * Requires capability `whatsapp:send`. Counts against WA quota + cost.
   * A `category: 'marketing'` payload additionally passes the deck's consent
   * gate and is REFUSED (never silently dropped) without active consent.
   */
  send(payload: WhatsAppSendPayload): Promise<{ providerMessageId: string }>;
}

export interface PushSendPayload {
  userId: string | string[];
  title: string;
  body: string;
  /** Click-through URL when supported by the receiving device. */
  href?: string;
}

export interface PushAPI {
  /** Requires capability `push:send`. Counts against push quota. */
  send(payload: PushSendPayload): Promise<{ delivered: number }>;
}

// ── AI ───────────────────────────────────────────────────────────────

export interface AICompletePayload {
  /** Conversation messages — same shape as Anthropic / OpenAI chat. */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Optional model preference — tenant plan may downgrade or refuse. */
  model?: string;
  /** Max output tokens — capped by tenant plan. */
  maxTokens?: number;
  temperature?: number;
}

export interface AICompleteResult {
  text: string;
  /** Actual model the tenant's plan resolved to. */
  modelUsed: string;
  /** Input + output token counts for downstream attribution. */
  usage: { inputTokens: number; outputTokens: number };
}

export interface AIEmbedPayload {
  text: string | string[];
  model?: string;
}

export interface AIEmbedResult {
  /** One embedding per input text. */
  embeddings: number[][];
  modelUsed: string;
  usage: { inputTokens: number };
}

/**
 * §9.158 — ask the kernel to build the CALLING deck's daily business digest.
 *
 * Deliberately thin: the package owns *whether and when* (its own cron, registered at install),
 * the kernel owns *how*. The aggregation happens inside Postgres and only the aggregate is
 * stored, so a deck's business rows — a clinic's encounters, a restaurant's bills — never enter
 * the class sandbox. That is why this is a kernel capability rather than a package-side loop over
 * `entity.read`: the honest package-side implementation would need an `entity:read` grant on
 * every entity the deck happens to have, which is a grant no assistant should hold.
 */
export interface AIDigestBuildPayload {
  /** UTC day to build, `YYYY-MM-DD`. Omit for yesterday — the normal nightly case. */
  day?: string;
}

export interface AIDigestBuildResult {
  /** The day actually built (echoed so a caller that omitted `day` knows which one it got). */
  day: string;
  /** How many (day, scope) rows were written. */
  scopes: number;
  /** How many entities contributed metrics. */
  entities: number;
  /** How many entities were measurable-but-skipped (undated, no columns, query failed). */
  skipped: number;
}

export interface AIAgentInvokePayload {
  /** Tenant-configured agent id (per §9.25). */
  agentId: string;
  /** Free-form input the agent's prompt template consumes. */
  input: Record<string, unknown>;
}

export interface AIAgentInvokeResult {
  output: string;
  /** Tool calls the agent made during execution. */
  toolCalls: Array<{ name: string; argsDigest: string }>;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AIKnowledgeQueryPayload {
  query: string;
  /** Optional knowledge-base id; defaults to the tenant's primary KB. */
  knowledgeBaseId?: string;
  /** Number of top results to return; capped at tenant plan limit. */
  topK?: number;
}

export interface AIKnowledgeQueryResult {
  results: Array<{
    text: string;
    score: number;
    /** Source document id for citation. */
    sourceId: string;
  }>;
}

export interface AIAPI {
  /** Requires capability `ai:complete`. Counts against AI token quota. */
  complete(payload: AICompletePayload): Promise<AICompleteResult>;
  /** Requires capability `ai:embed`. */
  embed(payload: AIEmbedPayload): Promise<AIEmbedResult>;
  /** Requires capability `ai:digest-build`. Builds the calling deck's daily business digest. */
  digestBuild(payload: AIDigestBuildPayload): Promise<AIDigestBuildResult>;
  /** Requires capability `ai:agent-invoke`. */
  agentInvoke(payload: AIAgentInvokePayload): Promise<AIAgentInvokeResult>;
  /** Requires capability `ai:knowledge-query`. */
  knowledgeQuery(payload: AIKnowledgeQueryPayload): Promise<AIKnowledgeQueryResult>;
}

// ── Templates ────────────────────────────────────────────────────────

export interface TemplateRenderPayload {
  templateId: string;
  data: Record<string, unknown>;
  /** Output format hint — `'html' | 'text' | 'markdown'`. */
  format?: 'html' | 'text' | 'markdown';
}

export interface TemplateAPI {
  /** Requires capability `template:render`. */
  render(payload: TemplateRenderPayload): Promise<{ rendered: string }>;
}

// ── Entities (per-resource grants) ───────────────────────────────────

export interface EntityReadPayload {
  /** Entity name as declared in the package's manifest. */
  entityName: string;
  /** Where-clause shape — opaque to the runtime; the tenant DB layer validates. */
  where?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  orderBy?: Record<string, 'ASC' | 'DESC'>;
}

/** The most rows one {@link EntityAPI.readAs} call returns; a larger `limit` is clamped to it. */
export const MAX_DELEGATED_READ_ROWS = 1000;

/**
 * ADR-0035 — `xdeck.entity.readAs`: read records AS the person who delegated it (capability
 * `entity:read-delegated`). The host takes the person from the delegation, never from this payload,
 * and applies their OWN current access on every call — the deck permission `<Entity>:query`, their
 * record scope and the deck's sharing rules — exactly as if they had run the query themselves.
 *
 * Refused (an error with a `code`) when the delegation is unknown, revoked or expired, was given to
 * another package, does not list `entityName`, or its person is no longer active; when it was given
 * for another subject (`subjectId`), or this read (`entityName` + `where`) is not one the person
 * approved — an edited filter needs the person to approve it again; when a DIFFERENT
 * person triggered this call (a delegation never shows one person another's records); outside the
 * live deck environment; and for a classified record type, which a read with no stated purpose of use
 * cannot reach.
 */
export interface EntityReadAsPayload {
  /** The delegation the person minted in their own session (`POST /api/v1/tenant/delegations`). */
  delegationId: string;
  /** Qualified entity name (`namespace/Entity`) — one the delegation lists. */
  entityName: string;
  /** Filter, in the same entity-filter vocabulary `entity.read` accepts — exactly as the person approved it. */
  where?: Record<string, unknown>;
  /** The app's own record this run serves (a saved report's id). Required when the delegation names one. */
  subjectId?: string;
  /** Clamped to {@link MAX_DELEGATED_READ_ROWS}; absent ⇒ that cap. */
  limit?: number;
  orderBy?: Record<string, 'ASC' | 'DESC'>;
}

/**
 * §9.163 — how ONE column resolves when an `upsert` hits an existing row.
 *
 * A CLOSED vocabulary, deliberately. Each entry maps to exactly one expression the
 * HOST composes; no caller string ever reaches SQL. The same trade the manifest's
 * `dataHooks` / `connectorHooks` blocks already make — an open registry here would
 * hand sandboxed package code an injection surface into the deck's own database.
 *
 * Why a vocabulary at all, rather than plain replace-style upsert (the Salesforce
 * `externalIdField` / Zoho `duplicate_check_fields` shape): replace loses merge
 * semantics. The motivating case needs a set UNION, a GREATEST and a COALESCE in the
 * conflict branch, and an author who reached for replace would silently drop them.
 */
export type EntityMergeOp =
  /** Replace with the incoming value. The default when a column is not named. */
  | { kind: 'set' }
  /** `col = col + <incoming>`. Counters: stock levels, points, series numbers. */
  | { kind: 'increment' }
  /** `col = GREATEST(col, <incoming>)`. Monotonic timestamps / high-water marks. */
  | { kind: 'greatest' }
  /** `col = COALESCE(<incoming>, col)`. Keep the existing value when the new one is null. */
  | { kind: 'coalesce' }
  /** Order-stable set UNION of a jsonb string array. Identity/alias id lists. */
  | { kind: 'arrayUnion' }
  /**
   * INSERT-ONLY: use the incoming value when the row is created, and leave the stored
   * value untouched on conflict. The column is omitted from the merge branch entirely.
   *
   * Added because the first real port needed it and would have corrupted data without
   * it: telemetry's `firstSeenAt` is set in `VALUES` and deliberately absent from the
   * `ON CONFLICT SET` list, so a composer that assigns every non-conflict column would
   * overwrite first-seen with last-seen on every identify — silently, and no existing
   * spec would have caught it. That is the closed vocabulary working as intended: each
   * entry is added deliberately, driven by a caller, never speculatively.
   */
  | { kind: 'keep' };

export interface EntityWritePayload {
  entityName: string;
  /**
   * Operation kind.
   *
   * `upsert` (§9.163) is insert-or-merge in ONE statement — the only atomic
   * read-or-create the class channel has. Reaching for read-then-write instead is a
   * lost update: the two calls are separate transactions, so a concurrent invocation
   * can land between them and be silently discarded.
   */
  op: 'insert' | 'update' | 'delete' | 'upsert';
  /** For insert/update/upsert: row data. For delete: ignored. */
  data?: Record<string, unknown>;
  /** For update/delete: where clause. For insert/upsert: ignored. */
  where?: Record<string, unknown>;
  /**
   * `upsert` only, REQUIRED — the columns whose UNIQUE constraint defines "the same
   * row". Must match a unique index the entity DECLARES; a conflict target with no
   * unique index is a Postgres runtime error, so the host validates it against entity
   * metadata rather than letting an author's typo become a 500 on a write path.
   */
  conflictOn?: string[];
  /**
   * `upsert` only — per-column merge rules applied when the row already exists.
   * Columns omitted here use `{ kind: 'set' }`.
   */
  onConflict?: Record<string, EntityMergeOp>;
}

export interface EntityAPI {
  /** Requires capability `entity:read:<entityName>`. */
  read<TRow = Record<string, unknown>>(payload: EntityReadPayload): Promise<TRow[]>;
  /** Requires capability `entity:write:<entityName>`. */
  write(payload: EntityWritePayload): Promise<{ affected: number }>;
  /**
   * Requires capability `entity:read-delegated` (ADR-0035). Reads with the access of the person who
   * minted `payload.delegationId`, never this package's — see {@link EntityReadAsPayload}.
   */
  readAs<TRow = Record<string, unknown>>(payload: EntityReadAsPayload): Promise<TRow[]>;
}

// ── Classes (per-class grants — RESERVED in Phase A/B/C) ────────────

export interface ClassInvokePayload {
  /** Target class id — must be `exposes:`d by the owning package. */
  classId: string;
  input: Record<string, unknown>;
}

export interface ClassAPI {
  /**
   * Requires capability `class:invoke:<classId>`. **Reserved per §9.50.9.1**
   * — non-grantable in Phase A/B/C. Manifest validation rejects this
   * capability today; the runtime guard throws `CapabilityNotGrantedError`
   * even if it slipped past validation.
   */
  invoke<TOutput = unknown>(payload: ClassInvokePayload): Promise<TOutput>;
}

// ── Jobs ─────────────────────────────────────────────────────────────

export interface JobSchedulePayload {
  /** Stable name for this scheduled job — tenant DB row keyed by (package, name). */
  name: string;
  /** Cron expression — tenant timezone applies. */
  cron: string;
  /** Class id within this package that the scheduler invokes. */
  classId: string;
  /** Optional input passed to the class on every invocation. */
  input?: Record<string, unknown>;
}

export interface JobEnqueuePayload {
  classId: string;
  input?: Record<string, unknown>;
  /** Optional delay in ms; defaults to immediate. */
  delayMs?: number;
}

export interface JobAPI {
  /** Requires capability `job:schedule`. Counts against tenant job quota. */
  schedule(payload: JobSchedulePayload): Promise<{ jobId: string }>;
  /** Requires capability `job:enqueue`. Counts against tenant job quota. */
  enqueue(payload: JobEnqueuePayload): Promise<{ jobId: string }>;
}

// ── Events (RESERVED per §9.50.9.1) ──────────────────────────────────

export interface EventEmitPayload {
  eventName: string;
  payload: Record<string, unknown>;
}

export interface EventListenPayload {
  /** Event name pattern — supports trailing `*` wildcard. */
  pattern: string;
  /** Class id this package wants to invoke when the event fires. */
  classId: string;
}

export interface EventAPI {
  /**
   * **Reserved per §9.50.9.1** — non-grantable in Phase A/B/C. The
   * capability string `event:emit` is reserved (no other capability
   * can squat it) but no manifest may declare it today. Listed here so
   * the runtime guard has a typed surface to refuse against.
   */
  emit(payload: EventEmitPayload): Promise<void>;
  /** **Reserved per §9.50.9.1** — see `emit`. */
  listen(payload: EventListenPayload): Promise<void>;
}

// ── HTTP / Webhooks ──────────────────────────────────────────────────

export interface HttpFetchPayload {
  /** Must match the tenant's egress allowlist; otherwise throws. */
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** JSON body — stringified by the runtime. */
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpFetchResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpAPI {
  /** Requires capability `http:fetch-allowlisted`. Counts against egress quota. */
  fetch(payload: HttpFetchPayload): Promise<HttpFetchResult>;
}

export interface WebhookSendPayload {
  /** Tenant-configured webhook destination id. */
  destinationId: string;
  eventName: string;
  payload: Record<string, unknown>;
}

export interface WebhookAPI {
  /** Requires capability `webhook:send`. Counts against webhook quota. */
  send(payload: WebhookSendPayload): Promise<{ deliveryId: string }>;
}

// ── Storage (package-scoped FS sandbox) ──────────────────────────────

export interface StorageReadPayload {
  /** Path within the package's sandbox — leading `/` optional. */
  path: string;
}

export interface StorageWritePayload {
  path: string;
  /** Body — string or Buffer; serialized per declared content type. */
  body: string | Buffer;
  contentType?: string;
}

export interface StorageAPI {
  /** Requires capability `storage:read`. */
  read(payload: StorageReadPayload): Promise<{ body: Buffer; contentType: string }>;
  /** Requires capability `storage:write`. Counts against tenant storage quota. */
  write(payload: StorageWritePayload): Promise<{ bytesWritten: number }>;
}

// ── Secrets (per-key grants) ─────────────────────────────────────────

export interface SecretReadPayload {
  /** Secret key as registered in the tenant's per-package vault. */
  key: string;
}

export interface SecretAPI {
  /** Requires capability `secret:read:<key>`. */
  read(payload: SecretReadPayload): Promise<{ value: string }>;
}

// ── Payment ──────────────────────────────────────────────────────────
//
// §9.67.3 PR-0c — reconciled from the original forward-declaration to the
// implemented contract (§9.67 billing). The money-flow invariant (§9.17) holds
// outside this shape: `payment:initiate` routes through the calling TENANT's
// own gateway account, never an xDeck-owned one (enforced host-side in
// `PaymentCapabilityService`). Offline gateways settle synchronously
// (`captured`); online gateways return `pending` + a `redirectUrl` and are
// confirmed via the status poll (PR-0b-ii) / the future webhook (PR-0b-iii).
//
// Reliability (§9.67.3 PR-0b-iii): `initiate` IS idempotent on retry when the
// caller passes `idempotencyKey` — the host keeps a (tenant, package, key)
// initiation ledger and a replay returns the RECORDED result instead of
// minting a second gateway order / double-capturing an offline charge.

export interface PaymentInitiatePayload {
  /**
   * Gateway id. `cash` / `manual-bank-transfer` are offline (synchronous).
   * `razorpay` / `phonepe` are online — each requires the tenant's own keys in
   * the §9.50 secret vault + a `returnUrl`.
   */
  gateway: 'cash' | 'manual-bank-transfer' | 'razorpay' | 'phonepe';
  /** Amount in MINOR units (paise/cents) — integer, penny-safe. */
  amountMinor: number;
  currency: string;
  /** The tenant's own invoice / order id this charge settles. */
  reference: string;
  /** Online-only: post-payment redirect target. Required for online gateways. */
  returnUrl?: string;
  /**
   * §9.67.3 PR-0b-iii — exactly-once initiate. Repeated calls with the same
   * key (per tenant+package) return the SAME recorded result; omit for
   * fire-once flows. Opaque caller string, ≤128 chars.
   */
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

export interface PaymentInitiateResult {
  gateway: string;
  /** `captured` (offline/settled) · `pending` (online, awaiting completion) · `failed`. */
  status: 'captured' | 'pending' | 'failed';
  amountMinor: number;
  currency: string;
  /** Gateway-side ref (order id / receipt ref) used to poll status + reconcile. */
  gatewayRef: string;
  capturedAt: string | null;
  /** Online-only: the gateway-hosted payment URL the customer is sent to; `null` offline. */
  redirectUrl?: string | null;
}

export interface PaymentStatusPayload {
  /** Online gateway id (offline charges are already terminal — no status to poll). */
  gateway: 'razorpay' | 'phonepe';
  /** The gateway ref returned by `initiate` (`PaymentInitiateResult.gatewayRef`). */
  gatewayRef: string;
}

export interface PaymentStatusResult {
  gateway: string;
  /**
   * `captured` · `pending` · `failed`, and §9.166 Step 5's `amount_mismatch`: the gateway
   * settled an amount that is NOT the amount this charge was initiated for (a partial
   * capture, or a figure that moved somewhere between the two). It is its own state rather
   * than a `captured` nobody checked or a `pending` that never resolves — the money needs a
   * person, and a caller that treats anything but `captured` as unpaid is still safe.
   */
  status: 'captured' | 'pending' | 'failed' | 'amount_mismatch';
  gatewayRef: string;
  /** Settled amount in minor units when the gateway reports it; else null. */
  amountMinor: number | null;
  /**
   * §9.166 Step 5 — what the charge was INITIATED for, when the kernel holds that record.
   * Null when it does not (a ref this package did not start through the kernel, or an
   * initiation that crashed after the gateway call), and then no comparison was possible.
   */
  initiatedAmountMinor?: number | null;
}

/**
 * §9.166 Step 5 part 4 — refund a payment this package took, through the DECK's own gateway
 * account. Requires the `payment:refund` capability, which is separate from `payment:initiate`
 * on purpose: taking money and giving it back are different grants.
 */
export interface PaymentRefundPayload {
  /** Online gateway id — an offline charge is refunded at the counter, not through a gateway. */
  gateway: 'razorpay' | 'phonepe';
  /** The gateway ref the charge was taken on (`PaymentInitiateResult.gatewayRef`). */
  gatewayRef: string;
  /**
   * The captured gateway payment id, when the caller has it. Razorpay refunds a PAYMENT, so a
   * refund without it falls back to the order ref; PhonePe refunds the merchant order.
   */
  gatewayPaymentId?: string;
  /**
   * How much to give back, in MINOR units. REQUIRED: there is no "refund everything" default,
   * because a caller that omitted the amount by accident would get exactly that.
   */
  amountMinor: number;
  /**
   * REQUIRED, unlike on `initiate`. A retried refund that minted a second one would pay the
   * customer twice: the key makes it exactly-once here AND at the gateway, which receives it.
   */
  idempotencyKey: string;
  /** Free-text reason, recorded with the refund. Never PII. */
  reason?: string;
}

export interface PaymentRefundResult {
  gateway: string;
  /** The gateway's refund id — the handle for reconciliation. */
  refundId: string;
  /** The gateway's own refund state, verbatim (`processed`, `pending`, …). */
  status: string;
  /** What was actually given back, in minor units. */
  amountMinor: number;
  gatewayRef: string;
  refundedAt: string;
}

/**
 * §9.171 L3 — one way this deck can take a payment right now. `id` is what `initiate` takes as
 * `gateway`; `label` is a name a person reads; `mode` says whether the money moves through a
 * gateway (`online`) or is taken at the counter (`offline`). Never a key, an account id or a
 * mode detail (live or test).
 */
export interface PaymentGatewayOption {
  id: string;
  label: string;
  mode: 'online' | 'offline';
}

export interface PaymentAPI {
  /**
   * Requires capability `payment:initiate`. Routes through the tenant's OWN
   * gateway account (never xDeck's). Offline → `captured`; online → `pending`
   * + `redirectUrl`.
   */
  initiate(payload: PaymentInitiatePayload): Promise<PaymentInitiateResult>;
  /**
   * Poll an online charge's settlement status. Gated by the SAME
   * `payment:initiate` capability (read-only, same money domain + tenant keys).
   * CONSERVATIVE: only `captured` once the gateway confirms paid.
   */
  status(payload: PaymentStatusPayload): Promise<PaymentStatusResult>;
  /**
   * Requires capability `payment:refund`. Gives money back through the deck's OWN gateway
   * account, exactly once per `idempotencyKey`. Refusals: a payload naming a deck ledger
   * invoice (that is `invoice.refund`, which records the credit note first), a non-positive
   * amount, and — per §9.166 Step 5 chunk 5.2 — live credentials on any non-production
   * environment.
   */
  refund(payload: PaymentRefundPayload): Promise<PaymentRefundResult>;
  /**
   * Requires `payment:initiate`. The gateways this deck can take a payment through right now:
   * each online gateway whose credentials resolve for the calling package on this deck
   * environment (the same resolution `initiate` uses, so an offered gateway is one `initiate`
   * accepts), then the offline ones. Never a key, an account id or a mode detail.
   */
  gateways(): Promise<PaymentGatewayOption[]>;
}

// ── Binding (§9.82.2 PR-3 — signed-binding primitive) ───────────────
//
// A KIND-parameterized sign/verify primitive for offline-verifiable opaque
// tokens that bind a real-world anchor (a printed table QR, a device-pairing
// code, a queue token) to a tenant-scoped claim set. The HOST signs with a
// PER-TENANT key it derives server-side (HKDF over the platform binding
// secret) — package code NEVER sees key material, and a token minted under
// tenant A structurally cannot verify under tenant B (verification recomputes
// with the claimed tenant's key). `deckId` is stamped into the claims by
// the host from the GuardContext, never taken from the caller.
//
// Verification is pure CPU (no DB/network) so an ADR-0010 edge-deck can
// verify table QRs with the WAN down. Revocation is the CALLER's domain:
// claims carry whatever version field the package compares against its own
// rows (e.g. Table.qrVersion) — no platform token store.

export interface BindingSignPayload {
  /** Binding kind (lowercase token, e.g. `table`). Capability: `binding:sign:<kind>`. */
  kind: string;
  /**
   * Caller claims to embed (e.g. `{ outletId, tableId, ver }`). String/number
   * values only — the token is a compact printed artifact, not a data bag.
   * The host ADDS `deckId` from ctx; a caller-supplied deckId is rejected.
   */
  claims: Record<string, string | number>;
  /** Optional TTL. Omit for long-lived printed bindings (table QRs). */
  expiresInSeconds?: number;
}

export interface BindingSignResult {
  /** Opaque token (`v1.<kid>.<payload-b64url>.<mac-b64url>`) — QR-encodable. */
  token: string;
  kind: string;
}

export interface BindingVerifyPayload {
  /** Expected kind — a `table` verifier rejects a token minted as another kind. */
  kind: string;
  token: string;
}

export interface BindingVerifiedClaims {
  kind: string;
  /** The tenant the token was minted under (from the SIGNED payload). */
  deckId: string;
  /** The caller claims exactly as signed (e.g. `{ outletId, tableId, ver }`). */
  claims: Record<string, string | number>;
  signedAt: string;
  expiresAt: string | null;
}

export interface BindingAPI {
  /**
   * Requires capability `binding:sign:<kind>`. Mints a signed opaque token
   * over `claims` + the ctx tenant. The signing key never leaves the host.
   */
  sign(payload: BindingSignPayload): Promise<BindingSignResult>;
  /**
   * Requires capability `binding:verify:<kind>`. FAIL CLOSED: malformed,
   * tampered, wrong-kind, expired, or cross-tenant tokens all throw a stable
   * `BINDING_INVALID` — callers never see why a forgery failed.
   */
  verify(payload: BindingVerifyPayload): Promise<BindingVerifiedClaims>;
}

// ── Telemetry ────────────────────────────────────────────────────────
//
// §9.50 RA-bridge — sandboxed package code emits events via
// `xdeck.telemetry.{track|identify|page}(...)`. Events flow through the
// same RA5 validator the HTTP `/ingest` endpoint uses (declared-only
// enforcement in strict mode; always-on payload-schema gate). Provider
// implementation lives in `standard/telemetry`; consumer packages
// declare `capabilities.required: ['telemetry:track', ...]`.

export interface TelemetryTrackPayload {
  /**
   * Event name — must match the calling package's `manifest.telemetry.
   * events.<eventName>` declaration. RA5 validator looks the schema up
   * by name + AJV-validates the `props` shape; mismatches reject with
   * `payload_schema_mismatch` and never persist.
   */
  eventName: string;
  /**
   * Per-event property bag — shape governed by the declared JSON
   * Schema in the manifest. Server-side PII scrubber runs after the
   * RA5 gate.
   */
  props?: Record<string, unknown>;
  /**
   * Optional route hint — defaults to a server-side `'<sandbox>'`
   * sentinel when omitted (sandbox code rarely has a meaningful route).
   */
  route?: string;
}

export interface TelemetryTrackResult {
  /** True when the event passed RA5 validation + was persisted. False on a validation drop or a store failure. */
  accepted: boolean;
  /**
   * On drop, the RA5 result code — `unregistered`, `ambiguous`,
   * `payload_schema_mismatch` — or `storage_unavailable` when the deck's
   * telemetry store refused the write. Lets sandboxed callers surface the
   * failure mode in their own logs / UI. A drop is never thrown: an event is
   * best-effort, so it must not fail the operation it describes.
   */
  dropReason?: 'unregistered' | 'ambiguous' | 'payload_schema_mismatch' | 'storage_unavailable';
}

export interface TelemetryIdentifyPayload {
  /**
   * Tenant-owned opaque user identifier (DB PK / UUID) — NEVER raw PII
   * per the §9.72 contract. The server-side PII scrubber's deny-list
   * always wins regardless.
   */
  userId: string;
  /**
   * Identify-time traits — intersected against the tenant's
   * `allowedTraitKeys` config at scrub time. Anything outside the
   * allowlist (or in the deny-list) drops silently.
   */
  traits?: Record<string, unknown>;
}

export interface TelemetryIdentifyResult {
  accepted: boolean;
  dropReason?: 'unregistered' | 'ambiguous' | 'payload_schema_mismatch' | 'storage_unavailable';
}

export interface TelemetryPagePayload {
  /** Route or page identifier (e.g. `/clinic/booking` or `appointment-confirm`). */
  route: string;
  /** Optional metadata (referrer, navigation timing, etc.). */
  props?: Record<string, unknown>;
}

export interface TelemetryPageResult {
  accepted: boolean;
  dropReason?: 'unregistered' | 'ambiguous' | 'payload_schema_mismatch' | 'storage_unavailable';
}

export interface TelemetryAPI {
  /** Requires capability `telemetry:track`. */
  track(payload: TelemetryTrackPayload): Promise<TelemetryTrackResult>;
  /** Requires capability `telemetry:identify`. */
  identify(payload: TelemetryIdentifyPayload): Promise<TelemetryIdentifyResult>;
  /** Requires capability `telemetry:page`. */
  page(payload: TelemetryPagePayload): Promise<TelemetryPageResult>;
}

// ── Consumer (§9.146 — vertical-neutral §9.61 link primitive) ────────
//
// The ONE way a vertical package (restroin, clinicloud, …) records "this
// tenant engages this ClienX consumer": an idempotent find-or-create of the
// §9.61 CORE `customer_links` row in the calling tenant's own DB, plus the
// best-effort ClienX-side directory mirror ("my services"). The package
// never owns a link table of its own — one canonical store, so the §9.61
// read-path (`hasLink` authorization, consent-filtered name resolution,
// consumer directory, revoke) sees every vertical's engagements.
//
// **Scope is host-stamped.** `deckId` comes from the GuardContext, never
// the payload — a package cannot link a consumer into another tenant.
//
// **No PII.** The payload carries ClienX ids only; name/phone/email live in
// ClienX (§9.61 single-SoR) and are resolved at read time, never persisted
// tenant-side.
//
// **Subject, never actor.** When the engagement is about a family dependent,
// `subjectDependentId` carries the §9.61 Q5 SUBJECT. When it is about
// another full ClienX user, the caller passes THAT user as `clienxUserId`
// (the link belongs to the subject's own identity) and records the session
// owner in `actorUserId` — audit attribution only, never a join key.

export interface ConsumerEnsureLinkPayload {
  /** §9.61 ClienX User id the engagement is ABOUT (the link's identity). */
  clienxUserId: string;
  /** §9.61 Q5 SUBJECT when the engagement is on a dependent's behalf; omit/null = self. */
  subjectDependentId?: string | null;
  /**
   * §9.61 engagement ACTOR — the ClienX session owner who caused the
   * engagement, when different from `clienxUserId`. Audit attribution ONLY;
   * the host never joins on it. Omit/null when the subject acted for
   * themselves.
   */
  actorUserId?: string | null;
}

export interface ConsumerEnsureLinkResult {
  /** The §9.61 core `customer_links` row id — stamp this on vertical records (orders, encounters). */
  customerLinkId: string;
  /** True when this call created the link (first engagement); false on an idempotent replay. */
  created: boolean;
}

/**
 * §9.91.13 PR-2 — a deck's desk asserts a dependant into a consumer's family graph.
 *
 * **This payload carries PII in transit.** Unlike `ensureLink`, the dependant's name, DOB
 * and contact cross here — to ClienX, the single SoR, and nowhere else. The host never
 * stores them deck-side and never logs them; the deck keeps only the returned id.
 *
 * **Assert, never list.** The result is ONE id: an existing dependant under the holder
 * matched by phone or by first name + DOB, else a new one. A deck cannot learn who else is
 * on the holder's list.
 *
 * **A claim, not standing.** The row lands `pending` for the holder to confirm or reject;
 * until confirmed, nobody gains standing over the dependant's records through it.
 */
export interface ConsumerAssertDependantPayload {
  /** §9.61 ClienX User id of the ACCOUNT HOLDER the dependant belongs to. */
  clienxUserId: string;
  /** child | spouse | parent | sibling | dependent | other — the holder's relation TO the dependant. */
  relation: string;
  firstName: string;
  lastName?: string | null;
  /** YYYY-MM-DD. Together with firstName it is a match key; alone it is not. */
  dob?: string | null;
  /** male | female | other | unknown */
  gender?: string | null;
  /** A match key on its own. */
  phone?: string | null;
  email?: string | null;
}

export interface ConsumerAssertDependantResult {
  /** Use as `subjectDependentId` in `ensureLink` — the SUBJECT the deck's record is about. */
  dependentId: string;
  /** An existing dependant under the holder matched; nothing was created. */
  matched: boolean;
  created: boolean;
}

/**
 * §9.91.13 PR-3b-ii — a consumer updates THEIR OWN demographics through the deck they are
 * signed in to. The subject is the verified session's link (host-stamped on the actor); any
 * identity in this payload is REFUSED, not ignored. `phone` and `email` are absent by design —
 * phone is the resolve key for claims and merges and changes only by proof. Each field is
 * optional; an empty string clears `lastName`, `dateOfBirth` or `gender`.
 */
export interface ConsumerUpdateOwnProfilePayload {
  firstName?: string;
  lastName?: string;
  /** YYYY-MM-DD. A verified date of birth is not self-editable (refused). */
  dateOfBirth?: string;
  /** male | female | other | unknown */
  gender?: string;
}

export interface ConsumerUpdateOwnProfileResult {
  /** Whether the session's link is the holder themselves or a dependant the holder acts for. */
  subject: 'self' | 'dependant';
  /** Field names written — never values. */
  changed: string[];
}

export interface ConsumerAPI {
  /**
   * Requires capability `consumer:link`. Idempotent find-or-create of the
   * calling tenant's §9.61 engagement edge to a ClienX consumer (+ the
   * best-effort ClienX directory mirror). Re-engaging an existing link
   * re-activates it and bumps `lastEngagedAt`.
   */
  ensureLink(payload: ConsumerEnsureLinkPayload): Promise<ConsumerEnsureLinkResult>;
  /**
   * Requires capability `consumer:assert-dependant`. Assert a dependant into the
   * holder's family graph from this deck's desk; returns one id to file the record
   * under. See {@link ConsumerAssertDependantPayload}.
   */
  assertDependant(payload: ConsumerAssertDependantPayload): Promise<ConsumerAssertDependantResult>;
  /**
   * Requires capability `consumer:profile-write`, AND a consumer principal on the
   * invocation (refused for any other principal). See {@link ConsumerUpdateOwnProfilePayload}.
   */
  updateOwnProfile(payload: ConsumerUpdateOwnProfilePayload): Promise<ConsumerUpdateOwnProfileResult>;
}

// ── Config (own-install settings) ────────────────────────────────────

/**
 * §9.52 — read-only access to the CALLING package's own per-install
 * settings (the non-secret `configSchema` / `settingsSchema` values an
 * owner/admin set through §9.80 `PackageSettingsService`).
 *
 * **Identity-scoped, no capability.** Like `xdeck.context`, this reads
 * only the requesting package's OWN install config for its OWN tenant —
 * both `(deckId, namespace, name)` come from the parent-supplied
 * `XDeckContext`, never the payload. A package can never read another
 * package's config nor another tenant's. So it is non-grantable: there
 * is nothing cross-boundary to gate. The static analyzer skips
 * `xdeck.config.*` for the same reason it skips `xdeck.context.*`.
 *
 * **Secrets never surface here.** `PackageSettingsService` splits secret
 * fields into the encrypted vault (gated by `secret:read:<key>`); only
 * non-secret values are returned. A package needing a secret value still
 * goes through `xdeck.secret.read({ key })`.
 *
 * **Defaults applied.** Unset non-secret fields resolve to the
 * `configSchema` default, so a job reading a value that the tenant never
 * touched still gets the documented default (e.g. `memory_retention_days`
 * → 365) rather than `undefined`.
 */
export interface ConfigGetResult {
  /**
   * Non-secret config values keyed by field key, with schema defaults
   * applied for unset fields. Secret fields are absent (use
   * `xdeck.secret.read`). `null` when the package has no settings schema.
   */
  values: Record<string, unknown>;
}

export interface ConfigAPI {
  /**
   * The calling package's own non-secret install settings (schema
   * defaults applied). No payload — the (tenant, package) identity is
   * the parent-supplied context. No capability required.
   */
  get(): Promise<ConfigGetResult>;
}

// ── Integrator (an integration handler's one door out) ───────────────

/** The verbs a callout may use. */
export type IntegratorCalloutMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * §9.169 — `xdeck.integrator.callout(...)`: one request to a partner through one of
 * the integrator's connectors. The connector's address, credential, retry policy and
 * rate limit are the connector's own and the platform applies them: the class names
 * the connector and a path, and never sees the credential.
 */
export interface IntegratorCalloutPayload {
  /** The id of a connector of the integrator this handler belongs to. Another integrator's is "not found". */
  connector: string;
  method: IntegratorCalloutMethod;
  /**
   * A path under the connector's address, starting with `/`; `''` is the address
   * itself. Never a URL: a scheme, a host or a `//` prefix is refused.
   */
  path: string;
  /** Query parameters, added to the address; at most 64. */
  query?: Record<string, string>;
  /**
   * Request headers by name (lower-cased when sent); at most 32, each a one-line
   * value. `host`, `content-length`, `transfer-encoding`, `connection`,
   * `authorization` and `cookie` are refused: the credential is the connector's,
   * and the platform attaches it.
   */
  headers?: Record<string, string>;
  /**
   * A string is sent as UTF-8; an object or an array is JSON-encoded, with
   * `content-type: application/json` unless the class set one. At most 256 KiB.
   */
  body?: string | Record<string, unknown> | unknown[];
}

/**
 * What became of a callout. `ok` is the one word for a 2xx (or 304) answer; every
 * other word is a partner's refusal or failure, a limit, or a transport failure —
 * ANSWERED, never thrown, so the class decides what a 404 or a timeout means for its
 * run. A refusal of the call itself (no run, an unknown connector, a URL for a path, a
 * forbidden header, a body over the bound, the run's callout limit) is thrown with
 * `code === 'INTEGRATOR_CALLOUT_REFUSED'`.
 */
export type IntegratorCalloutOutcome =
  | 'ok'
  | 'partner_refused'
  | 'auth_refused'
  | 'rate_limited'
  | 'partner_failed'
  | 'redirect_refused'
  | 'timeout'
  | 'network_error'
  | 'tls_failed'
  | 'dns_failed'
  | 'address_refused'
  | 'origin_refused'
  | 'response_too_large'
  | 'daily_cap'
  | 'connector_rate_limited'
  | 'not_ready'
  | 'unbound'
  | 'credential_unusable'
  | 'token_failed'
  | 'plane_refused'
  | 'error';

export interface IntegratorCalloutResult {
  outcome: IntegratorCalloutOutcome;
  /** The partner's status; `null` when no answer came. */
  status: number | null;
  /**
   * The partner's answer headers by lower-case name, only these: `content-type`,
   * `content-length`, `etag`, `last-modified`, `location`, `retry-after`,
   * `x-request-id`, `date`.
   */
  headers: Record<string, string>;
  /** The answer's body (at most 1 MiB): text when it is UTF-8, else base64. `null` when none came. */
  body: { encoding: 'utf8' | 'base64'; text: string } | null;
  /** Tries made at the connector's address under its retry policy. */
  attempts: number;
  /** When the partner or a limit said to wait, in seconds. */
  retryAfterSeconds: number | null;
}

/** The integrator's settings: non-secret values a person changes without a release (a store id, a mapping). */
export type IntegratorSettingsResult = Record<string, unknown>;

/**
 * §9.169 — what an integration handler class reaches its partner with. **Identity-scoped,
 * no capability**: the authority is the handler RUN the platform started (parent-set,
 * never from the payload), so only an integration class inside a run can call these;
 * any other class is refused with `INTEGRATOR_CALLOUT_REFUSED`, and so is a class on
 * an on-site deck ("Integrations run on the online deck.").
 *
 * Every callout is counted against the deck's day, the connector's minute and the
 * run's own ceiling (a plan number); the call past that ceiling is refused.
 */
export interface IntegratorAPI {
  /** One request to a partner through a connector of this handler's integrator. See {@link IntegratorCalloutPayload}. */
  callout(payload: IntegratorCalloutPayload): Promise<IntegratorCalloutResult>;
  /** This handler's integrator's settings, as a copy. No payload. */
  settings(): Promise<IntegratorSettingsResult>;
}

// ── The runtime global ───────────────────────────────────────────────

/**
 * The shape of the `xdeck` global the sandbox injects into every
 * executing package class. Slice 3 (runtime guard layer) provides the
 * implementation; Slice 12 (test harness) provides a typed mock.
 *
 * Adding a new domain here is a major-version event — packages compile
 * against this shape, and missing methods break installed packages.
 * New methods within an existing domain are minor (additive).
 */
export interface XDeckRuntime {
  notification: NotificationAPI;
  email: EmailAPI;
  sms: SmsAPI;
  whatsapp: WhatsAppAPI;
  push: PushAPI;
  ai: AIAPI;
  template: TemplateAPI;
  entity: EntityAPI;
  /** Reserved per §9.50.9.1 — non-grantable in Phase A/B/C. */
  class: ClassAPI;
  job: JobAPI;
  /** Reserved per §9.50.9.1 — non-grantable in Phase A/B/C. */
  event: EventAPI;
  http: HttpAPI;
  webhook: WebhookAPI;
  storage: StorageAPI;
  secret: SecretAPI;
  payment: PaymentAPI;
  /** §9.82.2 PR-3 — kind-parameterized signed-binding primitive. */
  binding: BindingAPI;
  /** §9.50 RA-bridge — `track`/`identify`/`page` for sandboxed code. */
  telemetry: TelemetryAPI;
  /** §9.146 — vertical-neutral §9.61 consumer-link primitive (`consumer:link`). */
  consumer: ConsumerAPI;
  /**
   * §9.52 — read-only access to the calling package's OWN per-install
   * settings (identity-scoped, no capability — see {@link ConfigAPI}).
   */
  config: ConfigAPI;
  /**
   * §9.166 Step 6 — the deck↔consumer invoice ledger (see {@link InvoiceAPI}). Two keys per
   * call: the package's `invoice:*` capability and the person's `deck_invoices:*` permission.
   */
  invoice: InvoiceAPI;
  /**
   * §9.169 — an integration handler's door to its integrator's connectors and settings
   * (identity-scoped: the authority is the parent-set handler run — see {@link IntegratorAPI}).
   */
  integrator: IntegratorAPI;
  context: XDeckContext;
}

/**
 * §9.156 — `xdeck.rbac.read()`. Takes no arguments by design.
 *
 * The two things that scope the answer — which deck, and which actor — are
 * host-stamped from the verified `GuardContext`. There is deliberately no
 * `deckId` or `userId` field: accepting either would let a package ask about a
 * deck or a person it is not acting for, which is the tenant-isolation bypass
 * this seam exists to make impossible rather than merely discouraged.
 */
export type RbacReadPayload = Record<string, never>;

/**
 * The authorization facts a vertical needs to render a correct surface.
 *
 * `permissions` is the acting user's EFFECTIVE set (role grants unioned with
 * active permission-set grants) — the same resolution the deck's own session
 * uses, so a package and the platform can never disagree about what someone may
 * do. `roles` is the deck's role vocabulary, so a package can label and group
 * without forking a private role table.
 *
 * What is NOT here: any other user's permissions, and any grant-mutation
 * affordance. A package can learn what THIS caller may do; it cannot enumerate
 * the deck's people or change anyone's access.
 */
export interface RbacReadResult {
  /** Effective permission strings for the acting user, e.g. `orders:read`. */
  permissions: string[];
  /** True when the actor holds the deck's unconstrained owner/admin tier. */
  isFullAccess: boolean;
  /** The deck's role vocabulary — id + name + priority, nothing sensitive. */
  roles: Array<{ id: string; name: string; priority: number | null }>;
}

/**
 * §9.156 — `xdeck.scope.read()`. Empty by design: the deck and the acting user
 * are host-stamped from the verified GuardContext.
 */
export type ScopeReadPayload = Record<string, never>;

/** One record scope the caller may work in. */
export interface ScopeReadOption {
  id: string;
  label: string;
}

/**
 * The deck's record-scope descriptor, in the VERTICAL's own vocabulary.
 *
 * `scope: null` means the deck runs no scope-partitioned package — deliberately
 * distinct from a descriptor with an empty `options`, which means "you were
 * granted none". A caller that conflates the two renders an empty switcher for a
 * deck that simply has no scopes.
 */
export interface ScopeReadResult {
  scope: {
    /** The vertical's word for its partition (`outlet`, `facility`). */
    scopeKey: string;
    label: string;
    qualifiedName: string;
    /** True ⇒ deck owner/admin: every scope is available. */
    unconstrained: boolean;
    options: ScopeReadOption[];
  } | null;
}

/**
 * Minimum runtime-API version a package needs. Packages declare this
 * in their manifest via `runtimeApi: ">=1.0.0"`. Install refuses
 * incompatible packages. The host bumps this when it adds methods to
 * domains.
 */
export const RUNTIME_API_VERSION = '0.1.0' as const;
