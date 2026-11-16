/**
 * @xdeck/runtime-api/react — React-side surface for the §9.50 capability
 * runtime. Reachable via the `./react` subpath only (not from the bare
 * `@xdeck/runtime-api` entry point) so server-side consumers — the
 * install-time validator (apps/backend) and the tag-time CI gate
 * (scripts/ci/) — never accidentally pull React into their bundle.
 *
 * **Builder consumption model.** Marketplace packages that emit telemetry,
 * audit, notifications, or any future capability NEVER bundle the
 * implementation SDK. They:
 *
 *   1. Declare in their manifest:
 *        `peerDependencies: { "standard/telemetry": "^1.0.0" }`
 *        `capabilities: { required: ["telemetry:track"] }`
 *
 *   2. Import the hook here:
 *        `import { useTelemetry } from '@xdeck/runtime-api/react';`
 *
 *   3. Call it in their React component:
 *        `const t = useTelemetry(); t?.track('appointment_booked', {...});`
 *
 * The implementation package (e.g. `standard/telemetry`) is the **writer**
 * — its `<TelemetryProvider>` populates the Context exported here. The
 * builder is the **reader** — they only know about the hook + the API
 * shape. Telemetry version bumps don't break builders; SDK swaps don't
 * break builders.
 *
 * **Core-values trace (subpath-level):**
 *  - **Security.** Pure read surface — `useContext()` cannot emit events
 *    if no Provider mounted; returns `null` defensively so callers
 *    optional-chain or short-circuit. Implementation owns side effects.
 *  - **Scalability.** O(1) Context read; React's own subscription
 *    machinery handles re-render scoping.
 *  - **Flexibility.** Same pattern works for every future capability
 *    namespace — add `useAudit()`, `useNotifications()`, `useBilling()`
 *    here as siblings of `useTelemetry()`. Implementation packages
 *    populate their own Context; builders import the hook.
 *  - **Future-readiness.** Doesn't lock to a specific SDK shape — the
 *    `TelemetryAPI` interface is the contract; standard/telemetry's
 *    SDK is one implementation. A future swap (e.g. native bridge for
 *    PWA shell) populates the same Context without builder churn.
 */

import * as React from 'react';

// ── TelemetryAPI ──────────────────────────────────────────────────────
//
// The runtime surface every `<TelemetryProvider>` populates. Mirrors the
// public surface of `@xdeck/telemetry-web` (`identify` / `alias` /
// `track` / `grantConsent` / `denyConsent`) but is declared HERE — the
// runtime-api lib — so builders depend on the contract, not the SDK.

export interface TelemetryAPI {
  /**
   * Associate subsequent events with `userId` and (optionally) `traits`.
   * Implementation forwards to the SDK's `identify()`. No-op if the
   * implementation is unconfigured (missing ingest key / DNT / consent
   * denied) — the contract is fire-and-forget.
   */
  identify(userId: string, traits?: Record<string, unknown>): void;
  /**
   * Tell the backend that `newUserId` is the same person as the user
   * previously known by `previousUserId`. Idempotent server-side.
   */
  alias(newUserId: string, previousUserId: string): void;
  /**
   * Emit a custom event. Implementations validate the event name + props
   * against the calling package's declared `telemetry.events.*` schema
   * (per §9.50 RA3); malformed payloads are rejected at the ingest boundary.
   */
  track(eventName: string, props?: Record<string, unknown>): void;
  /** User granted telemetry consent — implementation flushes buffered events. */
  grantConsent(): void;
  /** User denied telemetry consent — implementation empties the queue + suppresses future events. */
  denyConsent(): void;
}

// ── Context (the single source of truth) ──────────────────────────────
//
// `null` default — consumers MUST check the return value of
// `useTelemetry()`. We do NOT throw on missing Provider: a tenant
// without `standard/telemetry` installed (or with consent denied) is a
// valid state, not an error.

export const TelemetryContext = React.createContext<TelemetryAPI | null>(null);
TelemetryContext.displayName = 'XDeckTelemetryContext';

// ── Hook (the only thing builders import) ─────────────────────────────

/**
 * Read the active TelemetryAPI from React Context. Returns `null` when:
 *  - no Provider has mounted (telemetry package not installed for this tenant)
 *  - the calling component renders before the host shell hydrates
 *
 * Callers should optional-chain: `useTelemetry()?.track('event', ...)`.
 * That keeps builder code identical in tenants with + without telemetry.
 *
 * @example
 *   import { useTelemetry } from '@xdeck/runtime-api/react';
 *   const t = useTelemetry();
 *   const onSubmit = () => t?.track('appointment_booked', { slotId });
 */
export function useTelemetry(): TelemetryAPI | null {
  return React.useContext(TelemetryContext);
}

