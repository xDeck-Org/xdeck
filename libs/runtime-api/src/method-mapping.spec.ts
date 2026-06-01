/**
 * §9.50 Phase B Slice 7 — XDECK_METHOD_MAP table contract.
 *
 * The map is consumed by `CapabilityStaticAnalyzerService` (backend) +
 * future CI drivers. Bugs here would silently misroute static analysis.
 * Spec covers:
 *  - Every entry's `capability` is a valid grantable string per Slice 1
 *    (catches typos like `notification:send` instead of `notification:send-in-app`)
 *  - Parameterized entries name a real family per the catalogue
 *  - Reserved entries are also marked reserved by Slice 1's
 *    `ensureNotReserved` (no false positives that would let a reserved
 *    method appear grantable)
 *  - Helpers: `lookupXdeckMethod` + `capabilityForMethodCall`
 */

import { ensureNotReserved, isGrantableCapability } from './capability';
import { ReservedCapabilityError } from './errors';
import {
  capabilityForMethodCall,
  lookupXdeckMethod,
  XDECK_METHOD_MAP,
  type XdeckMethodMapping
} from './method-mapping';

describe('XDECK_METHOD_MAP', () => {
  it('contains every Phase A wired method (email.send, notification.send, notification.broadcast)', () => {
    expect(XDECK_METHOD_MAP['email.send']).toEqual({ kind: 'static', capability: 'email:send' });
    expect(XDECK_METHOD_MAP['notification.send']).toEqual({
      kind: 'static',
      capability: 'notification:send-in-app'
    });
    expect(XDECK_METHOD_MAP['notification.broadcast']).toEqual({
      kind: 'static',
      capability: 'notification:broadcast'
    });
  });

  it('every static capability is grantable per the §9.50 catalogue (no typos)', () => {
    const staticEntries = Object.entries(XDECK_METHOD_MAP).filter(
      ([, m]) => (m as XdeckMethodMapping).kind === 'static'
    );
    expect(staticEntries.length).toBeGreaterThan(0);
    for (const [method, mapping] of staticEntries) {
      const m = mapping as Extract<XdeckMethodMapping, { kind: 'static' }>;
      expect({ method, grantable: isGrantableCapability(m.capability) }).toEqual({
        method,
        grantable: true
      });
    }
  });

  it('every parameterized entry names a grantable family (entity:read / entity:write / secret:read)', () => {
    const paramEntries = Object.entries(XDECK_METHOD_MAP).filter(
      ([, m]) => (m as XdeckMethodMapping).kind === 'parameterized'
    );
    expect(paramEntries.length).toBeGreaterThan(0);
    for (const [method, mapping] of paramEntries) {
      const m = mapping as Extract<XdeckMethodMapping, { kind: 'parameterized' }>;
      // Synthesise a sample fully-qualified capability and confirm grantability.
      const sample = `${m.family}:sample` as const;
      expect({ method, grantable: isGrantableCapability(sample) }).toEqual({ method, grantable: true });
      expect(m.argKey.length).toBeGreaterThan(0);
    }
  });

  it('every reserved entry passes Slice 1 `ensureNotReserved` rejection', () => {
    const reservedEntries = Object.entries(XDECK_METHOD_MAP).filter(
      ([, m]) => (m as XdeckMethodMapping).kind === 'reserved'
    );
    expect(reservedEntries.length).toBeGreaterThan(0);
    for (const [method, mapping] of reservedEntries) {
      const m = mapping as Extract<XdeckMethodMapping, { kind: 'reserved' }>;
      // Reserved family entries (`class.invoke`) need a resource id to round-trip
      // through ensureNotReserved (otherwise they parse as static `class:invoke`
      // which the family check skips). Synthesise a sample for the assertion.
      const probe =
        m.capability.includes(':') && m.capability.split(':').length === 2 && method === 'class.invoke'
          ? `${m.capability}:Sample`
          : m.capability;
      expect(() => ensureNotReserved(probe)).toThrow(ReservedCapabilityError);
    }
  });
});

describe('lookupXdeckMethod', () => {
  it('returns the mapping for a known method', () => {
    expect(lookupXdeckMethod('email.send')).toEqual({ kind: 'static', capability: 'email:send' });
    expect(lookupXdeckMethod('entity.read')).toEqual({
      kind: 'parameterized',
      family: 'entity:read',
      argKey: 'entityName'
    });
  });

  it('returns null for an unknown method', () => {
    expect(lookupXdeckMethod('frobnicate.foo')).toBeNull();
    expect(lookupXdeckMethod('email.frobnicate')).toBeNull();
    expect(lookupXdeckMethod('')).toBeNull();
  });
});

describe('capabilityForMethodCall', () => {
  it('returns the static capability for a known static method', () => {
    expect(capabilityForMethodCall('email.send')).toBe('email:send');
    expect(capabilityForMethodCall('notification.send')).toBe('notification:send-in-app');
  });

  it('returns the fully-qualified parameterized capability when given a resource id', () => {
    expect(capabilityForMethodCall('entity.read', 'Patient')).toBe('entity:read:Patient');
    expect(capabilityForMethodCall('secret.read', 'STRIPE_KEY')).toBe('secret:read:STRIPE_KEY');
  });

  it('returns null for parameterized method with no resource id (cannot statically resolve)', () => {
    expect(capabilityForMethodCall('entity.read')).toBeNull();
    expect(capabilityForMethodCall('secret.read', null)).toBeNull();
  });

  it('returns the reserved string for reserved methods (validator handles rejection downstream)', () => {
    expect(capabilityForMethodCall('event.emit')).toBe('event:emit');
    expect(capabilityForMethodCall('event.listen')).toBe('event:listen');
    // class.invoke is a reserved family; the helper returns the bare 'class:invoke'
    // string regardless of any resource arg. The analyzer surfaces this as
    // undeclared (the manifest cannot legally declare it per §9.50.9.1), so the
    // package is blocked the same way as any other undeclared usage. Refining to
    // 'class:invoke:<classId>' is unnecessary for blocking; can land later if
    // diagnostics ergonomics demand it.
    expect(capabilityForMethodCall('class.invoke', 'Notify')).toBe('class:invoke');
  });

  it('returns null for an unknown method', () => {
    expect(capabilityForMethodCall('frobnicate.foo')).toBeNull();
  });
});
