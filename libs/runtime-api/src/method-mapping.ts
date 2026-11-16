/**
 * §9.50 Phase B Slice 7 — canonical mapping from a worker-side method
 * call (`xdeck.<domain>.<method>(...)`) to the capability the runtime
 * guard checks parent-side.
 *
 * **Why this lives in `@xdeck/runtime-api`.** Both the static analyzer
 * (`CapabilityStaticAnalyzerService`) and the install-time validator
 * (`PackageValidatorService`) consume this; future consumers (CI
 * `validate-on-tag.yml` driver, marketplace docs renderer) will too.
 * Co-locating it with the capability catalogue + manifest validator
 * (Slice 1) means adding a new capability is one mapping entry here
 * plus the matching wrapper/host change — no drift across multiple lib
 * boundaries.
 *
 * **The three kinds of mapping:**
 *  1. `static` — `xdeck.email.send(payload)` → `'email:send'`. The
 *     capability string is fixed regardless of arguments.
 *  2. `parameterized` — `xdeck.entity.read({entityName: 'Patient'})` →
 *     `'entity:read:Patient'`. The capability resource id comes from a
 *     named property in the first argument; the analyzer extracts the
 *     literal value (non-literal → unresolvable).
 *  3. `reserved` — `xdeck.event.emit(...)` / `xdeck.class.invoke(...)`.
 *     Per §9.50.9.1 these are reserved and non-grantable today. The
 *     analyzer still records them as used; the validator (Slice 2's
 *     reservation check) rejects them.
 *
 * **`xdeck.context.<field>`** — reads from the always-available identity
 * context. No capability needed; the analyzer skips any PropertyAccess
 * whose first member is `context`.
 */

import type { Capability, ParameterizedCapabilityFamily, StaticCapability } from './capability';

export type XdeckMethodMapping =
  | {
      kind: 'static';
      capability: StaticCapability;
      /**
       * §9.166 Step 6 — further capabilities the SAME call needs, checked and audited by the
       * host wrapper and reported as used by the static analyzer at the call site. Additive
       * on purpose rather than a new `kind`: every existing consumer branches on `kind`, and
       * one that did not know a new kind would fall into the parameterized branch. A reader
       * that ignores this field still sees the primary capability correctly; only a publish
       * check needs the full list, and that is {@link capabilitiesForMethodCall}.
       */
      alsoRequires?: readonly StaticCapability[];
    }
  | { kind: 'parameterized'; family: ParameterizedCapabilityFamily; argKey: string }
  | { kind: 'reserved'; capability: string };

/**
 * Every `xdeck.<domain>.<method>` shape known to the §9.50 contract.
 * Keys are dotted `<domain>.<method>` strings (the same format
 * `XdeckHostService.handlers` uses on the wire).
 *
 * Adding a method = adding an entry here + the matching wrapper +
 * (for static / parameterized) a dispatch table entry in the host.
 */
