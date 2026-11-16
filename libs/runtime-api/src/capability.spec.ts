/**
 * §9.50 Slice 1 — capability catalogue tests. Locks the closed-set
 * vocabulary against accidental drift. When a future slice extends
 * the catalogue, these specs must be updated in the same PR — the
 * test failures are the forcing function.
 */

import {
  CAPABILITY_DESCRIPTIONS,
  CAPABILITY_FAMILY_DESCRIPTIONS,
  describeCapability,
  ensureNotReserved,
  GRANTABLE_PARAMETERIZED_FAMILIES,
  GRANTABLE_STATIC_CAPABILITIES,
  RESERVED_CAPABILITY_FAMILIES,
  RESERVED_STATIC_CAPABILITIES,
  SHIP_DARK_CAPABILITIES,
  isGrantableCapability,
  isShipDarkCapability,
  parameterizedCapability,
  parseCapability
} from './capability';

describe('GRANTABLE_STATIC_CAPABILITIES', () => {
  it('covers the §9.50.3 static capabilities + §9.77 iot + §9.50 RA-bridge telemetry + §9.146 consumer-link + §9.91.13 assert-dependant + profile-write + §9.156 rbac/scope reads + §9.158 digest + §9.166 invoice ledger + payment:refund + ADR-0035 delegated read (37 total)', () => {
    expect([...GRANTABLE_STATIC_CAPABILITIES].sort()).toEqual(
      [
        'ai:agent-invoke',
        'ai:complete',
        // §9.158 — the calling deck's daily business digest. Added to
        // GRANTABLE_STATIC_CAPABILITIES when the slice shipped; this list stayed at 26 and
        // the whole workspace went red, unnoticed because libs/runtime-api is not in the
        // backend jest run. The list is asserted EXHAUSTIVELY on purpose — that is what makes
        // a grant allowlist a guard — so a new capability must land here deliberately.
        'ai:digest-build',
        'ai:embed',
        'ai:knowledge-query',
        // §9.91.13 PR-2 — desk-side dependant assertion (a claim the holder reviews).
        'consumer:assert-dependant',
        // §9.91.13 PR-3b-ii — consumer self-profile write.
        'consumer:profile-write',
        // §9.146 — vertical-neutral §9.61 consumer-link primitive.
        'consumer:link',
        'email:send',
        // ADR-0035 — read AS the person who delegated it; static because the record types are
        // bounded by that person's delegation, which the host checks on every call.
        'entity:read-delegated',
        'http:fetch-allowlisted',
        'iot:device-control',
        'iot:device-read',
        'iot:event-listen',
        'iot:firmware-push',
        // §9.166 Step 6 — the deck invoice ledger. Four, not one, because they are four blast
        // radii: minting a legal document, reading it, recording money in, and money OUT.
        'invoice:credit',
        'invoice:issue',
        'invoice:read',
        'invoice:settle',
        'job:enqueue',
        'job:schedule',
        'notification:broadcast',
        'notification:send-in-app',
        'payment:initiate',
        // §9.166 Step 5 part 4 — money OUT on its own grant (device-denied; see device-capability.spec).
        'payment:refund',
        'push:send',
        // §9.156 — read-only authorization facts for the current deck + actor. Read-only by
        // design: there is deliberately no rbac:write or scope:write, because a sandboxed class
        // that could mint roles or widen its own scope is the privilege-escalation shape this
        // codebase has already fixed four P0s of.
        'rbac:read',
        'scope:read',
        'sms:send',
        'storage:read',
        'storage:write',
        'telemetry:identify',
        'telemetry:page',
        'telemetry:track',
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

describe('SHIP_DARK_CAPABILITIES (§9.166 decision 19)', () => {
  it('holds exactly the four invoice capabilities — widening or shrinking it is an owner decision', () => {
    expect([...SHIP_DARK_CAPABILITIES].sort()).toEqual([
      'invoice:credit',
      'invoice:issue',
      'invoice:read',
      'invoice:settle'
    ]);
  });

  it('every dark capability is still GRANTABLE in principle, so the tooling can build against it', () => {
    // The analyzer, the install validator and the drift gates all read the grantable list;
    // dark means "no deck may be granted it yet", which is a different question.
    for (const cap of SHIP_DARK_CAPABILITIES) {
      expect({ cap, grantable: isGrantableCapability(cap), dark: isShipDarkCapability(cap) }).toEqual({
        cap,
        grantable: true,
        dark: true
      });
    }
  });

  it('darkens nothing else in the catalogue', () => {
    const darkened = GRANTABLE_STATIC_CAPABILITIES.filter(
      (c) => isShipDarkCapability(c) && !(SHIP_DARK_CAPABILITIES as readonly string[]).includes(c)
    );
    expect(darkened).toEqual([]);
    expect(isShipDarkCapability('payment:initiate')).toBe(false);
    expect(isShipDarkCapability('invoice:read-from:restroin/restroin-core')).toBe(false);
  });
});

describe('RESERVED_STATIC_CAPABILITIES + RESERVED_CAPABILITY_FAMILIES', () => {
  it('reserves event:emit + event:listen per §9.50.9.1', () => {
    expect([...RESERVED_STATIC_CAPABILITIES].sort()).toEqual(['event:emit', 'event:listen']);
  });

  it('reserves class:invoke family per §9.50.9.1, and the designed-but-unbuilt invoice:read-from', () => {
    expect([...RESERVED_CAPABILITY_FAMILIES]).toEqual(['class:invoke', 'invoice:read-from']);
  });

  it('a reserved cross-package invoice read cannot be granted or declared, only refused by name', () => {
    // Three keys are needed before this may exist (the grant, the SOURCE package's ceiling,
    // the person's deck_invoices:read); until then no manifest can ask for it.
    expect(isGrantableCapability('invoice:read-from:restroin/restroin-core')).toBe(false);
    expect(() => ensureNotReserved('invoice:read-from:restroin/restroin-core')).toThrow(/reserved/);
    // …and it does not swallow the real, grantable read capability next to it.
    expect(isGrantableCapability('invoice:read')).toBe(true);
    expect(() => ensureNotReserved('invoice:read')).not.toThrow();
  });
});

describe('GRANTABLE_PARAMETERIZED_FAMILIES', () => {
  it('lists exactly entity:read/write + secret:read + binding:sign/verify + route:expose (class:invoke reserved)', () => {
    expect([...GRANTABLE_PARAMETERIZED_FAMILIES].sort()).toEqual([
      'binding:sign',
      'binding:verify',
      'entity:read',
      'entity:write',
      'route:expose',
      'secret:read'
    ]);
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

  it('§9.94 B3 — accepts a route:expose capability (resource = <ns>/<name>:<routeId>)', () => {
    expect(isGrantableCapability('route:expose:restroin/foh:place-order')).toBe(true);
    // parseCapability splits on the SECOND colon: family stays route:expose, the
    // inner `/` and `:` are inert inside the resource id.
    expect(parseCapability('route:expose:restroin/foh:place-order')).toEqual({
      family: 'route:expose',
      resourceId: 'restroin/foh:place-order'
    });
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

/**
 * §9.50 — the consent vocabulary.
 *
 * These are the forcing function that keeps a capability from reaching a human
 * approval screen as a bare grant string. The consent panel used to render
 * `iot:firmware-push` in a monospace chip and ask for approval; nothing in the
 * build stopped it, because the description simply did not exist.
 */
describe('capability descriptions', () => {
  it('every grantable static capability has a description', () => {
    const missing = GRANTABLE_STATIC_CAPABILITIES.filter((c) => !CAPABILITY_DESCRIPTIONS[c]);
    expect(missing).toEqual([]);
  });

  it('every grantable parameterized family has a description', () => {
    const missing = GRANTABLE_PARAMETERIZED_FAMILIES.filter((f) => !CAPABILITY_FAMILY_DESCRIPTIONS[f]);
    expect(missing).toEqual([]);
  });

  it('carries no description for a capability that is not in the catalogue', () => {
    // The map must not drift the other way either — a stale entry for a
    // capability that no longer exists is a sentence nobody can reach.
    const known = new Set<string>(GRANTABLE_STATIC_CAPABILITIES);
    const orphans = Object.keys(CAPABILITY_DESCRIPTIONS).filter((c) => !known.has(c));
    expect(orphans).toEqual([]);
  });

  it('speaks the deck vocabulary, never "tenant"', () => {
    const leaks = Object.entries(CAPABILITY_DESCRIPTIONS)
      .concat(Object.entries(CAPABILITY_FAMILY_DESCRIPTIONS))
      .filter(([, text]) => /\btenants?\b/i.test(text));
    expect(leaks).toEqual([]);
  });

  it('describes a static capability', () => {
    expect(describeCapability('email:send')).toMatch(/send email/i);
  });

  it('completes a parameterized family with its resource', () => {
    expect(describeCapability('entity:read:patient')).toMatch(/records of one type: patient/i);
    expect(describeCapability('secret:read:STRIPE_KEY')).toMatch(/named secret: STRIPE_KEY/i);
  });

  it('humanises an ENTITY name, and leaves every other resource exactly as written', () => {
    // An entity is a manifest class name, so it is made readable…
    expect(describeCapability('entity:read:MenuItemRating')).toBe('Read records of one type: Menu item rating.');
    // …while a secret key, a binding kind and a route id are identifiers a person has to
    // MATCH against something else, so rewriting them would name a thing that is not there.
    expect(describeCapability('secret:read:STRIPE_KEY')).toBe('Read one named secret: STRIPE_KEY.');
    expect(describeCapability('route:expose:restroin/foh:place-order')).toBe(
      'Serve one named web route: restroin/foh:place-order.'
    );
  });

  it('matches the LONGEST family prefix, so binding:sign is not read as a family called binding', () => {
    expect(describeCapability('binding:sign:table')).toMatch(/issue signed tokens/i);
    expect(describeCapability('binding:verify:table')).toMatch(/check signed tokens/i);
  });

  it('returns null rather than guessing at an unknown grant', () => {
    // Honest ignorance: the panel shows the raw id, which is safer than
    // inventing a reassuring sentence for a grant nobody recognises.
    expect(describeCapability('nonsense:verb')).toBeNull();
    expect(describeCapability('entity:read:')).toBeNull();
    expect(describeCapability('')).toBeNull();
  });
});
