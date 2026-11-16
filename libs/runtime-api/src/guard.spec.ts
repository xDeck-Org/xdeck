/**
 * §9.50 Phase A Slice 3 — RuntimeGuard tests. Locks the enforcement
 * contract the sandbox host (follow-up sub-slice) + Slice 5a
 * notification/email wiring depend on.
 */

import type { Capability } from './capability';
import { CapabilityNotGrantedError, ReservedCapabilityError } from './errors';
import { RuntimeGuard } from './guard';
import { DECK_CODE_PACKAGE, DECK_CODE_PACKAGE_NAME } from './deck-code-identity';
import { InMemoryGrantsRepository, type CapabilityAuditEntry, type GuardContext } from './ports';

const tfg: GuardContext = {
  deckId: 'tfg',
  tenantSlug: 'tfg',
  env: 'dev',
  packageName: 'standard/notify',
  packageVersion: '1.0.0'
};

describe('RuntimeGuard.ensureGranted — happy path', () => {
  it('resolves void when the capability is in the tenant grant set', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const guard = new RuntimeGuard({ repository: repo });
    await expect(guard.ensureGranted('email:send', tfg)).resolves.toBeUndefined();
  });

  it('resolves for a parameterized capability when its full string is granted', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['entity:read:approvalRequest'] }]);
    const guard = new RuntimeGuard({ repository: repo });
    await expect(guard.ensureGranted('entity:read:approvalRequest', tfg)).resolves.toBeUndefined();
    await expect(guard.ensureGranted('entity:read:otherEntity', tfg)).rejects.toBeInstanceOf(CapabilityNotGrantedError);
  });
});

describe('RuntimeGuard.ensureGranted — ungranted throws CapabilityNotGrantedError', () => {
  it('throws when the capability is not in the grant set', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['notification:send-in-app'] }]);
    const guard = new RuntimeGuard({ repository: repo });
    await expect(guard.ensureGranted('email:send', tfg)).rejects.toBeInstanceOf(CapabilityNotGrantedError);
  });

  it('carries capability + packageName + deckId on the error', async () => {
    const repo = new InMemoryGrantsRepository();
    const guard = new RuntimeGuard({ repository: repo });
    try {
      await guard.ensureGranted('email:send', tfg);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityNotGrantedError);
      const e = err as CapabilityNotGrantedError;
      expect(e.capability).toBe('email:send');
      expect(e.packageName).toBe('standard/notify');
      expect(e.deckId).toBe('tfg');
    }
  });

  it('scopes by tenant — a grant on TFG does not satisfy ACME', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const guard = new RuntimeGuard({ repository: repo });
    const acme = { ...tfg, deckId: 'acme' };
    await expect(guard.ensureGranted('email:send', acme)).rejects.toBeInstanceOf(CapabilityNotGrantedError);
  });

  it('scopes by package version — a grant on 1.0.0 does not satisfy 2.0.0', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const guard = new RuntimeGuard({ repository: repo });
    const v2 = { ...tfg, packageVersion: '2.0.0' };
    await expect(guard.ensureGranted('email:send', v2)).rejects.toBeInstanceOf(CapabilityNotGrantedError);
  });
});

describe('RuntimeGuard.ensureGranted — reserved throws ReservedCapabilityError (precedence)', () => {
  it('event:emit throws ReservedCapabilityError even if "granted" in the repo', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['event:emit' as Capability] }]);
    const guard = new RuntimeGuard({ repository: repo });
    await expect(guard.ensureGranted('event:emit' as Capability, tfg)).rejects.toBeInstanceOf(ReservedCapabilityError);
  });

  it('class:invoke:<id> throws ReservedCapabilityError', async () => {
    const repo = new InMemoryGrantsRepository();
    const guard = new RuntimeGuard({ repository: repo });
    await expect(guard.ensureGranted('class:invoke:standard/notify' as Capability, tfg)).rejects.toBeInstanceOf(
      ReservedCapabilityError
    );
  });

  it('reservation precedence: ReservedCapabilityError fires BEFORE CapabilityNotGrantedError', async () => {
    const repo = new InMemoryGrantsRepository(); // empty — nothing granted
    const guard = new RuntimeGuard({ repository: repo });
    let err: Error | null = null;
    try {
      await guard.ensureGranted('event:listen' as Capability, tfg);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(ReservedCapabilityError);
    expect(err).not.toBeInstanceOf(CapabilityNotGrantedError);
  });
});

