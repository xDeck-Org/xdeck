/**
 * §9.50 Capability catalogue — the closed-set vocabulary every package
 * declares against and the runtime guard checks against.
 *
 * **Why a closed set.** Capability strings are the trust boundary: a
 * package's manifest declares what it intends to do, the tenant approves
 * those, and the runtime enforces. Allowing arbitrary strings would
 * surface security holes via typos ("notification:send-in-aap" silently
 * grants nothing then errors at runtime). The closed set forces
 * declaration-time validation against this enum.
 *
 * **Why reserved strings.** Per §9.50.9.1, three capability families
 * (`class:invoke`, `event:emit`, `event:listen`) are designed but
 * deferred. Reserving their strings now prevents future name-squatting
 * by a real capability when those families re-open.
 *
 * **Parameterized capabilities** (entity / class-invoke / secret-read)
 * live alongside the static enum. The parameterized form is the full
 * grant key the runtime checks against; the static `BaseCapability`
 * portion is what the catalogue enumerates.
 */

import { ReservedCapabilityError } from './errors';

/**
 * Capabilities that take no resource parameter — the manifest declares
 * them by exact string match against this union.
 */
export type StaticCapability =
  | 'notification:send-in-app'
  | 'notification:broadcast'
  | 'email:send'
  | 'sms:send'
  | 'whatsapp:send'
  | 'push:send'
  | 'ai:complete'
  | 'ai:embed'
  // §9.158 — build the calling deck's daily business digest (see XDECK_METHOD_MAP).
  | 'ai:digest-build'
  | 'ai:agent-invoke'
  | 'ai:knowledge-query'
  | 'template:render'
  | 'job:schedule'
  | 'job:enqueue'
  | 'http:fetch-allowlisted'
  | 'webhook:send'
  | 'storage:read'
  | 'storage:write'
  | 'payment:initiate'
  | 'payment:refund'
  // §9.77 IoT Stack (2026-05-25). Static-only — the package
  // gate is "is iot-stack installed at all" (per-device gating
  // would explode the grant table since deviceIds are runtime data,
  // not declaration-time constants). The 4 caps split the blast
  // radius across three package profiles:
  //
  //   - Telemetry collector: declares device-read + event-listen
  //     (no commands, no firmware). Lowest blast.
  //   - Control-plane: adds device-control (commands but no firmware).
  //   - Firmware management: separately asks for firmware-push
  //     (highest blast — could brick devices). Distinct cap so a
  //     control-plane package doesn't get firmware authority by
  //     default; declaring firmware-push is a deliberate ask.
  //
  // Devices remain tenant-scoped at the IotDeviceService layer.
  // Single-colon form (dashed verb) follows the existing convention
  // — `ai:agent-invoke`, `notification:send-in-app`,
  // `http:fetch-allowlisted` — so `parseCapability` treats them as
  // static, not parameterized.
  | 'iot:device-control'
  | 'iot:device-read'
  | 'iot:event-listen'
  | 'iot:firmware-push'
  // §9.50 RA-bridge — sandboxed package code emits telemetry via
  // `xdeck.telemetry.{track|identify|page}(...)`. Provider package is
  // `standard/telemetry`; consumer packages declare these in their
  // manifest's `capabilities.required`. Events flow through the SAME
  // RA5 validator the HTTP ingest uses (declared events only in strict
  // mode + always-on payload-schema enforcement) — sandbox code cannot
  // smuggle malformed events past the catalogue contract.
  //
  // Three methods shipped; three sibling capabilities
  // (`telemetry:alias`, `telemetry:grant-consent`, `telemetry:deny-consent`)
  // are reserved on the provider's `capabilities.provides` for future
  // use — adding them is purely additive (new wrapper method + handler
  // entry + this string).
  | 'telemetry:track'
  | 'telemetry:identify'
  | 'telemetry:page'
  // §9.146 — vertical-neutral consumer-link primitive. Lets a vertical package
  // (restroin today, clinicloud next) establish the §9.61 CORE `customer_links`
  // engagement edge for its tenant via `xdeck.consumer.ensureLink(...)` instead
  // of forking a package-private link table. Static (not per-resource): the
  // grant is "may link consumers to this tenant at all" — the row's scope is
  // host-stamped from ctx.deckId, never the payload. Single-colon form per
  // the `ai:agent-invoke` convention so `parseCapability` treats it as static.
  | 'consumer:link'
  // §9.91.13 PR-2 — ASSERT a dependant into a consumer's family graph from a deck's own desk
  // ("this visit is for the son's father"). A separate power from `consumer:link`: link says
  // "we engage this person", assert writes a CLAIM about who is in someone's family. The claim
  // lands pending for the holder's review and grants nobody standing until confirmed. Unlike
  // link it is NOT a no-PII call: the dependant's details cross IN TRANSIT to ClienX and are
  // never stored deck-side.
  | 'consumer:assert-dependant'
  // §9.91.13 PR-3b-ii — a consumer writes THEIR OWN demographics through the deck they are signed
  // in to. Unlike the two desk-side consumer powers, the subject is the verified session's link
  // on the actor overlay, never a payload id: granting this to a package lets its consumer
  // routes offer a profile form, and nothing else.
  | 'consumer:profile-write'
  // §9.156 — READ the authorization facts that apply on this deck: the effective
  // permissions of the acting user, and the deck's role vocabulary.
  //
  // Why a package needs this. The dispatcher already enforces permissions on the
  // DATA, and that is a floor, not a UI. A vertical that cannot ask "what may
  // this person do?" has three bad options: show every control and let the
  // action fail, hide controls by guessing, or fork a private role table. All
  // three have shipped somewhere. The §9.150 sweep found 11 of 14 surfaces
  // pinning a scope the caller had no grant for — the same defect one rung up.
  //
  // Why READ-only, and why static. There is no `rbac:write` here on purpose: a
  // sandboxed package that could mint roles or grant permissions is a privilege-
  // escalation surface, and the four P0s this codebase already fixed were all
  // that shape. Reading is static rather than per-resource because the answer is
  // always scoped to ONE deck and ONE actor — both host-stamped from the verified
  // context, never from the payload — so there is no resource for a grant to name.
  | 'rbac:read'
  // §9.156 — READ the record scopes this caller may work in. The dispatcher has
  // enforced rowScope since §9.150; the browser got `GET /tenant/scope` and a
  // sandboxed class got nothing, so a class could only guess or read the
  // scope-defining entity raw (which is unpartitioned, so it returns every row).
  // Read-only: there is no scope:write — widening one's own scope would defeat
  // the floor being asked about.
  | 'scope:read'
  // Read records AS the person who delegated it — `xdeck.entity.readAs(...)`. A package job has
  // no person (`ctx.actor` is absent for jobs and cron), so a scheduled report could read only
  // what the PACKAGE was granted, by exact entity name — and package authority over a report a
  // person wrote is the confused deputy ADR-0019 D9.1 forbids. This reads with the delegating
  // person's OWN current access instead: the dispatcher's `<Entity>:query` permission, record-scope
  // floor and sharing rules, resolved on every call. The person mints the delegation in their own
  // session (`/api/v1/tenant/delegations`), names the record types it covers and can revoke it;
  // this capability is only the deck's consent that the package may use such delegations at all.
  // Static, not per-entity, on purpose: the record types are the person's choice, bounded by the
  // delegation the host checks on every call (ADR-0035).
  | 'entity:read-delegated'
  // §9.166 Step 6 — the deck↔consumer invoice LEDGER, a core table set in every deck
  // database. Four static capabilities rather than one because they are four different
  // blast radii, and a package asks for exactly the ones it needs:
  //
  //   - invoice:issue  — quote and issue. Mints a legal document with a gapless number
  //                      under the deck's GSTIN, so it is not a read.
  //   - invoice:read   — the invoices THIS package issued (record scope + the ledger's
  //                      own sourcePackage wall narrow it further; never other apps').
  //   - invoice:settle — record money received against those invoices.
  //   - invoice:credit — cancel, credit or refund them: money OUT, the highest radius,
  //                      and the reason it is its own grant.
  //
  // Static, not per-resource: the resource a grant could name (an invoice) is runtime
  // data, and scope already comes from the verified deck, the package identity and the
  // acting person's `deck_invoices:*` permissions — never from the payload. A capability
  // is the package half of a two-key check; the person's permission is the other key,
  // and both must turn. `invoice:settle` and `invoice:credit` are DEVICE-DENIED
  // (device-capability.ts): a till may issue a bill, never void or refund one.
  | 'invoice:issue'
  | 'invoice:read'
  | 'invoice:settle'
  | 'invoice:credit';