export const XDECK_METHOD_MAP = {
  // ── Static — fixed capability per method ───────────────────────────
  'email.send': { kind: 'static', capability: 'email:send' },
  'sms.send': { kind: 'static', capability: 'sms:send' },
  'whatsapp.send': { kind: 'static', capability: 'whatsapp:send' },
  'push.send': { kind: 'static', capability: 'push:send' },
  'notification.send': { kind: 'static', capability: 'notification:send-in-app' },
  'notification.broadcast': { kind: 'static', capability: 'notification:broadcast' },
  'ai.complete': { kind: 'static', capability: 'ai:complete' },
  'ai.embed': { kind: 'static', capability: 'ai:embed' },
  // §9.158 (moved out of (core) 2026-08-26) — build the calling deck's daily business digest.
  // The PACKAGE owns whether and when (its own cron, registered at install); the KERNEL owns how,
  // and does the aggregation inside Postgres so a deck's business rows never enter the sandbox.
  // Same posture as `ai:complete`: a package does not implement inference, and it does not
  // implement a cross-entity aggregate over records it holds no entity:read grant for either.
  'ai.digestBuild': { kind: 'static', capability: 'ai:digest-build' },
  'ai.agentInvoke': { kind: 'static', capability: 'ai:agent-invoke' },
  'ai.knowledgeQuery': { kind: 'static', capability: 'ai:knowledge-query' },
  'template.render': { kind: 'static', capability: 'template:render' },
  'job.schedule': { kind: 'static', capability: 'job:schedule' },
  'job.enqueue': { kind: 'static', capability: 'job:enqueue' },
  'http.fetch': { kind: 'static', capability: 'http:fetch-allowlisted' },
  'webhook.send': { kind: 'static', capability: 'webhook:send' },
  'storage.read': { kind: 'static', capability: 'storage:read' },
  'storage.write': { kind: 'static', capability: 'storage:write' },
  'payment.initiate': { kind: 'static', capability: 'payment:initiate' },
  // §9.67.3 PR-0b-ii — status poll shares the `payment:initiate` gate
  // (read-only, same money domain). A dedicated `payment:status` capability
  // can split this later (additive).
  'payment.status': { kind: 'static', capability: 'payment:initiate' },
  // §9.171 L3 — the gateways this deck can take a payment through, on the same gate: what
  // `initiate` would accept, read before a charge (never a key or an account id).
  'payment.gateways': { kind: 'static', capability: 'payment:initiate' },
  // §9.166 Step 5 part 4 — its OWN capability, not `payment:initiate`: taking money and giving
  // it back are different grants, and a package that only charges must not gain the second by
  // holding the first.
  'payment.refund': { kind: 'static', capability: 'payment:refund' },
  // §9.50 RA-bridge / §9.94 B2 — sandbox telemetry. These ARE live + host-wired
  // (TelemetryCapabilityService.{track,identify,page}With → ensureGranted), but were
  // MISSING from this map: the static analyzer + install validator therefore could not
  // map `xdeck.telemetry.track()` → `telemetry:track`, so a package that called
  // telemetry without declaring the capability slipped publish-time detection and only
  // failed at runtime. Added here so enforcement is caught at publish time (§9.94 B2).
  'telemetry.track': { kind: 'static', capability: 'telemetry:track' },
  'telemetry.identify': { kind: 'static', capability: 'telemetry:identify' },
  'telemetry.page': { kind: 'static', capability: 'telemetry:page' },
  // §9.146 — vertical-neutral consumer-link primitive: establish the §9.61 CORE
  // customer_links engagement edge (idempotent find-or-create + ClienX directory
  // mirror) for the calling tenant. Host stamps deckId from ctx — the payload
  // never carries scope.
  'consumer.ensureLink': { kind: 'static', capability: 'consumer:link' },
  // §9.91.13 PR-2 — assert a dependant into the holder's family graph (claim, pending review).
  // The asserting deck is host-stamped from ctx; the payload names the holder + the dependant.
  'consumer.assertDependant': { kind: 'static', capability: 'consumer:assert-dependant' },
  // §9.91.13 PR-3b-ii — a consumer's own demographics; subject = the actor's link, never the payload.
  'consumer.updateOwnProfile': { kind: 'static', capability: 'consumer:profile-write' },
  // §9.156 — read the authorization facts that apply here: the acting user's
  // effective permissions + the deck's role vocabulary. Both scoping inputs
  // (deck, actor) are host-stamped from ctx; the payload is empty by design, so
  // a package cannot ask about a deck or a person it is not acting for.
  'rbac.read': { kind: 'static', capability: 'rbac:read' },
  // §9.156 — which record scopes this caller may work in, in the vertical's own
  // vocabulary. Same host-stamped scoping as rbac.read; empty payload by design.
  'scope.read': { kind: 'static', capability: 'scope:read' },

  // §9.166 Step 6 — the deck invoice ledger. The capability is the PACKAGE key; every
  // call also needs the acting person's `deck_invoices:*` permission (the wrapper asks the
  // §9.167 resolver), so a grant alone moves no money. All four capabilities ship DARK
  // (SHIP_DARK_CAPABILITIES) until owner decision 19 lifts them.
  'invoice.quote': { kind: 'static', capability: 'invoice:issue' },
  'invoice.issue': { kind: 'static', capability: 'invoice:issue' },
  'invoice.get': { kind: 'static', capability: 'invoice:read' },
  'invoice.list': { kind: 'static', capability: 'invoice:read' },
  'invoice.changes': { kind: 'static', capability: 'invoice:read' },
  'invoice.summary': { kind: 'static', capability: 'invoice:read' },
  // §9.166 part 12b-p — one invoice's payments, through the same walls as invoice.get. A read, so a box answers too.
  'invoice.payments': { kind: 'static', capability: 'invoice:read' },
  'invoice.recordTender': { kind: 'static', capability: 'invoice:settle' },
  'invoice.reconcileTender': { kind: 'static', capability: 'invoice:settle' },
  // Money OUT and document cancellation share the credit capability; the person-side
  // permissions (`:void`, `:credit`, `:refund`) are what separate them.
  'invoice.void': { kind: 'static', capability: 'invoice:credit' },
  'invoice.credit': { kind: 'static', capability: 'invoice:credit' },
  'invoice.recordOfflineRefund': { kind: 'static', capability: 'invoice:credit' },
  // Online money: recording it against an invoice AND starting a gateway charge, so both keys.
  // One door — `payment.initiate` carrying an `invoiceId` is refused and points here, because
  // the ledger must record money in flight before the gateway is ever called.
  'invoice.collectOnline': { kind: 'static', capability: 'invoice:settle', alsoRequires: ['payment:initiate'] },
  // Pull the gateway's word on a charge this app started. Settles through the same path as the
  // webhook and the reconciler, so it needs the settle key only.
  'invoice.confirmPayment': { kind: 'static', capability: 'invoice:settle' },
  // §9.166 cluster 6 — money OUT through the gateway: the ledger key AND the payment key, so a
  // package that can credit an invoice cannot also send the money back unless it was granted that.
  'invoice.refund': { kind: 'static', capability: 'invoice:credit', alsoRequires: ['payment:refund'] },
  // `invoice.refund` is NOT here yet, deliberately: it needs `invoice:credit` AND `payment:refund`,
  // and `payment:refund` does not exist until §9.166 Step 5. Mapping it with only the first would
  // let a package pass install on a declaration that becomes incomplete the day Step 5 lands.
  // Until then a call to it is an unknown method at publish time, which is the honest answer.
  // TODO(§9.166 Step 5).

  // ADR-0035 — read AS the person who delegated it. Static on purpose: the record type is named
  // by the person's delegation, which the host checks on every call, not by the manifest — so a
  // computed `entityName` here is bounded by the delegation and is not a dynamic resource id.
  'entity.readAs': { kind: 'static', capability: 'entity:read-delegated' },

  // ── Parameterized — resource id extracted from first arg ────────────
  'entity.read': { kind: 'parameterized', family: 'entity:read', argKey: 'entityName' },
  'entity.write': { kind: 'parameterized', family: 'entity:write', argKey: 'entityName' },
  'secret.read': { kind: 'parameterized', family: 'secret:read', argKey: 'key' },
  // §9.82.2 PR-3 — signed-binding primitive, parameterized per binding KIND
  // (table QRs today; device-pairing / queue tokens are future kinds).
  'binding.sign': { kind: 'parameterized', family: 'binding:sign', argKey: 'kind' },
  'binding.verify': { kind: 'parameterized', family: 'binding:verify', argKey: 'kind' },

  // ── Reserved per §9.50.9.1 — recorded so the analyzer surfaces them ──
  'class.invoke': { kind: 'reserved', capability: 'class:invoke' },
  'event.emit': { kind: 'reserved', capability: 'event:emit' },
  'event.listen': { kind: 'reserved', capability: 'event:listen' }
} as const satisfies Record<string, XdeckMethodMapping>;

