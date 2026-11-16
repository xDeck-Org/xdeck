/**
 * The device registration gate. Two invariants, and one deliberate asymmetry.
 */
import {
  DEVICE_DENIED_STATIC_CAPABILITIES,
  checkDeviceCapabilities,
  isDeviceCapability,
  isDeviceDeniedCapability,
  isDeviceIoDirection,
  isObservationalCapability
} from './device-capability';
import { GRANTABLE_STATIC_CAPABILITIES, RESERVED_CAPABILITY_FAMILIES } from './capability';

describe('device capability vocabulary', () => {
  it('accepts the three parameterized families the dispatcher actually computes', () => {
    expect(isDeviceCapability('entity:read:QueueEntry')).toBe(true);
    expect(isDeviceCapability('entity:write:Attendance')).toBe(true);
    // Reserved against PACKAGES, required of DEVICES — the dispatcher computes exactly this.
    expect((RESERVED_CAPABILITY_FAMILIES as readonly string[]).includes('class:invoke')).toBe(true);
    expect(isDeviceCapability('class:invoke:CallNext.run')).toBe(true);
  });

  it('accepts every static capability the catalogue grants EXCEPT the device-denied ones', () => {
    // The catalogue is still the one list — a new static capability becomes device-grantable
    // at once, and a hand-copied list here would be the drift this module exists to prevent.
    // The deny-list only SUBTRACTS, and only what a device must never hold.
    for (const cap of GRANTABLE_STATIC_CAPABILITIES) {
      const denied = DEVICE_DENIED_STATIC_CAPABILITIES.includes(cap);
      expect({ cap, ok: isDeviceCapability(cap) }).toEqual({ cap, ok: !denied });
    }
  });

  it('CRITICAL: no device may record cash, void, credit or refund — the deny-list is pinned', () => {
    // Pinned exactly, because the failure it prevents is silent: before it existed a till
    // paired with invoice:credit would have registered cleanly and been able to refund.
    expect([...DEVICE_DENIED_STATIC_CAPABILITIES].sort()).toEqual([
      // ADR-0035 — a person's access lent to a package; no device acts as a person.
      'entity:read-delegated',
      'invoice:credit',
      'invoice:settle',
      'payment:refund'
    ]);
    // §9.166 Step 5 part 4 — `payment:refund` now EXISTS and is grantable to a package, and the
    // deny-list is what keeps it away from a device: a till may take money, never give it back.
    expect((GRANTABLE_STATIC_CAPABILITIES as readonly string[]).includes('payment:refund')).toBe(true);
    for (const cap of DEVICE_DENIED_STATIC_CAPABILITIES) {
      expect({ cap, device: isDeviceCapability(cap), denied: isDeviceDeniedCapability(cap) }).toEqual({
        cap,
        device: false,
        denied: true
      });
    }
  });

  it('a device MAY issue and read invoices — a kiosk or a till is a real device use', () => {
    // The deny-list is narrow on purpose. Refusing the whole invoice family would push
    // every counter back onto a person's session for the one step that does not need one.
    expect(isDeviceCapability('invoice:issue')).toBe(true);
    expect(isDeviceCapability('invoice:read')).toBe(true);
  });

  it('REFUSES a typo, an invented family, and an empty resource', () => {
    // The defect this closes: these paired fine and then failed every dispatch, because
    // the runtime gate fails closed on a capability that matches nothing.
    expect(isDeviceCapability('entity:reed:QueueEntry')).toBe(false);
    expect(isDeviceCapability('entity:read:')).toBe(false);
    expect(isDeviceCapability('entity:read:   ')).toBe(false);
    expect(isDeviceCapability('database:drop:everything')).toBe(false);
    expect(isDeviceCapability('not-a-capability')).toBe(false);
    expect(isDeviceCapability('')).toBe(false);
  });
});

describe('observational classification', () => {
  it('only entity:read and the provably read-only statics observe', () => {
    expect(isObservationalCapability('entity:read:QueueEntry')).toBe(true);
    expect(isObservationalCapability('storage:read')).toBe(true);
    expect(isObservationalCapability('iot:device-read')).toBe(true);
    expect(isObservationalCapability('entity:write:Attendance')).toBe(false);
    expect(isObservationalCapability('email:send')).toBe(false);
    expect(isObservationalCapability('storage:write')).toBe(false);
  });

  it('class:invoke is NOT observational — the string cannot tell you if the body writes', () => {
    expect(isObservationalCapability('class:invoke:ReadOnlyBoard.render')).toBe(false);
  });

  it('CRITICAL: the observational list itself is pinned — every OTHER catalogue capability is effectful', () => {
    // The list decides what an `out` device may hold, and until this test it was unguarded:
    // adding a device-COMMAND capability to it (iot:device-control, say) would silently let a
    // wall screen command hardware, and every other test still passed. Asserting the
    // COMPLEMENT — everything not on the list is effectful — is what makes a widening fail,
    // because a hand-written "these are effectful" list would drift as the catalogue grows.
    const observational = GRANTABLE_STATIC_CAPABILITIES.filter((c) => isObservationalCapability(c));
    expect([...observational].sort()).toEqual(['iot:device-read', 'rbac:read', 'scope:read', 'storage:read']);

    // Named explicitly because these are the ones a widening would most plausibly reach for.
    // `invoice:read` is among them deliberately: it is read-only at the ledger, but a
    // restricted invoice returns health information to its issuing package, and a wall
    // screen is a disclosure surface — conservative, as the classifier promises.
    for (const effectful of [
      'iot:device-control',
      'iot:firmware-push',
      'iot:event-listen',
      'storage:write',
      'payment:initiate',
      'notification:broadcast',
      'invoice:read',
      'invoice:issue'
    ]) {
      expect({ cap: effectful, observational: isObservationalCapability(effectful) }).toEqual({
        cap: effectful,
        observational: false
      });
    }
  });

  it('an out device is refused every effectful catalogue capability, one by one', () => {
    for (const cap of GRANTABLE_STATIC_CAPABILITIES) {
      const expected = isObservationalCapability(cap);
      expect({ cap, allowed: checkDeviceCapabilities('out', [cap]).valid }).toEqual({ cap, allowed: expected });
    }
  });
});