/**
 * Capability families that require a per-resource grant. The manifest
 * declares a fully-qualified string (e.g. `entity:read:approvalRequest`)
 * and the runtime checks the grant for that exact string.
 */
export type ParameterizedCapabilityFamily =
  | 'entity:read'
  | 'entity:write'
  | 'class:invoke'
  | 'secret:read'
  // §9.82.2 PR-3 — signed-binding primitive. Parameterized per binding KIND
  // (`binding:sign:table`, `binding:verify:table`) so a grant for one kind can
  // never mint/verify another (device-pairing, queue tokens, … are future kinds).
  | 'binding:sign'
  | 'binding:verify'
  // §9.94 B3 (ADR-0019 D8) — gated package-route surface. Parameterized per route
  // as `route:expose:<ns>/<name>:<routeId>` (e.g. `route:expose:restroin/foh:place-order`)
  // so a tenant approves EACH route a package serves over HTTP, not a blanket grant —
  // and a grant can never be replayed by a different package (the `<ns>/<name>` is in
  // the resource id, same per-resource isolation as `secret:read:<KEY>`). `parseCapability`
  // splits on the SECOND colon, so the `/` and the inner `:` are inert inside the resource.
  | 'route:expose'
  // §9.166 Step 6 — RESERVED, not built: read ANOTHER package's invoices
  // (`invoice:read-from:<ns>/<name>`). It needs three keys at once — this grant, the SOURCE
  // package's declared ceiling (PHI packages defaulting to none), and the acting person's
  // `deck_invoices:read` — and a header projection only. Reserved now so the name means
  // exactly that when it is built, rather than whatever the first shortcut makes it mean.
  | 'invoice:read-from';