export type XdeckMethodName = keyof typeof XDECK_METHOD_MAP;

/**
 * Lookup — returns `null` for unknown methods so the analyzer can surface
 * "called xdeck.frobnicate.foo() which doesn't exist" as a clear error.
 */
export function lookupXdeckMethod(method: string): XdeckMethodMapping | null {
  return (XDECK_METHOD_MAP as Record<string, XdeckMethodMapping>)[method] ?? null;
}

/**
 * Build the full capability string for a method invocation, given the
 * extracted resource id when parameterized. Returns the capability or
 * `null` when the method is unknown.
 *
 * For `reserved` methods this still returns the reserved string — the
 * caller (validator) uses Slice 2's reservation check to reject.
 */
export function capabilityForMethodCall(method: string, resourceId?: string | null): Capability | null {
  const mapping = lookupXdeckMethod(method);
  if (!mapping) return null;
  if (mapping.kind === 'static') return mapping.capability;
  if (mapping.kind === 'reserved') return mapping.capability as Capability;
  // parameterized
  if (!resourceId) return null;
  return `${mapping.family}:${resourceId}` as Capability;
}

/**
 * §9.166 Step 6 — EVERY capability one call needs: the method's own, plus its
 * `alsoRequires`. The static analyzer records all of them at the call site, so a package that
 * declares only half of a composed grant fails at publish rather than at the first real call.
 * Returns `[]` for an unknown method, and the single parameterized capability when given its
 * resource id (none when not — it cannot be resolved statically).
 */
export function capabilitiesForMethodCall(method: string, resourceId?: string | null): Capability[] {
  const primary = capabilityForMethodCall(method, resourceId);
  if (!primary) return [];
  const mapping = lookupXdeckMethod(method);
  const extra = mapping && mapping.kind === 'static' ? (mapping.alsoRequires ?? []) : [];
  return [primary, ...extra];
}

/**
 * §9.94 B2 — methods that ARE in {@link XDECK_METHOD_MAP} (so the static analyzer +
 * validator recognise them, and a package may declare the capability) but have **no
 * host handler yet** — i.e. catalogued + analyzable but not reachable at runtime. A
 * package calling one gets a fail-closed `XDECK_UNKNOWN_METHOD`. They are listed here
 * EXPLICITLY (not silently absent from the host) so:
 *   - the drift gate (`runtime-sdk-surface.spec`) can assert that every map method is
 *     either host-wired OR on this documented list — neither side drifts silently;
 *   - the SDK contract doc renders an honest "declared, not yet implemented" column.
 *
 * Each entry names the kernel primitive the completion needs. Reserved-family methods
 * (`class.invoke`, `event.*`) are NOT here — they are non-grantable by design, a
 * different state (see `RESERVED_*` in capability.ts).
 */
