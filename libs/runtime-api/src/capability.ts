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
  | 'iot:firmware-push';

/**
 * Capability families that require a per-resource grant. The manifest
 * declares a fully-qualified string (e.g. `entity:read:approvalRequest`)
 * and the runtime checks the grant for that exact string.
 */
export type ParameterizedCapabilityFamily = 'entity:read' | 'entity:write' | 'class:invoke' | 'secret:read';

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
export const RESERVED_CAPABILITY_FAMILIES: readonly ParameterizedCapabilityFamily[] = ['class:invoke'] as const;

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
  'iot:device-control',
  'iot:device-read',
  'iot:event-listen',
  'iot:firmware-push'
] as const;

/**
 * Runtime-iterable mirror of every parameterized family that IS grantable.
 * Reserved families (`class:invoke`) excluded.
 */
export const GRANTABLE_PARAMETERIZED_FAMILIES: readonly ParameterizedCapabilityFamily[] = [
  'entity:read',
  'entity:write',
  'secret:read'
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
    throw new ReservedCapabilityError(cap, `static capability '${parsed.family}' reserved per §9.50.9.1`);
  }
  if (
    parsed.resourceId !== null &&
    (RESERVED_CAPABILITY_FAMILIES as readonly string[]).includes(parsed.family as ParameterizedCapabilityFamily)
  ) {
    throw new ReservedCapabilityError(cap, `family '${parsed.family}' reserved per §9.50.9.1`);
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