/**
 * The full capability grammar — either a static capability OR a
 * parameterized capability with a resource id suffix.
 *
 * Example values:
 *  - `'email:send'` (static)
 *  - `'entity:read:approvalRequest'` (parameterized — resource is `approvalRequest`)
 *  - `'class:invoke:Notify'` (parameterized — resource is `Notify`)
 *  - `'secret:read:STRIPE_KEY'` (parameterized — resource is `STRIPE_KEY`)
 */
export type Capability = StaticCapability | `${ParameterizedCapabilityFamily}:${string}`;

/**
 * Capability families that are RESERVED for future use but are NOT
 * grantable in Phase A/B/C per §9.50.9.1. Manifest validation must
 * reject any `required` / `optional` entry whose family is in this list.
 *
 * The strings are reserved (no other capability can squat them); they
 * just can't be granted today.
 */
export const RESERVED_CAPABILITY_FAMILIES: readonly ParameterizedCapabilityFamily[] = [
  'class:invoke',
  // §9.166 Step 6 — cross-package invoice reads; see the family's docblock.
  'invoice:read-from'
] as const;

export const RESERVED_STATIC_CAPABILITIES: readonly string[] = [
  // Reserved per §9.50.9.1 — package-to-package event bus deferred.
  // Strings kept so a future re-introduction uses the existing names.
  'event:emit',
  'event:listen'
] as const;

/**
 * Runtime-iterable mirror of every grantable static capability. Used by
 * the install-time approval UI (Phase B Slice 6) to render the
 * permission checklist + by AJV validators (Slice 2) to verify manifest
 * entries.
 */