describe('checkDeviceCapabilities', () => {
  it('a display-only device may hold reads', () => {
    const r = checkDeviceCapabilities('out', ['entity:read:QueueEntry', 'entity:read:QueuePriority']);
    expect(r).toEqual({ valid: true, unknown: [], deniedForDevices: [], forbiddenForDirection: [] });
  });

  it('CRITICAL: a device-denied capability is refused on EVERY direction, and not called a typo', () => {
    for (const direction of ['in', 'out', 'inout'] as const) {
      const r = checkDeviceCapabilities(direction, ['invoice:issue', 'invoice:settle', 'payment:refund']);
      expect(r.valid).toBe(false);
      expect(r.deniedForDevices).toEqual(['invoice:settle', 'payment:refund']);
      // Spelled correctly, so they must NOT be reported as unknown — "check the spelling"
      // would send an operator hunting for a typo that is not there.
      expect(r.unknown).toEqual([]);
      expect(r.reason).toMatch(/no device may be given these/);
      expect(r.reason).not.toMatch(/Check the spelling/);
    }
  });

  it('a two-way till may be given invoice issue and read, and nothing more of the ledger', () => {
    expect(checkDeviceCapabilities('inout', ['invoice:issue', 'invoice:read']).valid).toBe(true);
    expect(checkDeviceCapabilities('inout', ['invoice:issue', 'invoice:credit']).valid).toBe(false);
  });

  it('CRITICAL: a display-only device cannot be given the ability to change anything', () => {
    const r = checkDeviceCapabilities('out', ['entity:read:QueueEntry', 'entity:write:QueueEntry']);
    expect(r.valid).toBe(false);
    expect(r.forbiddenForDirection).toEqual(['entity:write:QueueEntry']);
    expect(r.reason).toMatch(/display-only device cannot be given the ability to change anything/);
  });

  it('a display-only device cannot invoke a class either', () => {
    expect(checkDeviceCapabilities('out', ['class:invoke:CallNext.run']).valid).toBe(false);
  });

  it('an INPUT device keeps its reads — the asymmetry is deliberate', () => {
    // A reader usually has to look something up to know what it just scanned. Forbidding
    // reads on `in` would be symmetry for its own sake and would break real hardware.
    const r = checkDeviceCapabilities('in', ['entity:write:Attendance', 'entity:read:Staff']);
    expect(r.valid).toBe(true);
  });

  it('a two-way device may hold both', () => {
    expect(checkDeviceCapabilities('inout', ['entity:read:Table', 'entity:write:ServiceCall']).valid).toBe(true);
  });

  it('reports BOTH failure kinds at once, so a fix is one round trip', () => {
    const r = checkDeviceCapabilities('out', ['entity:reed:Typo', 'entity:write:QueueEntry']);
    expect(r.unknown).toEqual(['entity:reed:Typo']);
    expect(r.forbiddenForDirection).toEqual(['entity:write:QueueEntry']);
    expect(r.reason).toMatch(/Check the spelling/);
    expect(r.reason).toMatch(/display-only/);
  });

  it('an unknown capability is never ALSO reported as a direction problem', () => {
    // Otherwise a typo would read as two defects and send the operator chasing the wrong one.
    const r = checkDeviceCapabilities('out', ['nonsense:string:here']);
    expect(r.unknown).toEqual(['nonsense:string:here']);
    expect(r.forbiddenForDirection).toEqual([]);
  });

  it('the empty grant is valid for every direction — a device with nothing is not an error', () => {
    for (const d of ['in', 'out', 'inout'] as const) {
      expect(checkDeviceCapabilities(d, []).valid).toBe(true);
    }
  });

  it('isDeviceIoDirection is the closed set', () => {
    expect(['in', 'out', 'inout'].every(isDeviceIoDirection)).toBe(true);
    expect(isDeviceIoDirection('both')).toBe(false);
    expect(isDeviceIoDirection(undefined)).toBe(false);
  });
});
