/**
 * DEVICE I/O DIRECTION — what a non-human principal is allowed to be.
 *
 * A deck's devices are not all the same shape. A waiting-room screen only ever SHOWS
 * deck data; an attendance reader only ever SENDS readings in; a service-caller pad does
 * both; and a purpose-built IoT board can be any of the three. Until now the only thing
 * separating them was the capability array an admin typed at pairing: `deviceType` is
 * documented on the entity as "a discriminator for UX / metadata-schema dispatch" and
 * carries no authorization meaning at all.
 *
 * That left two real gaps, and both have bitten:
 *
 *  1. **Nothing stopped a screen from writing.** "Display-only" was a convention held up
 *     by whoever filled in the form. One mistyped `entity:write:` on a wall-mounted
 *     screen is a device that can mutate deck records, and no code would have objected.
 *  2. **A typo produced a silently dead device.** Capability strings were accepted
 *     unvalidated — `TenantDevicePairingService` recorded that deliberately under "what
 *     this service does NOT do", noting a follow-up slice could plug the catalogue in
 *     additively. This is that slice. `entity:read:QueueEntyr` paired happily and then
 *     failed every dispatch, because the runtime gate fails closed on a capability that
 *     matches nothing: the device looked registered and did nothing.
 *
 * **Why this lives HERE, next to the catalogue.** The classification below is only ever
 * correct relative to `GRANTABLE_STATIC_CAPABILITIES` and the parameterized families in
 * this same file. A classifier that can drift from its own vocabulary is a gate that
 * silently stops matching what it guards; co-locating them makes that drift a
 * one-file review instead of a cross-package coincidence.
 *
 * **The invariant is deliberately ASYMMETRIC, and that is the point.** An `out` device
 * may hold only observational capabilities. An `in` device is NOT forbidden reads — a
 * reader commonly has to look something up to know what it just scanned, and forbidding
 * that would be symmetry for its own sake, breaking real hardware to make a table look
 * tidy. The rule that earns its keep is the one that cannot be argued with: a screen
 * must never be able to change what it displays.
 */

import { GRANTABLE_STATIC_CAPABILITIES } from './capability';
import { parseCapability } from './capability';

/**
 * Which way data flows, from the DEVICE's point of view — the three shapes an operator
 * uses when describing hardware.
 *
 *  - `out`   — the deck sends, the device shows. Screens, wall boards, signage.
 *  - `in`    — the device sends, the deck records. Readers, scanners, sensors.
 *  - `inout` — both. Service-caller pads, terminals, purpose-built IoT boards.
 */
export type DeviceIoDirection = 'in' | 'out' | 'inout';

export const DEVICE_IO_DIRECTIONS: readonly DeviceIoDirection[] = ['in', 'out', 'inout'] as const;