export const GRANTABLE_STATIC_CAPABILITIES: readonly StaticCapability[] = [
  'notification:send-in-app',
  'notification:broadcast',
  'email:send',
  'sms:send',
  'whatsapp:send',
  'push:send',
  'ai:complete',
  'ai:embed',
  'ai:digest-build',
  'ai:agent-invoke',
  'ai:knowledge-query',
  'template:render',
  'job:schedule',
  'job:enqueue',
  'http:fetch-allowlisted',
  'webhook:send',
  'storage:read',
  'storage:write',
  'payment:initiate',
  // §9.166 Step 5 part 4 — money OUT through the deck's own gateway account. Grantable, but its
  // radius is the reason `DEVICE_DENIED_STATIC_CAPABILITIES` already refuses it for a till: a
  // device at a counter may take money, never give it back.
  // Grantable in principle (a package may declare it, and the tooling reads it), but HELD in
  // practice: `CapabilityGrantsService.grant` refuses it for every deck, under its own code. The
  // runtime refund doors now ask for a person, their refund key and a recent sign-in (the backend pin
  // `refund-door-grant-hold.gate.spec.ts` reads those doors); lifting the hold is the owner's decision.
  'payment:refund',
  'iot:device-control',
  'iot:device-read',
  'iot:event-listen',
  'iot:firmware-push',
  // §9.50 RA-bridge — see StaticCapability for rationale.
  'telemetry:track',
  'telemetry:identify',
  'telemetry:page',
  // §9.146 — consumer-link primitive (see StaticCapability for rationale).
  'consumer:link',
  // §9.91.13 PR-2 — desk-side dependant assertion (see StaticCapability for rationale).
  'consumer:assert-dependant',
  // §9.91.13 PR-3b-ii — consumer self-profile write (see StaticCapability for rationale).
  'consumer:profile-write',
  // §9.156 — read-only authorization facts for the current deck + actor.
  'rbac:read',
  // §9.156 — read-only record-scope descriptor for the calling deck + actor.
  'scope:read',
  // ADR-0035 — read records as the person who delegated it (see StaticCapability).
  'entity:read-delegated',
  // §9.166 Step 6 — the deck invoice ledger (see StaticCapability for rationale).
  'invoice:issue',
  'invoice:read',
  'invoice:settle',
  'invoice:credit'
] as const;

/**
 * §9.166 Step 6, owner decision 19 — capabilities that are in the catalogue but may be
 * GRANTED to no deck yet ("ship dark").
 *
 * The invoice ledger mints real tax documents under a deck's GSTIN, so it stays dark until
 * two things are true: the RestroIn golden path has passed live against it, and a
 * chartered accountant has reviewed the pinned `india-gst@1` rule. Until then a package
 * may DECLARE these (so Steps 8-9 can be built and tested against the in-memory harness,
 * which grants in memory) and a manifest declaring them still validates — but
 * `CapabilityGrantsService.grant`, the one place a grant row is written, refuses them. With
 * no grant row, `RuntimeGuard.ensureGranted` can never pass, so no real deck reaches the
 * ledger through a package.
 *
 * Why a separate list rather than leaving them out of {@link GRANTABLE_STATIC_CAPABILITIES}:
 * that list is what the static analyzer, the install validator and the host drift gates
 * read, and pulling the capabilities out of it would break the very tooling the verticals
 * need to build against them. Grantable-in-principle and granted-in-practice are different
 * questions, answered in different places.
 *
 * Lifting it is owner decision 19: remove the four from this list.
 * TODO(§9.166 decision 19) — the live golden path needs the grant on ONE deck before the
 * gate lifts for all; that pilot allow-list is part of the decision, not invented here.
 * Lifting also needs the runtime-refund row, or deliberate removal of this pin:
 * `apps/backend/src/modules/platform-runtime-api/services/refund-door-grant-hold.gate.spec.ts`.
 * `invoice:credit` opens `invoice.refund`, a runtime refund door that asks for no recent
 * sign-in. The pin fails while `invoice:credit` or `payment:refund` is grantable to any deck
 * (the pilot included) and either runtime refund door lacks its person or recency check.
 */
