import { validatePackageRoute, canonicalRouteDeclaration, type PackageRouteManifestEntry } from './package-routes';

/**
 * §9.94 B3.c — the `auth: 'public-hmac'` contract. A public route is unauthenticated
 * except for its HMAC signature, so its signing-secret vault key is mandatory + must be a
 * valid §9.80 vault key; and flipping a route's auth mode must change its declHash (so the
 * B3.b carry-forward gate forces re-approval — exposing a route publicly is a NEW decision).
 */
describe('package-route auth: public-hmac contract (§9.94 B3.c)', () => {
  const route = (over: Partial<PackageRouteManifestEntry> = {}): PackageRouteManifestEntry => ({
    id: 'rz-webhook',
    method: 'POST',
    path: '/webhook/razorpay',
    handlerClass: 'WebhookRoutes',
    handlerMethod: 'razorpay',
    ...over
  });

  it('accepts a well-formed public-hmac route (auth + UPPER_SNAKE hmacSecretKey)', () => {
    expect(validatePackageRoute(route({ auth: 'public-hmac', hmacSecretKey: 'RAZORPAY_WEBHOOK_SECRET' }))).toEqual([]);
  });

  it('accepts a default session route (no auth, no hmacSecretKey)', () => {
    expect(validatePackageRoute(route())).toEqual([]);
  });

  it('rejects a public-hmac route with NO hmacSecretKey (nothing could authenticate callers)', () => {
    const errs = validatePackageRoute(route({ auth: 'public-hmac' }));
    expect(errs.join(' ')).toMatch(/requires hmacSecretKey/);
  });

  it('rejects a public-hmac route whose hmacSecretKey is not an UPPER_SNAKE vault key', () => {
    expect(validatePackageRoute(route({ auth: 'public-hmac', hmacSecretKey: 'lower-case' })).join(' ')).toMatch(
      /hmacSecretKey/
    );
  });

  it('rejects hmacSecretKey on a non-public-hmac (session) route', () => {
    expect(validatePackageRoute(route({ hmacSecretKey: 'X' })).join(' ')).toMatch(/only valid with auth 'public-hmac'/);
  });

  it('rejects an unknown auth mode', () => {
    // Robust against the accepted-mode list growing (session/public-hmac/public-binding/consumer…).
    expect(validatePackageRoute(route({ auth: 'bearer' as never })).join(' ')).toMatch(/auth 'bearer' invalid/);
  });

  it('flipping auth session→public-hmac CHANGES the declHash input (re-approval via B3.b gate)', () => {
    expect(canonicalRouteDeclaration(route())).not.toBe(
      canonicalRouteDeclaration(route({ auth: 'public-hmac', hmacSecretKey: 'S' }))
    );
  });
});
