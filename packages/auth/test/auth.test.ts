import { beforeAll, describe, expect, it } from 'vitest';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import {
  AuthError,
  bearerToken,
  createTokenVerifier,
  identityFromClaims,
  type TokenVerifier,
} from '../src/index.js';

const ISSUER = 'http://localhost:8080/realms/caselens';
const AUDIENCE = 'caselens-api';

let signingKey: CryptoKey;
let foreignKey: CryptoKey;
let keys: JWTVerifyGetKey;
let verify: TokenVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  foreignKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'key-1', alg: 'RS256', use: 'sig' }] });
  verify = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, keys });
});

async function token(
  claims: JWTPayload,
  options: {
    key?: CryptoKey;
    issuer?: string;
    audience?: string | string[];
    expiresIn?: string;
  } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? [AUDIENCE, 'caselens-analytics'])
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(options.key ?? signingKey);
}

const lena = {
  sub: 'profile_lena_vogt',
  name: 'Lena Vogt',
  email: 'lena.vogt@example.test',
  roles: ['admin', 'offline_access'],
  tenants: ['tenant_demo'],
};

async function rejection(promise: Promise<unknown>): Promise<AuthError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AuthError);
  return error as AuthError;
}

describe('token verification', () => {
  it('accepts a token this service was meant to receive', async () => {
    expect(await verify(await token(lena))).toEqual({
      subject: 'profile_lena_vogt',
      displayName: 'Lena Vogt',
      email: 'lena.vogt@example.test',
      tenantIds: ['tenant_demo'],
      role: 'admin',
      platformAdmin: false,
    });
  });

  it('rejects a token minted for a different service', async () => {
    // Audience is how a service knows a token was meant for it. Without the check, a token issued
    // to any client of the realm - including one a user controls - would be accepted here.
    const error = await rejection(verify(await token(lena, { audience: 'caselens-analytics' })));
    expect(error.reason).toBe('INVALID_TOKEN');
    expect(error.status).toBe(401);
  });

  it('rejects a token from another issuer, even when the key matches', async () => {
    const error = await rejection(
      verify(await token(lena, { issuer: 'http://evil.example/realms/caselens' })),
    );
    expect(error.reason).toBe('INVALID_TOKEN');
  });

  it('rejects a token signed by a key it did not publish', async () => {
    const error = await rejection(verify(await token(lena, { key: foreignKey })));
    expect(error.reason).toBe('INVALID_TOKEN');
  });

  it('rejects an expired token', async () => {
    // Beyond the thirty-second skew allowance, so this is expiry rather than clock disagreement.
    const error = await rejection(verify(await token(lena, { expiresIn: '-2m' })));
    expect(error.reason).toBe('INVALID_TOKEN');
  });

  it('refuses a token that declares a symmetric algorithm', async () => {
    // The algorithm-confusion attack: the verifier must never let the token choose the algorithm.
    // Here the attacker signs with HS256 using a secret of their choosing and hopes the verifier
    // honours the header.
    const forged = await new SignJWT(lena)
      .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('attacker-chosen-secret-attacker-chosen'));
    const error = await rejection(verify(forged));
    expect(error.reason).toBe('INVALID_TOKEN');
  });

  it('refuses an unsigned token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        ...lena,
        iss: ISSUER,
        aud: AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString('base64url');
    const error = await rejection(verify(`${header}.${body}.`));
    expect(error.reason).toBe('INVALID_TOKEN');
  });

  it('answers 503, not 401, when it cannot reach the signing keys', async () => {
    // During an identity-provider outage the caller's credentials are fine; saying otherwise sends
    // them to reset a password that was never the problem.
    const unreachable = createTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: 'http://127.0.0.1:9/realms/caselens/protocol/openid-connect/certs',
    });
    const error = await rejection(unreachable(await token(lena)));
    expect(error.reason).toBe('KEYS_UNAVAILABLE');
    expect(error.status).toBe(503);
  });
});

describe('claim mapping', () => {
  it('refuses an authenticated account that holds no application role', () => {
    // Defaulting to the least capable role would still grant a tenant nobody chose to give them.
    expect(() => identityFromClaims({ ...lena, roles: ['offline_access'] })).toThrow(
      expect.objectContaining({ reason: 'NO_ROLE' }),
    );
    expect(new AuthError('NO_ROLE', '').status).toBe(403);
  });

  it('refuses a tenant user who belongs to no tenant', () => {
    expect(() => identityFromClaims({ ...lena, tenants: [] })).toThrow(
      expect.objectContaining({ reason: 'NO_TENANT' }),
    );
  });

  it('lets a platform administrator hold no tenant membership', () => {
    const identity = identityFromClaims({ sub: 'mara', roles: ['platform_admin'] });
    expect(identity).toMatchObject({ platformAdmin: true, role: 'admin', tenantIds: [] });
  });

  it('acts with the most capable of several roles', () => {
    expect(identityFromClaims({ ...lena, roles: ['intake', 'approver', 'reviewer'] }).role).toBe(
      'approver',
    );
  });

  it('reads group paths and bare names as the same tenant', () => {
    // Whether the identity provider emits `/tenant_demo` or `tenant_demo` is a mapper checkbox, and
    // tenant access must not depend on it.
    expect(
      identityFromClaims({ ...lena, tenants: ['/tenant_demo', 'tenant_demo'] }).tenantIds,
    ).toEqual(['tenant_demo']);
  });

  it('falls back to the realm roles claim when no flat roles claim is mapped', () => {
    const identity = identityFromClaims({
      sub: 'x',
      realm_access: { roles: ['reviewer'] },
      tenants: ['tenant_legal'],
    });
    expect(identity.role).toBe('reviewer');
  });
});

describe('bearer extraction', () => {
  it('reads exactly an RFC 6750 bearer credential and nothing else', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken(['Bearer abc.def.ghi'])).toBe('abc.def.ghi');
    expect(bearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