export const SHIP_DARK_CAPABILITIES: readonly StaticCapability[] = Object.freeze([
  'invoice:issue',
  'invoice:read',
  'invoice:settle',
  'invoice:credit'
]);

/** Is this capability catalogued but not yet grantable to any deck? */
export function isShipDarkCapability(cap: string): boolean {
  return (SHIP_DARK_CAPABILITIES as readonly string[]).includes(cap);
}

/**
 * Runtime-iterable mirror of every parameterized family that IS grantable.
 * Reserved families (`class:invoke`) excluded.
 */
export const GRANTABLE_PARAMETERIZED_FAMILIES: readonly ParameterizedCapabilityFamily[] = [
  'entity:read',
  'entity:write',
  'secret:read',
  // §9.82.2 PR-3 — signed-binding kinds (e.g. `binding:verify:table`).
  'binding:sign',
  'binding:verify',
  // §9.94 B3 — gated package-route exposure (e.g. `route:expose:restroin/foh:place-order`).
  'route:expose'
] as const;

/** Build a parameterized capability string. Type-safe family + resource concat. */
export function parameterizedCapability<F extends ParameterizedCapabilityFamily>(
  family: F,
  resourceId: string
): `${F}:${string}` {
  return `${family}:${resourceId}`;
}

/**
 * Parse a capability string into `{ family, resourceId? }`. Returns
 * `null` for unrecognised strings. Used by the runtime guard (Slice 3)
 * to look up the right grant row.
 */
export function parseCapability(cap: string): { family: string; resourceId: string | null } | null {
  if (!cap || typeof cap !== 'string') return null;
  // Static capabilities have exactly one colon (e.g. 'email:send').
  // Parameterized capabilities have at least two (e.g. 'entity:read:foo').
  const firstColon = cap.indexOf(':');
  if (firstColon === -1) return null;
  const secondColon = cap.indexOf(':', firstColon + 1);
  if (secondColon === -1) {
    return { family: cap, resourceId: null };
  }
  return {
    family: cap.slice(0, secondColon),
    resourceId: cap.slice(secondColon + 1)
  };
}

/**
 * Throws {@link ReservedCapabilityError} when `cap` is in the reserved
 * static list or reserved family list. Both the runtime guard (Slice 3)
 * and the test harness (Slice 12) call this BEFORE the granted check so
 * the reservation reason wins over a generic "not granted" miss for the
 * same string. Returns `void` on grantable / unknown capabilities —
 * unknowns are caught downstream by `isGrantableCapability`.
 *
 * errors.ts uses `import type` from this file (erased at runtime), so
 * a direct value import here does NOT close a circular dependency.
 */
export function ensureNotReserved(cap: string): void {
  const parsed = parseCapability(cap);
  if (!parsed) return;
  if ((RESERVED_STATIC_CAPABILITIES as readonly string[]).includes(parsed.family)) {
    // The reserved list: §9.50.9.1.
    throw new ReservedCapabilityError(cap, `static capability '${parsed.family}' is on the reserved list`);
  }
  if (
    parsed.resourceId !== null &&
    (RESERVED_CAPABILITY_FAMILIES as readonly string[]).includes(parsed.family as ParameterizedCapabilityFamily)
  ) {
    throw new ReservedCapabilityError(cap, `family '${parsed.family}' is on the reserved list`);
  }
}

/**
 * Returns `true` when the given capability string is grantable under
 * Phase A/B/C. Reserved families + reserved statics return `false`.
 * Used by manifest validation (Slice 2) to reject undeclared
 * capabilities at publish time.
 */
export function isGrantableCapability(cap: string): boolean {
  const parsed = parseCapability(cap);
  if (!parsed) return false;
  if (parsed.resourceId === null) {
    // Static capability path.
    if ((RESERVED_STATIC_CAPABILITIES as readonly string[]).includes(parsed.family)) return false;
    return (GRANTABLE_STATIC_CAPABILITIES as readonly string[]).includes(parsed.family);
  }
  // Parameterized capability path.
  if ((RESERVED_CAPABILITY_FAMILIES as readonly string[]).includes(parsed.family)) return false;
  if (!(GRANTABLE_PARAMETERIZED_FAMILIES as readonly string[]).includes(parsed.family)) return false;
  // Resource id must be non-empty and reasonable.
  return parsed.resourceId.length > 0;
}

