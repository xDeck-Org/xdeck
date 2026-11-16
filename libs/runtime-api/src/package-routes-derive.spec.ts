import {
  routeExposeCapabilities,
  isRouteExposeCapability,
  routeExposeCapability,
  type PackageRouteManifestEntry
} from './package-routes';

/**
 * §9.94 B3.b — the route:expose derivation primitive: a package's routes[] imply one
 * route:expose:<ns>/<name>:<id> capability each, folded into the OPTIONAL set for tenant
 * approval (D-a-1). Pure, manifest-order-preserving.
 */
describe('routeExposeCapabilities (§9.94 B3.b)', () => {
  const route = (over: Partial<PackageRouteManifestEntry> = {}): PackageRouteManifestEntry => ({
    id: 'place-order',
    method: 'POST',
    path: '/orders/:orderId',
    handlerClass: 'OrderRoutes',
    handlerMethod: 'place',
    ...over
  });

  it('derives one route:expose cap per declared route, preserving order', () => {
    const caps = routeExposeCapabilities('restroin', 'foh', [
      route(),
      route({ id: 'get-order', method: 'GET', handlerMethod: 'get' })
    ]);
    expect(caps).toEqual(['route:expose:restroin/foh:place-order', 'route:expose:restroin/foh:get-order']);
  });

  it('yields [] for a package with no routes', () => {
    expect(routeExposeCapabilities('restroin', 'foh', undefined)).toEqual([]);
    expect(routeExposeCapabilities('restroin', 'foh', [])).toEqual([]);
  });

  it('matches the canonical single-route builder', () => {
    expect(routeExposeCapabilities('n', 'p', [route({ id: 'x' })])[0]).toBe(routeExposeCapability('n', 'p', 'x'));
  });

  it('isRouteExposeCapability discriminates the family', () => {
    expect(isRouteExposeCapability('route:expose:restroin/foh:place-order')).toBe(true);
    expect(isRouteExposeCapability('email:send')).toBe(false);
    expect(isRouteExposeCapability('entity:read:Order')).toBe(false);
  });
});
