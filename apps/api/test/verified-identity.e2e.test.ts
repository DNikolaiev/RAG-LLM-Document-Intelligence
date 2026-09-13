import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { ProblemDetailSchema } from '@caselens/contracts';
import { AppModule } from '../src/app.module.js';
import { ProblemDetailsFilter } from '../src/problem.filter.js';
import { expectMatchesSchema } from './support/contract.js';

const ISSUER = 'http://localhost:8080/realms/caselens';

/**
 * The API under verified identity, against a real JWKS endpoint.
 *
 * Keys are served over HTTP rather than injected, so this takes the path production takes: fetch
 * the key set from a URL, cache it, verify every signature in-process. The identity provider itself
 * is not involved - which is the point of verifying locally.
 */
describe('verified identity (AUTH_MODE=oidc)', () => {
  let app: INestApplication;
  let jwks: Server;
  let signingKey: CryptoKey;
  const savedEnvironment = { ...process.env };

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    signingKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    jwks = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
    const { port } = jwks.address() as AddressInfo;
    Object.assign(process.env, {
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: ISSUER,
      OIDC_AUDIENCE: 'caselens-api',
      OIDC_JWKS_URL: `http://127.0.0.1:${port}/realms/caselens/protocol/openid-connect/certs`,
    });

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => jwks.close(() => resolve()));
    process.env = savedEnvironment;
  });

  const sign = (
    claims: JWTPayload,
    audience: string | string[] = ['caselens-api', 'caselens-analytics'],
  ): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signingKey);

  const jonas = {
    sub: 'profile_jonas_feld',
    name: 'Jonas Feld',
    roles: ['admin'],
    tenants: ['tenant_legal'],
  };
  const mara = {
    sub: 'profile_mara_stein',
    name: 'Mara Stein',
    roles: ['platform_admin'],
    tenants: ['tenant_demo', 'tenant_legal', 'tenant_insurance', 'tenant_manufacturing'],
  };

  it('refuses a request without a token, and says how to authenticate', async () => {
    const response = await request(app.getHttpServer()).get('/v1/cases').expect(401);
    // RFC 6750: a 401 tells the client which scheme to use. With no credential presented there is
    // no error code to report, so none is sent.
    expect(response.headers['www-authenticate']).toBe('Bearer realm="caselens"');
    expect(response.body).toMatchObject({ code: 'MISSING_TOKEN', status: 401 });
    expectMatchesSchema(ProblemDetailSchema, response.body, 'GET /v1/cases 401 body');
  });

  it('ignores the test identity headers entirely', async () => {
    // The regression this guards is the worst one available: under verified identity, naming
    // yourself the platform administrator in a header must get you nothing at all. Every header
    // the local switcher reads is present here, and none of them is a credential.
    const response = await request(app.getHttpServer())
      .get('/v1/cases')
      .set('x-test-profile-id', 'profile_mara_stein')
      .set('x-user-id', 'profile_mara_stein')
      .set('x-role', 'admin')
      .set('x-tenant-id', 'tenant_demo')
      .expect(401);
    expect(response.body.code).toBe('MISSING_TOKEN');
  });

  it('scopes a verified tenant user to the tenants their token grants', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/cases')
      .set('authorization', `Bearer ${await sign(jonas)}`)
      .expect(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({ tenantId: 'tenant_legal' });
  });

  it('gives a verified platform administrator the aggregate queue', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/cases')
      .set('authorization', `Bearer ${await sign(mara)}`)
      .expect(200);
    expect(new Set(response.body.items.map((item: { tenantId: string }) => item.tenantId))).toEqual(
      new Set(['tenant_demo', 'tenant_legal', 'tenant_insurance', 'tenant_manufacturing']),
    );
  });

  it('lets the workspace header narrow what a token grants, never widen it', async () => {
    // Jonas belongs to tenant_legal. Asking for tenant_demo must be ignored, not honoured: a header
    // that could select any tenant would be a way into somebody else's workspace.
    const response = await request(app.getHttpServer())
      .get('/v1/cases')
      .set('authorization', `Bearer ${await sign(jonas)}`)
      .set('x-caselens-tenant', 'tenant_demo')
      .expect(200);
    expect(
      response.body.items.every((item: { tenantId: string }) => item.tenantId === 'tenant_legal'),
    ).toBe(true);
  });

  it('rejects a token minted for a different service', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/cases')
      .set('authorization', `Bearer ${await sign(jonas, 'caselens-analytics')}`)
      .expect(401);
    expect(response.headers['www-authenticate']).toContain('error="invalid_token"');
    expect(response.body.code).toBe('INVALID_TOKEN');
  });

  it('refuses an authenticated account that holds no application role', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/cases')
      .set('authorization', `Bearer ${await sign({ ...jonas, roles: ['offline_access'] })}`)
      .expect(403);
    expect(response.body.code).toBe('NO_ROLE');
  });

  it('keeps health probes answerable without a token', async () => {
    // A container orchestrator asking whether the process is alive is not a user. Requiring a
    // token here would tie the API's liveness to the identity provider's.
    await request(app.getHttpServer()).get('/v1/health/live').expect(200);
  });
});
