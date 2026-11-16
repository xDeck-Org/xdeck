/**
 * §9.94 B4 (ADR-0019 D4) — edge gate-cache spec. Pins the security-critical contract:
 *   • online → write-through + fresh answer (incl. a legitimately-empty grant set);
 *   • offline + fresh snapshot → resolve from cache (the ONE behaviour added);
 *   • offline + no/stale snapshot → re-throw = FAIL CLOSED (never fail open);
 *   • a flaky store NEVER masks the authoritative answer, and NEVER fails open;
 *   • composed under the real RuntimeGuard, the gate denies offline-no-cache and
 *     allows offline-fresh-cache exactly as the decorator promises.
 */

import { EdgeGateCacheRepository, gateSnapshotKey, type GateSnapshot, type GateSnapshotStore } from './edge-gate-cache';
import { RuntimeGuard } from './guard';
import { CapabilityNotGrantedError } from './errors';
import type { Capability } from './capability';
import type { GrantsRepository, GuardContext } from './ports';

const CTX: GuardContext = {
  deckId: 'tenant-1',
  tenantSlug: 'tfg',
  env: 'prod',
  packageName: 'restroin/foh',
  packageVersion: '1.0.0'
};

const CAP = 'records:read' as Capability;

/** A trivial in-memory snapshot store; `failRead`/`failWrite` model a flaky backing store. */
class MemStore implements GateSnapshotStore {
  readonly map = new Map<string, GateSnapshot>();
  failRead = false;
  failWrite = false;
  async read(key: string): Promise<GateSnapshot | null> {
    if (this.failRead) throw new Error('store read boom');
    return this.map.get(key) ?? null;
  }
  async write(key: string, snapshot: GateSnapshot): Promise<void> {
    if (this.failWrite) throw new Error('store write boom');
    this.map.set(key, snapshot);
  }
}

/** Authoritative repo that returns a fixed set online, or throws to model "master unreachable". */
class FakeAuthoritative implements GrantsRepository {
  online = true;
  grants = new Set<Capability>([CAP]);
  calls = 0;
  async findGrants(): Promise<ReadonlySet<Capability>> {
    this.calls++;
    if (!this.online) throw new Error('ECONNREFUSED master');
    return this.grants;
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('EdgeGateCacheRepository (§9.94 B4)', () => {
  let auth: FakeAuthoritative;
  let store: MemStore;
  let now: number;
  const clock = () => now;

  const build = (over: Partial<ConstructorParameters<typeof EdgeGateCacheRepository>[0]> = {}) =>
    new EdgeGateCacheRepository({ authoritative: auth, store, maxStalenessMs: DAY, clock, ...over });

  beforeEach(() => {
    auth = new FakeAuthoritative();
    store = new MemStore();
    now = 1_000_000_000_000;
  });

  describe('online (authoritative reachable)', () => {
    it('returns the authoritative grant set AND writes it through to the snapshot store', async () => {
      const repo = build();
      const grants = await repo.findGrants(CTX);
      expect([...grants]).toEqual([CAP]);
      const snap = store.map.get(gateSnapshotKey(CTX));
      expect(snap).toEqual({ grants: [CAP], capturedAt: now });
    });

    it('write-throughs a legitimately-EMPTY set (empty ≠ unreachable — it is a valid answer)', async () => {
      auth.grants = new Set();
      const repo = build();
      const grants = await repo.findGrants(CTX);
      expect(grants.size).toBe(0);
      expect(store.map.get(gateSnapshotKey(CTX))).toEqual({ grants: [], capturedAt: now });
    });

    it('still returns the authoritative answer when the snapshot WRITE fails (persistence never masks)', async () => {
      store.failWrite = true;
      const repo = build();
      const grants = await repo.findGrants(CTX);
      expect([...grants]).toEqual([CAP]);
      expect(store.map.size).toBe(0); // nothing persisted, but the call succeeded
    });
  });

  describe('offline (authoritative throws)', () => {
    it('resolves from a FRESH snapshot and fires onFallback (the one behaviour B4 adds)', async () => {
      const onFallback = jest.fn();
      const repo = build({ onFallback });
      await repo.findGrants(CTX); // online: seeds the snapshot
      auth.online = false; // edge goes offline
      now += HOUR; // 1h later, well within the 24h window

      const grants = await repo.findGrants(CTX);
      expect([...grants]).toEqual([CAP]);
      expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ ageMs: HOUR }));
    });

    it('FAILS CLOSED (re-throws) when there is NO snapshot', async () => {
      auth.online = false;
      const repo = build();
      await expect(repo.findGrants(CTX)).rejects.toThrow('ECONNREFUSED master');
    });

    it('FAILS CLOSED when the snapshot is STALE (beyond maxStalenessMs)', async () => {
      const repo = build();
      await repo.findGrants(CTX); // seed
      auth.online = false;
      now += DAY + 1; // one ms past the grace window

      await expect(repo.findGrants(CTX)).rejects.toThrow('ECONNREFUSED master');
    });

    it('serves a snapshot exactly AT the window boundary (age === maxStalenessMs is still fresh)', async () => {
      const repo = build();
      await repo.findGrants(CTX);
      auth.online = false;
      now += DAY; // exactly the bound

      const grants = await repo.findGrants(CTX);
      expect([...grants]).toEqual([CAP]);
    });

    it('FAILS CLOSED when the snapshot READ itself throws (a flaky store never fails open)', async () => {
      const repo = build();
      await repo.findGrants(CTX); // seed
      auth.online = false;
      store.failRead = true;

      await expect(repo.findGrants(CTX)).rejects.toThrow('ECONNREFUSED master');
    });

    it('maxStalenessMs <= 0 disables the offline fallback entirely (always fail closed)', async () => {
      const repo = build({ maxStalenessMs: 0 });
      await repo.findGrants(CTX); // would seed if persisted
      auth.online = false;
      await expect(repo.findGrants(CTX)).rejects.toThrow('ECONNREFUSED master');
    });
  });

  describe('composed under the real RuntimeGuard (end-to-end gate)', () => {
    const guardOn = (repo: GrantsRepository) => new RuntimeGuard({ repository: repo, cacheTtlMs: 0 });

    it('grants offline from a fresh snapshot; denies once the window lapses', async () => {
      const repo = build();
      const guard = guardOn(repo);
      await guard.ensureGranted(CAP, CTX); // online — seeds snapshot, passes

      auth.online = false;
      now += HOUR;
      await expect(guard.ensureGranted(CAP, CTX)).resolves.toBeUndefined(); // offline, fresh → granted

      now += DAY; // now stale
      await expect(guard.ensureGranted(CAP, CTX)).rejects.toThrow('ECONNREFUSED master'); // fail closed
    });

    it('a capability NOT in the cached set is still denied offline (the cache is a grant set, not a bypass)', async () => {
      const repo = build();
      const guard = guardOn(repo);
      await guard.ensureGranted(CAP, CTX); // seed snapshot holding only CAP
      auth.online = false;
      now += HOUR;
      await expect(guard.ensureGranted('records:write' as Capability, CTX)).rejects.toBeInstanceOf(
        CapabilityNotGrantedError
      );
    });
  });
});
