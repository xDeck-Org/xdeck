import { validatePackageRoute, canonicalRouteDeclaration, type PackageRouteManifestEntry } from './package-routes';

/**
 * §9.150 B — the `auth: 'consumer'` contract. An IDENTITY-gated, consumer-facing surface
 * (a ClienX consumer ordering from a deck they have already engaged): the kernel verifies a
 * consumer session and hands the sandboxed handler ONLY the deck-local `customerLinkId`
 * (never PII, §9.61). Like `public-binding` it is consumer-facing, so an explicit `rateLimit`
 * is mandatory and `requiredPermission` is forbidden (the caller is a consumer, not a tenant
 * member). Flipping a route's auth mode must change its declHash input (the B3.b carry-forward
 * gate forces re-approval — exposing a route to consumers is a NEW decision).
 */
describe('package-route auth: consumer contract (§9.150 B)', () => {
  const route = (over: Partial<PackageRouteManifestEntry> = {}): PackageRouteManifestEntry => ({
    id: 'place-online-order',
    method: 'POST',
    path: '/orders',
    handlerClass: 'OnlineOrderRoutes',
    handlerMethod: 'place',
    rateLimit: { limit: 30, windowSeconds: 60 },
    ...over
  });

  it('accepts a well-formed consumer route (auth + explicit rateLimit, no requiredPermission)', () => {
    expect(validatePackageRoute(route({ auth: 'consumer' }))).toEqual([]);
  });

  it('rejects a consumer route with NO rateLimit (an open consumer surface needs an explicit budget)', () => {
    const { rateLimit: _dropped, ...noBudget } = route({ auth: 'consumer' });
    expect(validatePackageRoute(noBudget).join(' ')).toMatch(/auth 'consumer' requires an explicit rateLimit/);
  });

  it('rejects requiredPermission on a consumer route (the caller is a consumer, not a tenant member)', () => {
    expect(validatePackageRoute(route({ auth: 'consumer', requiredPermission: 'orders:create' })).join(' ')).toMatch(
      /requiredPermission is meaningless with auth 'consumer'/
    );
  });

  it('rejects hmacSecretKey on a consumer route (only valid with public-hmac)', () => {
    expect(validatePackageRoute(route({ auth: 'consumer', hmacSecretKey: 'X' })).join(' ')).toMatch(
      /only valid with auth 'public-hmac'/
    );
  });

  it('flipping auth session→consumer CHANGES the declHash input (re-approval via B3.b gate)', () => {
    expect(canonicalRouteDeclaration(route())).not.toBe(canonicalRouteDeclaration(route({ auth: 'consumer' })));
  });
});
