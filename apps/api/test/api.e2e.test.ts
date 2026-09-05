import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaseSummarySchema, DocumentSchema, ProblemDetailSchema } from '@caselens/contracts';
import { AppModule } from '../src/app.module.js';
import { ProblemDetailsFilter } from '../src/problem.filter.js';
import { expectCursorPageMatchesSchema, expectMatchesSchema } from './support/contract.js';

describe('CaseLens API', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it('reports readiness and a correlation id', async () => {
    const response = await request(app.getHttpServer()).get('/v1/health/ready').expect(200);
    expect(response.headers['x-correlation-id']).toMatch(/^cor_/);
    expect(response.body).toMatchObject({ status: 'ready', checks: { persistence: 'ok' } });
  });

  it('returns tenant-safe problem details for an inaccessible case', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/cases/case_01J67X4Q7B5E6QG4S9CY0F7R2K')
      .set('x-tenant-id', 'tenant_other')
      .expect(404);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body).toMatchObject({ code: 'CASE_NOT_FOUND', status: 404 });
    expect(response.body).not.toHaveProperty('tenantId');
    expectMatchesSchema(ProblemDetailSchema, response.body, 'GET /v1/cases/:id 404 body');
  });

  it('resolves catalog profiles server-side and gives only the platform admin an aggregate queue', async () => {
    const legal = await request(app.getHttpServer())
      .get('/v1/cases')
      .set('x-test-profile-id', 'profile_jonas_feld')
      .set('x-tenant-id', 'tenant_demo')
      .set('x-role', 'admin')
      .expect(200);
    expect(legal.body.items).toHaveLength(1);
    expect(legal.body.items[0]).toMatchObject({ tenantId: 'tenant_legal' });
    expectCursorPageMatchesSchema(CaseSummarySchema, legal.body, 'GET /v1/cases (tenant user)');

    const platform = await request(app.getHttpServer())
      .get('/v1/cases')
      .set('x-test-profile-id', 'profile_mara_stein')
      .expect(200);
    expect(new Set(platform.body.items.map((item: { tenantId: string }) => item.tenantId))).toEqual(
      new Set(['tenant_demo', 'tenant_legal', 'tenant_insurance', 'tenant_manufacturing']),
    );
    expectCursorPageMatchesSchema(
      CaseSummarySchema,
      platform.body,
      'GET /v1/cases (platform admin)',
    );
  });

  it('validates case creation and preserves idempotency', async () => {
    const invalid = await request(app.getHttpServer())
      .post('/v1/cases')
      .send({ subjectName: 'x' })
      .expect(400);
    expect(invalid.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expectMatchesSchema(ProblemDetailSchema, invalid.body, 'POST /v1/cases 400 body');

    const body = { subjectName: 'Example Supplier GmbH', domainPackId: 'pharmacy-supplier' };
    const first = await request(app.getHttpServer())
      .post('/v1/cases')
      .set('idempotency-key', 'create-e2e')
      .send(body)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/v1/cases')
      .set('idempotency-key', 'create-e2e')
      .send(body)
      .expect(201);
    expect(second.body.id).toBe(first.body.id);
    expectMatchesSchema(CaseSummarySchema, first.body, 'POST /v1/cases 201 body');
  });

  it('rejects a spoofed PDF signature before processing', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/cases/case_01J67X4Q7B5E6QG4S9CY0F7R2K/documents')
      .attach('file', Buffer.from('not a PDF'), {
        filename: 'spoofed.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
    expect(response.body).toMatchObject({ code: 'MIME_SIGNATURE_MISMATCH' });
    expectMatchesSchema(ProblemDetailSchema, response.body, 'POST .../documents 400 body');
  });

  it('streams an uploaded original with tenant checks and byte-range support', async () => {
    const createdCase = await request(app.getHttpServer())
      .post('/v1/cases')
      .set('idempotency-key', 'source-content-case-e2e')
      .send({
        subjectName: 'Source Content Test GmbH',
        domainPackId: 'pharmacy-supplier',
      })
      .expect(201);
    const upload = await request(app.getHttpServer())
      .post(`/v1/cases/${createdCase.body.id}/documents`)
      .set('idempotency-key', 'source-content-e2e')
      .attach('file', Buffer.from('CaseLens source content'), {
        filename: 'source-evidence.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    expectMatchesSchema(DocumentSchema, upload.body, 'POST .../documents 201 body');

    const path = `/v1/cases/${createdCase.body.id}/documents/${upload.body.id}/content`;
    const full = await request(app.getHttpServer()).get(path).expect(200);
    expect(full.headers['content-type']).toMatch(/^text\/plain/);
    expect(full.headers['content-disposition']).toContain('inline; filename="source-evidence.txt"');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.text).toBe('CaseLens source content');

    const partial = await request(app.getHttpServer())
      .get(path)
      .set('range', 'bytes=0-7')
      .expect(206);
    expect(partial.headers['content-range']).toBe('bytes 0-7/23');
    expect(partial.text).toBe('CaseLens');

    const contentNotFound = await request(app.getHttpServer())
      .get(path)
      .set('x-tenant-id', 'tenant_other')
      .expect(404);
    // The tenant-mismatch rejection itself is JSON problem-details, unlike the binary success
    // paths above (which are out of scope for contract assertions).
    expectMatchesSchema(ProblemDetailSchema, contentNotFound.body, 'GET .../content 404 body');
  });

  it('lets reviewers request information but reserves approval for approvers', async () => {
    // No schema in packages/contracts describes a decision-record response (`DecisionSchema` is
    // only the outcome enum) - this 201 body is an uncovered contract surface, not asserted here.
    await request(app.getHttpServer())
      .post('/v1/cases/case_01J67X4Q7B5E6QG4S9CY0F7R2K/decisions')
      .set('x-role', 'reviewer')
      .send({
        outcome: 'request_information',
        reason: 'Material evidence is still missing.',
        version: 3,
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/v1/cases/case_01J67X4Q7B5E6QG4S9CY0F7R2K/decisions')
      .set('x-role', 'reviewer')
      .send({
        outcome: 'approve',
        reason: 'All evidence was reviewed and accepted.',
        version: 4,
      })
      .expect(403);
    expect(response.body).toMatchObject({ code: 'ROLE_FORBIDDEN' });
    expectMatchesSchema(ProblemDetailSchema, response.body, 'POST .../decisions 403 body');
  });
});