/**
 * §9.50 — plain-language description of every grantable capability.
 *
 * ## Why this exists
 *
 * The install-time consent panel listed the raw grant strings and nothing else:
 * a person was shown `telemetry:track`, `consumer:assert-dependant`,
 * `iot:firmware-push` in monospace chips and asked to approve runtime access to
 * them. That is not consent — it is a checkbox next to a word only the package
 * author understands. Capability approval is the trust boundary this whole
 * catalogue exists to defend, and the one point where a human is asked to make
 * the security decision; asking them in a private vocabulary defeats it.
 *
 * ## Why it lives HERE
 *
 * Beside the catalogue, not in the UI, so the two cannot drift. A capability
 * added to {@link GRANTABLE_STATIC_CAPABILITIES} without a line here fails
 * `capability.descriptions.test.ts` rather than silently reaching a consent
 * screen as a bare string again.
 *
 * ## Wording rules
 *
 * Every line is derived from the capability's own docblock above — none of it
 * is invented. Each says what the package may DO, in the second person, in the
 * deck's vocabulary ("this deck", never "tenant"), and names the blast radius
 * where the catalogue calls it out.
 */
export const CAPABILITY_DESCRIPTIONS: Readonly<Record<StaticCapability, string>> = {
  'notification:send-in-app': 'Send in-app notifications to people on this deck.',
  'notification:broadcast': 'Send a notification to everyone on this deck at once.',
  'email:send': 'Send email from this deck.',
  'sms:send': 'Send SMS messages from this deck.',
  'whatsapp:send': 'Send WhatsApp messages from this deck.',
  'push:send': 'Send mobile push notifications.',
  'ai:complete': 'Ask an AI model to generate text.',
  'ai:embed': "Turn this deck's content into embeddings so it can be searched.",
  'ai:digest-build': "Build this deck's daily business digest.",
  'ai:agent-invoke': "Run an AI agent on this deck's behalf.",
  'ai:knowledge-query': "Query this deck's AI knowledge base.",
  'template:render': 'Render message and document templates.',
  'job:schedule': 'Schedule background work to run later.',
  'job:enqueue': 'Queue background work to run now.',
  'http:fetch-allowlisted': 'Call external services, limited to the allow-list.',
  'webhook:send': 'Send webhooks to systems outside this deck.',
  'storage:read': "Read files from this deck's storage.",
  'storage:write': "Upload, change and delete files in this deck's storage.",
  'payment:initiate': 'Start a payment.',
  'payment:refund': 'Refund a payment this app took.',
  'iot:device-control': "Send commands to this deck's devices.",
  'iot:device-read': "Read state and readings from this deck's devices.",
  'iot:event-listen': "Listen to events from this deck's devices.",
  // The catalogue singles this one out as the highest blast radius of the four
  // IoT capabilities — "could brick devices" — so the consent line says so.
  'iot:firmware-push': "Push firmware to this deck's devices. A bad firmware push can stop them working.",
  'telemetry:track': 'Record product-usage events.',
  'telemetry:identify': 'Attach identity details to usage events.',
  'telemetry:page': 'Record page views.',
  'consumer:link': 'Record that a customer is engaged with this deck.',
  // Per the catalogue: this writes a CLAIM about someone's family, it lands
  // pending, and the dependant's details cross to ClienX in transit.
  'consumer:assert-dependant':
    "Claim that someone belongs to a customer's family. The claim waits for that person to confirm it before it counts.",
  'consumer:profile-write': 'Let a signed-in customer edit their own profile details.',
  'rbac:read': 'Read what the signed-in person is allowed to do on this deck.',
  'scope:read': 'Read which records the signed-in person is allowed to work in.',
  'entity:read-delegated':
    "Read the record types a person chose, with that person's own access, while they are away (for example a scheduled report).",
  // §9.166 Step 6. "This app" rather than "this package": the consent panel is read by a
  // deck owner, and the scope really is this app's own invoices, never another's.
  'invoice:issue': "Issue invoices to this deck's customers.",
  'invoice:read': 'Read the invoices this app issued.',
  'invoice:settle': 'Record payments against the invoices this app issued.',
  // The money-OUT capability, so the line names all three things it can do.
  'invoice:credit': 'Cancel, credit or refund the invoices this app issued.'
};

