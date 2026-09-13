import { beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { AuthError, createTokenVerifier, type TokenVerifier } from '@caselens/auth';
import { createCallerResolver } from '../src/caller.js';
import { startReadApi } from '../src/read-api.js';
import type { AnalyticsStore } from '../src/store.js';

const ISSUER = 'http://localhost:8080/realms/caselens';

let signingKey: CryptoKey;
let verify: TokenVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k', alg: 'RS256', use: 'sig' };
  verify = createTokenVerifier({
    issuer: ISSUER,
    audience: 'caselens-analytics',
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
});

function sign(claims: JWTPayload, audience: string | string[]): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setExpirationTime('5m')
    .sign(signingKey);
}

const lena = { sub: 'profile_lena_vogt', roles: ['admin'], tenants: ['tenant_demo'] };

describe('analytics caller identity under OIDC', () => {
  it('never reads the test-profile header', async () => {
    const resolve = createCallerResolver({ verify });
    await expect(
      Promise.resolve(resolve({ 'x-test-profile-id': 'profile_mara_stein' })),
    ).rejects.toMatchObject({ reason: 'MISSING_TOKEN' });
  });

  it('scopes to what a verified token grants', async () => {
    const resolve = createCallerResolver({ verify });
    const token = await sign(lena, ['caselens-api', 'caselens-analytics']);
    expect(await resolve({ authorization: `Bearer ${token}` })).toEqual({
      tenantIds: ['tenant_demo'],
      platformAdmin: false,
    });
  });

  it('refuses a token minted only for the API', async () => {
    // Each resource server accepts tokens meant for it. The API's audience alone is not enough to
    // read the projection.
    const resolve = createCallerResolver({ verify });
    const token = await sign(lena, 'caselens-api');
    const error = await Promise.resolve(resolve({ authorization: `Bearer ${token}` })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).reason).toBe('INVALID_TOKEN');
  });

  it('answers an unauthenticated request with 401 and the scheme to use', async () => {
    // Authentication fails before any query runs, so the store is never touched.
    const server = startReadApi({
      store: {} as AnalyticsStore,
      port: 0,
      resolve: createCallerResolver({ verify }),
    });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/analytics/throughput`, {
        headers: { 'x-test-profile-id': 'profile_mara_stein' },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="caselens"');
      expect(await response.json()).toMatchObject({ code: 'MISSING_TOKEN' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