/**
 * Imperative variant of `useTelemetry()` — useful when builder code
 * needs to read the API inside an event handler created outside the
 * render path (e.g. inside a Zustand action). Calling code must still
 * handle the `null` case.
 *
 * Implementations should NOT call this in render — use the hook instead
 * (this version bypasses React's subscription machinery and won't re-
 * render on Context value changes).
 */
export function getTelemetryFromContext(ctx: TelemetryAPI | null): TelemetryAPI | null {
  return ctx;
}

// ── NotificationsAPI ──────────────────────────────────────────────────
//
// The `useNotifications()` sibling this module's header has always named.
// A package surface cannot import the host's notification store (an app
// internal), so a vertical that discovers something the deck should be told
// about had two bad options: render its own banner nobody sees once they
// navigate away, or ship nothing. This Context is the third: the HOST mounts
// the Provider over its own notification centre, and the package is a reader —
// exactly the telemetry arrangement above.

/**
 * A deck notification raised by a package surface.
 *
 * `key` is the whole design. A surface raises a notification because a
 * CONDITION holds ("three tables from last night are still unsettled"), and it
 * re-evaluates that condition on every poll, refetch and remount. Without a
 * stable key each pass would stack another copy until the centre was unusable,
 * which is how "helpful" notifications become the thing users mute. So a raise
 * is an UPSERT on `key`, and when the condition clears the surface calls
 * {@link NotificationsAPI.clear} with the same key.
 */
export interface DeckNotification {
  /**
   * Stable identity for the CONDITION, not the occurrence — e.g.
   * `restroin-foh:carried-over-orders`. Re-raising the same key replaces the
   * existing notification in place instead of adding another.
   */
  key: string;
  /** One line, in the user's language. Never internal vocabulary. */
  title: string;
  /** Optional second line with the detail that makes the title actionable. */
  body?: string;
  /** Drives the palette. Defaults to `info`. */
  severity?: 'info' | 'success' | 'warning' | 'error' | 'neutral';
  /** Where the primary action takes the user (an in-deck path). */
  href?: string;
  /** Label for that action. Defaults to a generic "Open" when `href` is set. */
  actionLabel?: string;
}

/**
 * What a package surface can do with the deck's notification centre.
 *
 * Deliberately narrow: raise and withdraw. A package cannot read other
 * packages' notifications, mark them read, or clear the centre — those are the
 * user's actions and the host's business.
 */
export interface NotificationsAPI {
  /**
   * Raise (or update in place) a notification. Returns the host's instance id,
   * or `null` when the host declined — callers should not depend on the value.
   */
  notify(notification: DeckNotification): string | null;
  /**
   * Withdraw the notification previously raised under `key`. Safe to call when
   * nothing was raised — a surface should be able to call this unconditionally
   * on the "condition no longer holds" path without tracking whether it ever
   * raised in the first place.
   */
  clear(key: string): void;
}

/**
 * `null` default, same contract as telemetry: a deck whose host has not mounted
 * the Provider is a valid state, not an error. Callers optional-chain.
 */
export const NotificationsContext = React.createContext<NotificationsAPI | null>(null);
NotificationsContext.displayName = 'XDeckNotificationsContext';

/**
 * Read the active NotificationsAPI from React Context. Returns `null` when no
 * Provider has mounted, so builder code is identical on a host that offers a
 * notification centre and one that doesn't.
 *
 * @example
 *   const notifications = useNotifications();
 *   React.useEffect(() => {
 *     if (unsettled.length === 0) return notifications?.clear('restroin-foh:carried-over-orders');
 *     notifications?.notify({
 *       key: 'restroin-foh:carried-over-orders',
 *       title: `${unsettled.length} orders still open from an earlier day`,
 *       severity: 'warning',
 *       href: '/foh/orders'
 *     });
 *   }, [unsettled.length, notifications]);
 */
export function useNotifications(): NotificationsAPI | null {
  return React.useContext(NotificationsContext);
}

// ── Record references ─────────────────────────────────────────────────
//
// `<RecordLink>` / `useRecordLabel()` — turn a stored uuid into the name a
// person uses for that record, plus a link to it. Re-exported here so every
// React-side deck concern arrives from one subpath.
//
// Unlike telemetry + notifications above, this needs NO Provider: it resolves
// through the deck's own same-origin action dispatcher, so a package surface and
// a host surface both get it working with zero wiring. A Context seam would mean
// references silently render as uuids anywhere a host forgot to mount it.

export {
  RecordLink,
  useRecordLabel,
  prefetchRecordLabels,
  peekRecordLabel,
  recordHref,
  shortRecordId,
  resetRecordLabelCache,
  type RecordLinkProps,
  type ResolvedRecordLabel
} from './record-labels';