/**
 * Plain-language description of a PARAMETERIZED capability family. The grant is
 * per-resource (`entity:read:patient`), so the sentence is completed by the
 * resource name — see {@link describeCapability}.
 */
export const CAPABILITY_FAMILY_DESCRIPTIONS: Readonly<Record<ParameterizedCapabilityFamily, string>> = {
  'entity:read': 'Read records of one type',
  'entity:write': 'Create, change and delete records of one type',
  'class:invoke': "Run another package's code",
  'secret:read': 'Read one named secret',
  'binding:sign': 'Issue signed tokens of one kind',
  'binding:verify': 'Check signed tokens of one kind',
  'route:expose': 'Serve one named web route',
  // Reserved (see the family docblock); described so a consent screen never shows it bare.
  'invoice:read-from': "Read another app's invoices"
};

/**
 * A sentence a person can act on for any capability string, static or
 * parameterized.
 *
 * Returns `null` — never a guess — when the string is not in the catalogue. The
 * caller shows the raw id in that case, which is honest about not knowing
 * rather than inventing a reassuring description for an unrecognised grant.
 */
/**
 * Turn a capability's resource segment into words.
 *
 * The resource is an ENTITY NAME straight from a package manifest —
 * `MenuItemRating`, `TableSessionStatus`, `patient`. Interpolated raw, it put
 * package class names in front of a person: the deck audit trail rendered
 * "Capability granted · entity:read:MenuItemRating" in monospace, and the
 * install consent panel asked people to approve "Read records of one type:
 * MenuItemRating."
 *
 * Runs of 2+ capitals are preserved as-is, so an initialism (KOT, POS, SKU)
 * survives instead of being split into letters.
 */
