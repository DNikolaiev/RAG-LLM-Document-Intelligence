import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { ProblemDetailsFilter } from '../src/problem.filter.js';

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
  });

  it('validates case creation and preserves idempotency', async () => {
    const invalid = await request(app.getHttpServer())
      .post('/v1/cases')
      .send({ subjectName: 'x' })
      .expect(400);
    expect(invalid.body).toMatchObject({ code: 'VALIDATION_FAILED' });

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
  });

  it('lets reviewers request information but reserves approval for approvers', async () => {
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
  });
});