export function isDeviceIoDirection(value: unknown): value is DeviceIoDirection {
  return typeof value === 'string' && (DEVICE_IO_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * The parameterized families a DEVICE may hold.
 *
 * `class:invoke` is in {@link RESERVED_CAPABILITY_FAMILIES} — reserved against
 * *packages*, which must not grant themselves arbitrary class execution. A device is the
 * other case: the dispatcher computes exactly `class:invoke:<Class>.<method>` as the
 * capability a device principal must present for a class action, so refusing the family
 * here would reject the very capability the gate demands. Admitted for devices,
 * deliberately, and named so nobody "fixes" it back.
 */
const DEVICE_PARAMETERIZED_FAMILIES: readonly string[] = ['entity:read', 'entity:write', 'class:invoke'];

/**
 * Capabilities that only ever OBSERVE. Everything else is treated as effectful,
 * including anything that sends, spends, schedules or invokes.
 *
 * Conservative on purpose: a capability counts as read-only when it is provably
 * read-only. `class:invoke` is absent because a class method's body may write and the
 * capability string cannot tell you which — so a screen that genuinely needs to call one
 * is not display-only, and whoever registers it should say so.
 */
const READ_ONLY_STATIC_CAPABILITIES: readonly string[] = ['storage:read', 'iot:device-read', 'rbac:read', 'scope:read'];

/**
 * §9.166 Step 6 — capabilities NO device may hold, whatever its direction.
 *
 * {@link isDeviceCapability} admits every grantable static capability, which was right
 * while every static capability was about sending, reading or scheduling. The invoice
 * ledger breaks that: a device may ISSUE a bill (a kiosk, a till) but must never record
 * cash, void, credit or refund one, because the only evidence cash exists is a person
 * saying so, and money out needs someone to answer for it. Refusing these at PAIRING is
 * the first of two walls — the ledger's principal matrix refuses a device again at the
 * call — so one mistyped registration cannot give a wall-mounted till refund authority.
 *
 * `payment:refund` is listed before it exists (§9.166 Step 5 adds it), so it arrives
 * closed for devices rather than open until someone remembers. A string that names no
 * capability is harmless in a deny-list; a capability that is missing from one is not.
 *
 * `entity:read-delegated` (ADR-0035) is a PERSON's access lent to a package for when they are
 * away. No device acts as a person, so no device holds it — closed at pairing, not left inert.
 */
export const DEVICE_DENIED_STATIC_CAPABILITIES: readonly string[] = Object.freeze([
  'invoice:settle',
  'invoice:credit',
  'payment:refund',
  'entity:read-delegated'
]);

/** Is this capability one no device may ever hold? */
export function isDeviceDeniedCapability(cap: string): boolean {
  const parsed = parseCapability(cap);
  return !!parsed && parsed.resourceId === null && DEVICE_DENIED_STATIC_CAPABILITIES.includes(parsed.family);
}

/** Is this capability purely observational? */
export function isObservationalCapability(cap: string): boolean {
  const parsed = parseCapability(cap);
  if (!parsed) return false;
  if (parsed.resourceId === null) return READ_ONLY_STATIC_CAPABILITIES.includes(parsed.family);
  return parsed.family === 'entity:read' && parsed.resourceId.trim().length > 0;
}

/**
 * Is this a capability a device could ever USE?
 *
 * Closed set: a parameterized family the dispatcher actually computes, or a static
 * capability from the grantable catalogue. Anything else — a typo, an invented family, a
 * package-only reserved string — is refused at registration rather than accepted into a
 * device that would then fail every dispatch for a reason no operator could see.
 */
export function isDeviceCapability(cap: string): boolean {
  const parsed = parseCapability(cap);
  if (!parsed) return false;
  if (parsed.resourceId === null) {
    if (DEVICE_DENIED_STATIC_CAPABILITIES.includes(parsed.family)) return false;
    return (GRANTABLE_STATIC_CAPABILITIES as readonly string[]).includes(parsed.family);
  }
  if (!DEVICE_PARAMETERIZED_FAMILIES.includes(parsed.family)) return false;
  return parsed.resourceId.trim().length > 0;
}

export interface DeviceCapabilityCheck {
  readonly valid: boolean;
  /** Capabilities no device could ever use (typo, invented family, package-only). */
  readonly unknown: readonly string[];
  /**
   * Real capabilities that are refused for EVERY device ({@link DEVICE_DENIED_STATIC_CAPABILITIES}).
   * Reported apart from `unknown` because the advice is different: these are spelled right,
   * and telling an operator to check the spelling would send them looking for a typo that
   * is not there.
   */
  readonly deniedForDevices: readonly string[];
  /** Effectful capabilities on an `out` device — the display-cannot-write invariant. */
  readonly forbiddenForDirection: readonly string[];
  /** Operator-facing sentence; present exactly when `valid` is false. */
  readonly reason?: string;
}

/**
 * The registration-time gate. Returns a verdict rather than throwing, so the caller owns
 * the error shape and so BOTH halves of a failure are reported at once — an operator
 * fixing a typo should not then discover a direction problem on the retry.
 */
export function checkDeviceCapabilities(
  direction: DeviceIoDirection,
  capabilities: readonly string[]
): DeviceCapabilityCheck {
  const deniedForDevices = capabilities.filter((c) => isDeviceDeniedCapability(c));
  const unknown = capabilities.filter((c) => !isDeviceCapability(c) && !isDeviceDeniedCapability(c));
  const forbiddenForDirection =
    direction === 'out' ? capabilities.filter((c) => isDeviceCapability(c) && !isObservationalCapability(c)) : [];

  if (unknown.length === 0 && forbiddenForDirection.length === 0 && deniedForDevices.length === 0) {
    return { valid: true, unknown, deniedForDevices, forbiddenForDirection };
  }

  const parts: string[] = [];
  if (deniedForDevices.length > 0) {
    parts.push(
      `no device may be given these, whatever it is used for: ${deniedForDevices.join(', ')}. ` +
        `Recording a payment, and cancelling, crediting or refunding an invoice, need a person — ` +
        `sign a cashier in on the device instead.`
    );
  }
  if (unknown.length > 0) {
    parts.push(
      `not capabilities this deck can grant a device: ${unknown.join(', ')}. Check the spelling — ` +
        `a device paired with one of these registers successfully and is then refused every time it tries to act.`
    );
  }
  if (forbiddenForDirection.length > 0) {
    parts.push(
      `a display-only device cannot be given the ability to change anything: ${forbiddenForDirection.join(', ')}. ` +
        `Register it as an input or two-way device if it genuinely needs to.`
    );
  }
  return { valid: false, unknown, deniedForDevices, forbiddenForDirection, reason: parts.join(' ') };
}