export function humaniseResource(resource: string): string {
  const words = resource
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
  if (!words) return resource;
  // Lower-case only words that are not initialisms, then sentence-case the first.
  const lowered = words
    .split(/\s+/)
    .map((w) => (/^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
  return lowered.charAt(0).toUpperCase() + lowered.slice(1);
}

export function describeCapability(capability: string): string | null {
  const stat = CAPABILITY_DESCRIPTIONS[capability as StaticCapability];
  if (stat) return stat;

  /* Parameterized: `<family>:<resource>` where the family itself contains a
     colon (`entity:read:patient`). Match the LONGEST family prefix so
     `binding:sign` is not mistaken for a family called `binding`. */
  for (const family of Object.keys(CAPABILITY_FAMILY_DESCRIPTIONS) as ParameterizedCapabilityFamily[]) {
    const prefix = `${family}:`;
    if (!capability.startsWith(prefix)) continue;
    const resource = capability.slice(prefix.length);
    if (!resource) return null;
    // Only an ENTITY resource is humanised — it is a class name from a manifest, and
    // "MenuItemRating" is not something a person should have to parse. Every other
    // family's resource is a literal IDENTIFIER the person matches against something
    // else: a secret's key in the vault, a binding kind, a route id. Rewriting
    // `STRIPE_KEY` as "STRIPE KEY" would describe a secret that does not exist.
    const shown = family.startsWith('entity:') ? humaniseResource(resource) : resource;
    return `${CAPABILITY_FAMILY_DESCRIPTIONS[family]}: ${shown}.`;
  }
  return null;
}

// ── Well-known capability sockets ─────────────────────────────────────────────────────
//
// A SOCKET is a provided-capability NAME (`<namespace>:<name>`, no version) that core asks
// about instead of a package name: "does an installed, enabled package on this deck PROVIDE
// it?". A package fills a socket by declaring `<socket>@<semver>` in its manifest's
// `capabilities.provides` (the ADR-0019 D9 grammar in `provided-capability.ts`), so core
// never hardcodes which package — or which vendor — answers.
//
// They live HERE, beside the kernel catalogue, so the frontend can import them through the
// `@xdeck/runtime-api/capability` subpath without pulling the whole runtime API. They are NOT
// kernel capabilities: neither namespace may be added to the GRANTABLE_* / RESERVED_* lists
// above, because a kernel namespace is exactly what a package is refused to provide (D9.3
// kernel-wins) — the socket would become undeclarable.

/**
 * §9.80 — the payment-gateway SOCKET (the operator's M-3 direction). Each gateway vendor
 * ships as a package (`standard/gateway-stripe`, `standard/gateway-razorpay`, …) that
 * PROVIDES this capability (`billing:gateway@<semver>` in the D9 grammar) and declares its
 * own credentials as `secret` settings fields (§9.80 framework); the billing engine stays
 * gateway-agnostic and resolves whichever installed package fills the socket.
 *
 * Naming is load-bearing twice over: the §9.80 slice originally wrote `billing.gateway`,
 * which `parseProvidedCapability` rejects (no colon → null, so the socket was undeclarable
 * and ungrantable); and `payment:*` is a KERNEL capability namespace (`payment:initiate`),
 * so `payment:gateway` would be refused by the D9.3 kernel-wins rule. The free `billing`
 * namespace is therefore the canonical home.
 */
export const BILLING_GATEWAY_CAPABILITY = 'billing:gateway';

/**
 * §9.171 — the IoT device-plane SOCKET. The deck's device API (the tenant-self IoT devices,
 * sites and events endpoints) and the console's Devices entry open only while an installed,
 * enabled package PROVIDES this capability (`devices:iot-plane@<semver>`). Core asks the
 * socket, never a package name, so any device-stack package can fill it.
 *
 * The namespace is `devices`, not `iot`: `iot:*` is a KERNEL capability namespace
 * (`iot:device-read`, `iot:device-control`, …), so `iot:plane` would be refused by the D9.3
 * kernel-wins rule and no package could ever declare the socket.
 */
export const IOT_DEVICE_PLANE_CAPABILITY = 'devices:iot-plane';

/**
 * §9.171 H1 — the consumer identity PROVIDER socket. The ONE deck whose installed, enabled,
 * first-party package PROVIDES this capability (`identity:consumer-provider@<semver>`) holds
 * the platform's consumer identities — the people, their families, the services they have
 * shared with and their health ids. Every core path that reaches that deck goes through the
 * backend's `ConsumerIdentityProviderService`, which finds the deck by this socket; the
 * consumer routes (the family, services and engagement endpoints), the deck navigation's
 * "My household" entries and the consumer audience of the deck menu open on it. Core never
 * names the deck or its package. No provider, or more than one, closes every one of them.
 *
 * The namespace is `identity`, not `consumer`: `consumer:*` is a KERNEL capability namespace
 * (`consumer:link`, `consumer:assert-dependant`, …), so `consumer:provider` would be refused
 * by the D9.3 kernel-wins rule and no package could ever declare the socket.
 */
export const CONSUMER_IDENTITY_PROVIDER_CAPABILITY = 'identity:consumer-provider';

/**
 * §9.171 — the national health-record exchange SOCKET. The deck's record-exchange surface (the
 * consent ledger, health-id linkage, record share and request, the consent callbacks' deck-side
 * effects) opens only while an installed, enabled package PROVIDES this capability
 * (`health-records:exchange@<semver>`). Core asks the socket, never a package name, so whichever
 * package connects a deck to a national exchange fills it.
 *
 * The name is generic on purpose: `health-records` is neither a kernel capability namespace
 * (so D9.3 kernel-wins never refuses the declaration) nor a vertical word under
 * `config/core-vertical-names.json` (so core can name the socket without naming one vertical).
 */
export const HEALTH_RECORD_EXCHANGE_CAPABILITY = 'health-records:exchange';