describe('RuntimeGuard — caching', () => {
  it('caches the grant set across calls in the same TTL window', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const spy = jest.spyOn(repo, 'findGrants');
    const guard = new RuntimeGuard({ repository: repo, cacheTtlMs: 60_000, clock: () => 1_000 });
    await guard.ensureGranted('email:send', tfg);
    await guard.ensureGranted('email:send', tfg);
    await guard.ensureGranted('email:send', tfg);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the TTL elapses', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const spy = jest.spyOn(repo, 'findGrants');
    let now = 1_000;
    const guard = new RuntimeGuard({ repository: repo, cacheTtlMs: 60_000, clock: () => now });
    await guard.ensureGranted('email:send', tfg);
    expect(spy).toHaveBeenCalledTimes(1);
    now += 30_000; // half-life — still cached
    await guard.ensureGranted('email:send', tfg);
    expect(spy).toHaveBeenCalledTimes(1);
    now += 31_000; // past TTL — re-fetch
    await guard.ensureGranted('email:send', tfg);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('invalidate(ctx) drops one entry without affecting others', async () => {
    const repo = new InMemoryGrantsRepository([
      { ...tfg, capabilities: ['email:send'] },
      { ...tfg, deckId: 'acme', capabilities: ['email:send'] }
    ]);
    const spy = jest.spyOn(repo, 'findGrants');
    const guard = new RuntimeGuard({ repository: repo });
    const acme = { ...tfg, deckId: 'acme' };

    await guard.ensureGranted('email:send', tfg);
    await guard.ensureGranted('email:send', acme);
    expect(spy).toHaveBeenCalledTimes(2);

    guard.invalidate(tfg);
    await guard.ensureGranted('email:send', tfg);
    await guard.ensureGranted('email:send', acme);
    // TFG re-fetched (3), ACME still cached.
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('cacheTtlMs:0 disables caching — every call hits the repository', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const spy = jest.spyOn(repo, 'findGrants');
    const guard = new RuntimeGuard({ repository: repo, cacheTtlMs: 0 });
    await guard.ensureGranted('email:send', tfg);
    await guard.ensureGranted('email:send', tfg);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('reflects revoke after invalidate (no stale grant served)', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const guard = new RuntimeGuard({ repository: repo });
    await guard.ensureGranted('email:send', tfg);
    repo.revoke(tfg, 'email:send');
    guard.invalidate(tfg);
    await expect(guard.ensureGranted('email:send', tfg)).rejects.toBeInstanceOf(CapabilityNotGrantedError);
  });
});

describe('InMemoryGrantsRepository', () => {
  it('seeded grants are returned as a ReadonlySet', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send', 'notification:send-in-app'] }]);
    const grants = await repo.findGrants(tfg);
    expect([...grants].sort()).toEqual(['email:send', 'notification:send-in-app']);
  });

  it('returns an empty set when no grants exist for the context', async () => {
    const repo = new InMemoryGrantsRepository();
    const grants = await repo.findGrants(tfg);
    expect(grants.size).toBe(0);
  });

  it('grant() + revoke() mutate the set', async () => {
    const repo = new InMemoryGrantsRepository();
    repo.grant(tfg, 'email:send');
    repo.grant(tfg, 'ai:complete');
    let grants = await repo.findGrants(tfg);
    expect([...grants].sort()).toEqual(['ai:complete', 'email:send']);
    repo.revoke(tfg, 'email:send');
    grants = await repo.findGrants(tfg);
    expect([...grants]).toEqual(['ai:complete']);
  });

  it('clear() drops every grant', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    repo.clear();
    const grants = await repo.findGrants(tfg);
    expect(grants.size).toBe(0);
  });
});

describe('RuntimeGuard.ensureGranted — audit callback (§9.50 Slice 8)', () => {
  function makeCallback() {
    const entries: CapabilityAuditEntry[] = [];
    return {
      entries,
      cb: (entry: CapabilityAuditEntry) => entries.push(entry)
    };
  }

  it('emits result=granted with no errorCode on a successful check', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const { entries, cb } = makeCallback();
    const guard = new RuntimeGuard({ repository: repo, auditCallback: cb });
    await guard.ensureGranted('email:send', tfg);
    expect(entries).toEqual([
      {
        deckId: 'tfg',
        tenantSlug: 'tfg',
        env: 'dev',
        packageName: 'standard/notify',
        packageVersion: '1.0.0',
        capability: 'email:send',
        result: 'granted',
        errorCode: undefined
      }
    ]);
  });

  it('emits result=not_granted + errorCode=CAPABILITY_NOT_GRANTED on a missing grant', async () => {
    const repo = new InMemoryGrantsRepository();
    const { entries, cb } = makeCallback();
    const guard = new RuntimeGuard({ repository: repo, auditCallback: cb });
    await expect(guard.ensureGranted('email:send', tfg)).rejects.toBeInstanceOf(CapabilityNotGrantedError);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      deckId: 'tfg',
      tenantSlug: 'tfg',
      env: 'dev',
      packageName: 'standard/notify',
      packageVersion: '1.0.0',
      capability: 'email:send',
      result: 'not_granted',
      errorCode: 'CAPABILITY_NOT_GRANTED'
    });
  });

  it('emits result=reserved + errorCode=RESERVED_CAPABILITY for reserved capabilities', async () => {
    const repo = new InMemoryGrantsRepository();
    const { entries, cb } = makeCallback();
    const guard = new RuntimeGuard({ repository: repo, auditCallback: cb });
    await expect(guard.ensureGranted('event:emit' as Capability, tfg)).rejects.toBeInstanceOf(ReservedCapabilityError);
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('reserved');
    expect(entries[0].errorCode).toBe('RESERVED_CAPABILITY');
  });

  it('reservation emit fires BEFORE the not_granted path (precedence — one emit per call)', async () => {
    // Empty grants — would normally trigger not_granted, but reserved
    // precedence means we get exactly one 'reserved' emit, not two.
    const repo = new InMemoryGrantsRepository();
    const { entries, cb } = makeCallback();
    const guard = new RuntimeGuard({ repository: repo, auditCallback: cb });
    await expect(guard.ensureGranted('event:listen' as Capability, tfg)).rejects.toBeInstanceOf(
      ReservedCapabilityError
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('reserved');
  });

  it('emits ONCE per ensureGranted call even when the grant set is cache-served', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const { entries, cb } = makeCallback();
    const guard = new RuntimeGuard({ repository: repo, auditCallback: cb });
    await guard.ensureGranted('email:send', tfg);
    await guard.ensureGranted('email:send', tfg);
    await guard.ensureGranted('email:send', tfg);
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.result === 'granted')).toBe(true);
  });

  it('no auditCallback configured → guard is silent (no error, no emit)', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const guard = new RuntimeGuard({ repository: repo });
    await expect(guard.ensureGranted('email:send', tfg)).resolves.toBeUndefined();
    await expect(guard.ensureGranted('not:granted' as Capability, tfg)).rejects.toBeDefined();
  });

  it('callback that throws propagates to the caller (host MUST use fire-and-forget like AsyncAuditWriter)', async () => {
    // Documents the contract: the guard does NOT catch callback errors.
    // The host's AsyncAuditWriter is internally setImmediate'd, so this
    // throw-path never surfaces in production — but a misconfigured
    // sync callback would, and the test guards the contract.
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const guard = new RuntimeGuard({
      repository: repo,
      auditCallback: () => {
        throw new Error('audit pipeline down');
      }
    });
    await expect(guard.ensureGranted('email:send', tfg)).rejects.toThrow('audit pipeline down');
  });
});

