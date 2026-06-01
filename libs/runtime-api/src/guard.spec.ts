/**
 * §9.50 Phase A Slice 3 — RuntimeGuard tests. Locks the enforcement
 * contract the sandbox host (follow-up sub-slice) + Slice 5a
 * notification/email wiring depend on.
 */

import type { Capability } from './capability';
import { CapabilityNotGrantedError, ReservedCapabilityError } from './errors';
import { RuntimeGuard } from './guard';
import { InMemoryGrantsRepository, type CapabilityAuditEntry, type GuardContext } from './ports';

const tfg: GuardContext = {
  tenantId: 'tfg',
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

  it('carries capability + packageName + tenantId on the error', async () => {
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
      expect(e.tenantId).toBe('tfg');
    }
  });

  it('scopes by tenant — a grant on TFG does not satisfy ACME', async () => {
    const repo = new InMemoryGrantsRepository([{ ...tfg, capabilities: ['email:send'] }]);
    const guard = new RuntimeGuard({ repository: repo });
    const acme = { ...tfg, tenantId: 'acme' };
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
      { ...tfg, tenantId: 'acme', capabilities: ['email:send'] }
    ]);
    const spy = jest.spyOn(repo, 'findGrants');
    const guard = new RuntimeGuard({ repository: repo });
    const acme = { ...tfg, tenantId: 'acme' };

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
        tenantId: 'tfg',
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
      tenantId: 'tfg',
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
