/**
 * §9.50 Slice 1 — capability catalogue tests. Locks the closed-set
 * vocabulary against accidental drift. When a future slice extends
 * the catalogue, these specs must be updated in the same PR — the
 * test failures are the forcing function.
 */

import {
  GRANTABLE_PARAMETERIZED_FAMILIES,
  GRANTABLE_STATIC_CAPABILITIES,
  RESERVED_CAPABILITY_FAMILIES,
  RESERVED_STATIC_CAPABILITIES,
  isGrantableCapability,
  parameterizedCapability,
  parseCapability
} from './capability';

describe('GRANTABLE_STATIC_CAPABILITIES', () => {
  it('covers the §9.50.3 static capabilities + §9.77 iot (22 total)', () => {
    expect([...GRANTABLE_STATIC_CAPABILITIES].sort()).toEqual(
      [
        'ai:agent-invoke',
        'ai:complete',
        'ai:embed',
        'ai:knowledge-query',
        'email:send',
        'http:fetch-allowlisted',
        'iot:device-control',
        'iot:device-read',
        'iot:event-listen',
        'iot:firmware-push',
        'job:enqueue',
        'job:schedule',
        'notification:broadcast',
        'notification:send-in-app',
        'payment:initiate',
        'push:send',
        'sms:send',
        'storage:read',
        'storage:write',
        'template:render',
        'webhook:send',
        'whatsapp:send'
      ].sort()
    );
  });

  it('does not overlap with RESERVED_STATIC_CAPABILITIES', () => {
    const overlap = (GRANTABLE_STATIC_CAPABILITIES as readonly string[]).filter((c) =>
      (RESERVED_STATIC_CAPABILITIES as readonly string[]).includes(c)
    );
    expect(overlap).toEqual([]);
  });
});

describe('RESERVED_STATIC_CAPABILITIES + RESERVED_CAPABILITY_FAMILIES', () => {
  it('reserves event:emit + event:listen per §9.50.9.1', () => {
    expect([...RESERVED_STATIC_CAPABILITIES].sort()).toEqual(['event:emit', 'event:listen']);
  });

  it('reserves class:invoke family per §9.50.9.1', () => {
    expect([...RESERVED_CAPABILITY_FAMILIES]).toEqual(['class:invoke']);
  });
});

describe('GRANTABLE_PARAMETERIZED_FAMILIES', () => {
  it('lists exactly entity:read + entity:write + secret:read (class:invoke reserved)', () => {
    expect([...GRANTABLE_PARAMETERIZED_FAMILIES].sort()).toEqual(['entity:read', 'entity:write', 'secret:read']);
  });

  it('does not overlap with RESERVED_CAPABILITY_FAMILIES', () => {
    const overlap = (GRANTABLE_PARAMETERIZED_FAMILIES as readonly string[]).filter((f) =>
      (RESERVED_CAPABILITY_FAMILIES as readonly string[]).includes(f)
    );
    expect(overlap).toEqual([]);
  });
});

describe('parameterizedCapability', () => {
  it('joins family + resource id with a colon', () => {
    expect(parameterizedCapability('entity:read', 'approvalRequest')).toBe('entity:read:approvalRequest');
    expect(parameterizedCapability('secret:read', 'STRIPE_KEY')).toBe('secret:read:STRIPE_KEY');
  });

  it('preserves resource ids with internal colons (e.g. namespaced classes)', () => {
    expect(parameterizedCapability('class:invoke', 'standard/notify')).toBe('class:invoke:standard/notify');
  });
});

describe('parseCapability', () => {
  it('parses a static capability with null resourceId', () => {
    expect(parseCapability('email:send')).toEqual({ family: 'email:send', resourceId: null });
  });

  it('parses a parameterized capability with the resource id after the second colon', () => {
    expect(parseCapability('entity:read:approvalRequest')).toEqual({
      family: 'entity:read',
      resourceId: 'approvalRequest'
    });
  });

  it('keeps trailing colons inside the resource id (e.g. namespaced ids)', () => {
    expect(parseCapability('class:invoke:standard/notify')).toEqual({
      family: 'class:invoke',
      resourceId: 'standard/notify'
    });
  });

  it('returns null for empty / non-string input', () => {
    expect(parseCapability('')).toBeNull();
    expect(parseCapability(undefined as unknown as string)).toBeNull();
    expect(parseCapability(null as unknown as string)).toBeNull();
    expect(parseCapability('no-colon')).toBeNull();
  });
});

describe('isGrantableCapability', () => {
  it('accepts every static capability in GRANTABLE_STATIC_CAPABILITIES', () => {
    for (const cap of GRANTABLE_STATIC_CAPABILITIES) {
      expect(isGrantableCapability(cap)).toBe(true);
    }
  });

  it('accepts well-formed parameterized capabilities for grantable families', () => {
    expect(isGrantableCapability('entity:read:approvalRequest')).toBe(true);
    expect(isGrantableCapability('entity:write:approvalRequest')).toBe(true);
    expect(isGrantableCapability('secret:read:STRIPE_KEY')).toBe(true);
  });

  it('rejects reserved static capabilities', () => {
    expect(isGrantableCapability('event:emit')).toBe(false);
    expect(isGrantableCapability('event:listen')).toBe(false);
  });

  it('rejects parameterized capabilities under reserved families', () => {
    expect(isGrantableCapability('class:invoke:standard/notify')).toBe(false);
  });

  it('rejects unknown families', () => {
    expect(isGrantableCapability('telemetry:send')).toBe(false);
    expect(isGrantableCapability('foo:bar:baz')).toBe(false);
  });

  it('rejects parameterized capability with empty resource id', () => {
    expect(isGrantableCapability('entity:read:')).toBe(false);
  });

  it('rejects malformed / empty input', () => {
    expect(isGrantableCapability('')).toBe(false);
    expect(isGrantableCapability('no-colon')).toBe(false);
  });
});
