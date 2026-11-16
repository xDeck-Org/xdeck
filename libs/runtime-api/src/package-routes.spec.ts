import {
  routeExposeCapability,
  canonicalRouteDeclaration,
  normalizeRoutePath,
  matchRoutePath,
  validatePackageRoute,
  validatePackageRoutes,
  ROUTE_TIMEOUT_MAX_MS,
  type PackageRouteManifestEntry
} from './package-routes';
import { isGrantableCapability, parseCapability } from './capability';

/**
 * §9.94 B3 (ADR-0019 D8) — the pure package-route contract. Load-bearing: the path
 * matcher is the kernel's OWN matcher (the catch-all controller owns matching, not the
 * Nest router), so it must fail-closed against traversal; the capability builder must
 * round-trip through the catalogue's parameterized grammar; canonicalRouteDeclaration
 * must change iff a SECURITY-meaningful field changes (the drift-proofing of an
 * already-approved grant).
 */
describe('package-routes (§9.94 B3 contract)', () => {
  const route = (over: Partial<PackageRouteManifestEntry> = {}): PackageRouteManifestEntry => ({
    id: 'place-order',
    method: 'POST',
    path: '/orders/:orderId',
    handlerClass: 'OrderRoutes',
    handlerMethod: 'place',
    ...over
  });

  describe('routeExposeCapability + catalogue round-trip', () => {
    it('builds route:expose:<ns>/<name>:<routeId> and is grantable via the catalogue', () => {
      const cap = routeExposeCapability('restroin', 'foh', 'place-order');
      expect(cap).toBe('route:expose:restroin/foh:place-order');
      expect(isGrantableCapability(cap)).toBe(true);
      expect(parseCapability(cap)).toEqual({ family: 'route:expose', resourceId: 'restroin/foh:place-order' });
    });
  });

  describe('canonicalRouteDeclaration (declHash input)', () => {
    it('is stable across irrelevant field changes (rateLimit/timeout/description/deprecated)', () => {
      const base = canonicalRouteDeclaration(route());
      expect(canonicalRouteDeclaration(route({ rateLimit: { limit: 9, windowSeconds: 60 } }))).toBe(base);
      expect(canonicalRouteDeclaration(route({ timeoutMs: 1234 }))).toBe(base);
      expect(canonicalRouteDeclaration(route({ description: 'whatever', deprecated: true }))).toBe(base);
    });

    it('CHANGES when a security-meaningful field changes (handler / method / path / requiredPermission)', () => {
      const base = canonicalRouteDeclaration(route());
      expect(canonicalRouteDeclaration(route({ handlerMethod: 'purge' }))).not.toBe(base);
      expect(canonicalRouteDeclaration(route({ handlerClass: 'AdminRoutes' }))).not.toBe(base);
      expect(canonicalRouteDeclaration(route({ method: 'DELETE' }))).not.toBe(base);
      expect(canonicalRouteDeclaration(route({ path: '/orders/:orderId/' }))).toBe(base); // normalized → same
      expect(canonicalRouteDeclaration(route({ path: '/admin/:orderId' }))).not.toBe(base);
      expect(canonicalRouteDeclaration(route({ requiredPermission: 'order.purge' }))).not.toBe(base);
    });
  });

  describe('normalizeRoutePath', () => {
    it('collapses duplicate slashes + strips trailing slash (keeps root)', () => {
      expect(normalizeRoutePath('/orders//abc/')).toBe('/orders/abc');
      expect(normalizeRoutePath('/')).toBe('/');
    });
  });

  describe('matchRoutePath', () => {
    it('matches a literal + captures :params', () => {
      expect(matchRoutePath('/orders/:orderId', '/orders/abc123')).toEqual({ params: { orderId: 'abc123' } });
      expect(matchRoutePath('/orders', '/orders')).toEqual({ params: {} });
      expect(matchRoutePath('/a/:x/b/:y', '/a/1/b/2')).toEqual({ params: { x: '1', y: '2' } });
    });

    it('requires an exact segment-count match (no implicit prefix/wildcard)', () => {
      expect(matchRoutePath('/orders', '/orders/abc')).toBeNull();
      expect(matchRoutePath('/orders/:id', '/orders')).toBeNull();
      expect(matchRoutePath('/orders/:id', '/orders/a/b')).toBeNull();
    });

    it('fails CLOSED on path traversal / empty segments in EITHER side', () => {
      expect(matchRoutePath('/orders/:id', '/orders/..')).toBeNull();
      expect(matchRoutePath('/orders/:id', '/orders/.')).toBeNull();
      expect(matchRoutePath('/orders/:id', '/orders//')).toBeNull();
      expect(matchRoutePath('/orders/:id', '/../etc/passwd')).toBeNull();
    });

    it('rejects a literal mismatch', () => {
      expect(matchRoutePath('/orders/:id', '/invoices/1')).toBeNull();
    });

    it('rejects a malformed template (bare ":" or duplicate param name)', () => {
      expect(matchRoutePath('/orders/:', '/orders/x')).toBeNull();
      expect(matchRoutePath('/a/:x/:x', '/a/1/2')).toBeNull();
    });
  });

  describe('validatePackageRoute', () => {
    it('accepts a well-formed route', () => {
      expect(validatePackageRoute(route())).toEqual([]);
    });

    it('rejects an id with a colon/slash/uppercase (would corrupt the capability resource)', () => {
      expect(validatePackageRoute(route({ id: 'place:order' })).length).toBeGreaterThan(0);
      expect(validatePackageRoute(route({ id: 'restroin/foh' })).length).toBeGreaterThan(0);
      expect(validatePackageRoute(route({ id: 'PlaceOrder' })).length).toBeGreaterThan(0);
    });

    it('rejects a traversal/empty path, a bad handler name, an unsupported auth, an over-max timeout', () => {
      expect(validatePackageRoute(route({ path: '/orders/../x' })).length).toBeGreaterThan(0);
      expect(validatePackageRoute(route({ path: 'orders' })).length).toBeGreaterThan(0); // not /-rooted
      expect(validatePackageRoute(route({ handlerClass: 'order' })).length).toBeGreaterThan(0);
      expect(validatePackageRoute(route({ handlerMethod: 'Place' })).length).toBeGreaterThan(0);
      expect(validatePackageRoute(route({ auth: 'public-hmac' as never })).length).toBeGreaterThan(0);
      expect(validatePackageRoute(route({ timeoutMs: ROUTE_TIMEOUT_MAX_MS + 1 })).length).toBeGreaterThan(0);
    });
  });

  describe('validatePackageRoutes', () => {
    it('flags duplicate ids and duplicate (method, normalizedPath) signatures', () => {
      const dupId = validatePackageRoutes([route(), route({ path: '/other' })]);
      expect(dupId.some((e) => /duplicate route id/.test(e))).toBe(true);

      const dupSig = validatePackageRoutes([route({ id: 'a' }), route({ id: 'b', path: '/orders/:orderId/' })]);
      expect(dupSig.some((e) => /duplicate route signature/.test(e))).toBe(true);
    });

    it('accepts a clean set', () => {
      expect(
        validatePackageRoutes([route({ id: 'ra', path: '/a' }), route({ id: 'rb', method: 'GET', path: '/b/:id' })])
      ).toEqual([]);
    });
  });
});
