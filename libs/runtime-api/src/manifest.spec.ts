/**
 * §9.50 Slice 1 — manifest-capability validation tests. This is the
 * spec Slice 2 (AJV manifest validator) + Slice 7 (CI gate) wire into.
 */

import type { Capability } from './capability';
import { ReservedCapabilityError, UnknownCapabilityError } from './errors';
import { validateManifestCapabilities } from './manifest';

// The validator's whole job is to reject strings that don't pass the
// type-level Capability union. The cast lets us hand it strings the
// type would refuse — that's the runtime safety net we're testing.
const cap = (s: string) => s as Capability;

describe('validateManifestCapabilities', () => {
  it('accepts an empty manifest (pure-utility package)', () => {
    const r = validateManifestCapabilities({ required: [] });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts the canonical approval-finance manifest example from §9.50.2', () => {
    const r = validateManifestCapabilities({
      required: [
        'notification:send-in-app',
        'email:send',
        'ai:complete',
        'template:render',
        'ai:knowledge-query',
        'entity:read:approval-request',
        'entity:write:approval-request',
        'job:schedule'
      ],
      optional: ['whatsapp:send', 'sms:send']
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('reports UnknownCapabilityError for typos / unknown families', () => {
    const r = validateManifestCapabilities({
      required: [cap('notification:send-in-aap'), 'email:send', cap('telemetry:send')]
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toBeInstanceOf(UnknownCapabilityError);
    expect((r.errors[0] as UnknownCapabilityError).capability).toBe('notification:send-in-aap');
    expect(r.errors[1]).toBeInstanceOf(UnknownCapabilityError);
    expect((r.errors[1] as UnknownCapabilityError).capability).toBe('telemetry:send');
  });

  it('reports ReservedCapabilityError for class:invoke (family reserved per §9.50.9.1)', () => {
    const r = validateManifestCapabilities({
      required: ['class:invoke:standard/notify']
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toBeInstanceOf(ReservedCapabilityError);
    expect((r.errors[0] as ReservedCapabilityError).capability).toBe('class:invoke:standard/notify');
  });

  it('reports ReservedCapabilityError for event:emit + event:listen', () => {
    const r = validateManifestCapabilities({
      required: [cap('event:emit'), cap('event:listen')]
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(2);
    expect(r.errors.every((e) => e instanceof ReservedCapabilityError)).toBe(true);
  });

  it('collects ALL violations in one pass (does not short-circuit)', () => {
    const r = validateManifestCapabilities({
      required: ['email:send', cap('event:emit'), cap('unknown:thing'), 'class:invoke:foo']
    });
    expect(r.errors).toHaveLength(3);
    const codes = r.errors.map((e) => e.code).sort();
    expect(codes).toEqual(['RESERVED_CAPABILITY', 'RESERVED_CAPABILITY', 'UNKNOWN_CAPABILITY']);
  });

  it('validates `optional` entries with the same rules as `required`', () => {
    const r = validateManifestCapabilities({
      required: ['email:send'],
      optional: [cap('event:listen')]
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toBeInstanceOf(ReservedCapabilityError);
  });

  it('rejects parameterized capability with empty resource id', () => {
    const r = validateManifestCapabilities({
      required: ['entity:read:']
    });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toBeInstanceOf(UnknownCapabilityError);
  });
});