/**
 * §9.169 PR-10 — the parent-set capability CEILING is the first key, checked before any grant is read;
 * the deck-code identity (`core/deck-code`) has no grants but the ceiling, and never reaches the repository.
 */
describe('RuntimeGuard.ensureGranted — §9.169 capability ceiling + deck-code identity', () => {
  const deckCode: GuardContext = {
    deckId: 'tfg',
    tenantSlug: 'tfg',
    env: 'dev',
    packageName: DECK_CODE_PACKAGE_NAME,
    packageVersion: DECK_CODE_PACKAGE.version
  };

  it('refuses a capability outside the ceiling WITHOUT touching the repository, audited not_granted', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const find = jest.spyOn(repo, 'findGrants');
    const entries: CapabilityAuditEntry[] = [];
    const guard = new RuntimeGuard({ repository: repo, auditCallback: (e) => entries.push(e) });
    await expect(guard.ensureGranted('email:send', { ...tfg, capabilityCeiling: ['sms:send'] })).rejects.toBeInstanceOf(
      CapabilityNotGrantedError
    );
    expect(find).not.toHaveBeenCalled();
    expect(entries).toEqual([expect.objectContaining({ result: 'not_granted', errorCode: 'CAPABILITY_NOT_GRANTED' })]);
  });

  it('an EMPTY ceiling refuses everything — defined means enforced', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const find = jest.spyOn(repo, 'findGrants');
    const guard = new RuntimeGuard({ repository: repo });
    await expect(guard.ensureGranted('email:send', { ...tfg, capabilityCeiling: [] })).rejects.toBeInstanceOf(
      CapabilityNotGrantedError
    );
    expect(find).not.toHaveBeenCalled();
  });

  it('a package identity needs BOTH the ceiling and the master grant; no ceiling leaves the grants alone', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const guard = new RuntimeGuard({ repository: repo, cacheTtlMs: 0 });
    const ceiling = ['email:send', 'sms:send'];
    await expect(guard.ensureGranted('email:send', { ...tfg, capabilityCeiling: ceiling })).resolves.toBeUndefined();
    // Inside the ceiling, but no master grant → refused: the ceiling never widens a grant.
    await expect(guard.ensureGranted('sms:send', { ...tfg, capabilityCeiling: ceiling })).rejects.toBeInstanceOf(
      CapabilityNotGrantedError
    );
    await expect(guard.ensureGranted('email:send', tfg)).resolves.toBeUndefined();
  });

  it('the deck-code identity is granted from its ceiling with the repository NEVER called, audited granted', async () => {
    const repo = new InMemoryGrantsRepository();
    const find = jest.spyOn(repo, 'findGrants');
    const entries: CapabilityAuditEntry[] = [];
    const guard = new RuntimeGuard({ repository: repo, auditCallback: (e) => entries.push(e) });
    await expect(
      guard.ensureGranted('email:send', { ...deckCode, capabilityCeiling: ['email:send'] })
    ).resolves.toBeUndefined();
    expect(find).not.toHaveBeenCalled();
    expect(entries).toEqual([
      expect.objectContaining({ result: 'granted', packageName: 'core/deck-code', packageVersion: '0' })
    ]);
    // Outside its ceiling: refused, and still no repository read.
    await expect(
      guard.ensureGranted('sms:send', { ...deckCode, capabilityCeiling: ['email:send'] })
    ).rejects.toBeInstanceOf(CapabilityNotGrantedError);
    expect(find).not.toHaveBeenCalled();
  });

  it('the deck-code identity with NO ceiling is refused — a grant row for it would mean nothing', async () => {
    // Even a (hypothetical) master grant row for the identity is never consulted.
    const repo = new InMemoryGrantsRepository([{ ...deckCode, capabilities: ['email:send'] }]);
    const find = jest.spyOn(repo, 'findGrants');
    const entries: CapabilityAuditEntry[] = [];
    const guard = new RuntimeGuard({ repository: repo, auditCallback: (e) => entries.push(e) });
    await expect(guard.ensureGranted('email:send', deckCode)).rejects.toBeInstanceOf(CapabilityNotGrantedError);
    expect(find).not.toHaveBeenCalled();
    expect(entries).toEqual([expect.objectContaining({ result: 'not_granted', errorCode: 'CAPABILITY_NOT_GRANTED' })]);
  });

  it('a reserved capability is refused FIRST, even when the ceiling names it', async () => {
    const repo = new InMemoryGrantsRepository();
    const find = jest.spyOn(repo, 'findGrants');
    const entries: CapabilityAuditEntry[] = [];
    const guard = new RuntimeGuard({ repository: repo, auditCallback: (e) => entries.push(e) });
    await expect(
      guard.ensureGranted('event:emit' as Capability, { ...deckCode, capabilityCeiling: ['event:emit'] })
    ).rejects.toBeInstanceOf(ReservedCapabilityError);
    expect(find).not.toHaveBeenCalled();
    expect(entries).toEqual([expect.objectContaining({ result: 'reserved' })]);
  });

  it('isDeckCodeIdentity is an exact-name test: a package in another namespace named deck-code is not it', async () => {
    const repo = new InMemoryGrantsRepository();
    const find = jest.spyOn(repo, 'findGrants');
    const guard = new RuntimeGuard({ repository: repo });
    const lookalike: GuardContext = { ...deckCode, packageName: 'standard/deck-code' };
    await expect(
      guard.ensureGranted('email:send', { ...lookalike, capabilityCeiling: ['email:send'] })
    ).rejects.toBeInstanceOf(CapabilityNotGrantedError);
    // A package identity: the grants WERE read (and hold nothing).
    expect(find).toHaveBeenCalledTimes(1);
  });
});