export const UNIMPLEMENTED_METHODS: Partial<Record<XdeckMethodName, string>> = {
  // CORRECTED 2026-09-03: the kernel primitive DOES exist. §9.41.7 shipped
  // NativePushRegistrationService (register / unregister / list / dispatchOnce / adminRevoke),
  // the PushDispatcher vendor contract, per-platform routing, auto-revoke on a token-invalid
  // vendor result, and full audit. TWO things are missing, and neither is a missing primitive:
  //   1. NO VENDOR ADAPTER is registered — PUSH_DISPATCHERS defaults to [] and the service falls
  //      back to NoOpPushDispatcher, which surfaces `transport-failure` rather than dropping the
  //      send. Adding one needs vendor credentials (Apple key / FCM project), not code.
  //   2. NO ADDRESSING MODEL for a package caller. dispatchOnce takes a registrationId, and
  //      native_push_registration is keyed by (deckId, installId, platform, token) with NO
  //      userId — so `push.send({ userId })` cannot be resolved today. Choosing how a package
  //      addresses a device (user->install link, or install-scoped sends) is the open design
  //      call, and it should be made with a real package caller rather than guessed. TODO(§9.161).
  'push.send':
    // Registration, dispatch and audit: §9.41.7.
    'registration + dispatch + audit exist; missing a registered vendor adapter (needs credentials) ' +
    'and an addressing model — native_push_registration has no userId, so a package cannot target a user yet',
  // Needs the §9.25 agent runtime; `AiProviderService` has completion + embeddings, no agent loop.
  'ai.agentInvoke': 'needs the agent runtime (no agent-invoke primitive in AiProviderService)',
  // Needs a RAG / knowledge-base primitive (vector store + retrieval) — not built.
  'ai.knowledgeQuery': 'needs a RAG/knowledge-base primitive (vector store + retrieval) — not built'
} as const;

/**
 * §9.94 B2 — host methods that are intentionally NOT capability-gated and so are
 * deliberately absent from {@link XDECK_METHOD_MAP}: identity-scoped reads of the
 * calling package's OWN context/config for its OWN tenant (nothing cross-boundary to
 * gate — the `(tenant, package)` identity comes from the parent-supplied GuardContext,
 * never the payload). The static analyzer skips these (mirrors `xdeck.context.*`). The
 * drift gate uses this list so an identity-scoped host method is not mistaken for an
 * un-mapped (therefore un-analyzed) capability call.
 */
export const IDENTITY_SCOPED_METHODS: readonly string[] = [
  'config.get',
  // §9.94 B5.c — the kernel BROKER. Not a catalogue capability (no RuntimeGuard grant): its gate
  // is the consumer's `consumes` contract + provider resolution + the consumer-user actor, all
  // parent-side in CapabilityBrokerService. Listed here so the drift gate doesn't flag it as an
  // un-analyzed capability call.
  'capabilities.invoke',
  // §9.169 PR-10 — the integrator door (`xdeck.integrator.callout`, `xdeck.integrator.settings`). Not a
  // catalogue capability: its gate is the parent-set `GuardContext.integratorRun` — only an integration
  // handler run has one — checked in the door, never readable from the payload or the worker. A class
  // outside such a run is refused (`INTEGRATOR_CALLOUT_REFUSED`); no package `capabilities` list can hold it.
  'integrator.callout',
  'integrator.settings'
] as const;

/** The implementation maturity of an `xdeck.<domain>.<method>` in the SDK contract. */
export type MethodImplementationStatus = 'live' | 'unimplemented' | 'reserved' | 'identity-scoped' | 'unknown';

/**
 * §9.94 B2 — classify a dotted method id against the SDK surface. `'live'` requires the
 * caller to confirm host-registration (this function answers from the contract side
 * only): a mapped static/parameterized method that is not on {@link UNIMPLEMENTED_METHODS}
 * is reported `'live'`; the backend drift gate cross-checks that against the real host
 * handler set so the two can never disagree silently.
 */
export function methodImplementationStatus(method: string): MethodImplementationStatus {
  if (IDENTITY_SCOPED_METHODS.includes(method)) return 'identity-scoped';
  const mapping = lookupXdeckMethod(method);
  if (!mapping) return 'unknown';
  if (mapping.kind === 'reserved') return 'reserved';
  if (Object.prototype.hasOwnProperty.call(UNIMPLEMENTED_METHODS, method)) return 'unimplemented';
  return 'live';
}
