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

/**
 * Always-available identity context. No capability needed — every
 * package class can read `xdeck.context` regardless of grants.
 *
 * Provided by the sandbox at construction; `traceId` / `spanId` are
 * minted per top-level invocation so capability calls correlate with
 * the originating trigger / cron / endpoint.
 */
export interface XDeckContext {
  tenantId: string;
  tenantSlug: string;
  /** Deployment environment of the host — `'dev' | 'uat' | 'prod'`. */
  env: 'dev' | 'uat' | 'prod';
  package: {
    namespace: string;
    name: string;
    version: string;
  };
  /** Stable per top-level invocation; spans across all capability calls. */
  traceId: string;
  /** Stable per capability call within a trace. */
  spanId: string;
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

export interface WhatsAppSendPayload {
  to: string;
  templateId: string;
  data: Record<string, unknown>;
}

export interface WhatsAppAPI {
  /** Requires capability `whatsapp:send`. Counts against WA quota + cost. */
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

export interface EntityWritePayload {
  entityName: string;
  /** Operation kind — insert/update/delete. */
  op: 'insert' | 'update' | 'delete';
  /** For insert/update: row data. For delete: ignored. */
  data?: Record<string, unknown>;
  /** For update/delete: where clause. For insert: ignored. */
  where?: Record<string, unknown>;
}

export interface EntityAPI {
  /** Requires capability `entity:read:<entityName>`. */
  read<TRow = Record<string, unknown>>(payload: EntityReadPayload): Promise<TRow[]>;
  /** Requires capability `entity:write:<entityName>`. */
  write(payload: EntityWritePayload): Promise<{ affected: number }>;
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

export interface PaymentInitiatePayload {
  amount: number;
  currency: string;
  /** Idempotency key — repeated calls with the same key return the same flow. */
  idempotencyKey: string;
  /** Tenant-defined metadata for the payment row. */
  metadata?: Record<string, unknown>;
}

export interface PaymentInitiateResult {
  /** Provider checkout url for the user to complete the payment. */
  checkoutUrl: string;
  /** Server-minted id for the persisted payment-flow row. */
  flowId: string;
}

export interface PaymentAPI {
  /** Requires capability `payment:initiate`. */
  initiate(payload: PaymentInitiatePayload): Promise<PaymentInitiateResult>;
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
  context: XDeckContext;
}

/**
 * Minimum runtime-API version a package needs. Packages declare this
 * in their manifest via `runtimeApi: ">=1.0.0"`. Install refuses
 * incompatible packages. The host bumps this when it adds methods to
 * domains.
 */
export const RUNTIME_API_VERSION = '0.1.0' as const;
