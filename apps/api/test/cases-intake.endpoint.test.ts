import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CaseIntakeResponseSchema, ProblemDetailSchema } from '@caselens/contracts';
import { expectMatchesSchema } from './support/contract.js';

/**
 * `ProductionCasesService` composes durable stores only under the production-local profile, so
 * the demo-mode harness in `api.e2e.test.ts` cannot reach it - it always resolves the in-memory
 * `CasesService` instead (see `AppModule`'s `CASES_RUNTIME` factory). This file selects the
 * durable composition and replaces `PostgresCaseStore`/`PostgresPolicyStore` and the S3/BullMQ
 * providers with in-memory stand-ins, following the same pattern `policies.endpoint.test.ts`
 * already uses for `PoliciesService.upload`'s own ordering fix - so `POST /v1/cases/intake`'s
 * ordering (resolve tenant, validate every file, THEN create/attach/queue) is asserted against
 * the real `ProductionCasesService` code path over HTTP, not just against the demo service.
 *
 * Every mocked store/provider call that matters for these assertions is appended to `seed`'s
 * logs rather than counted with a running total, because `ProductionCasesService.onModuleInit`
 * materializes the seed fixtures' documents on startup (real fixture files, real `storage.put`
 * and `recordDocument` calls) - logging and then filtering by the test's own case id keeps these
 * assertions immune to that unrelated startup activity instead of having to reset counters
 * between tests.
 */
const seed = vi.hoisted(() => ({
  cases: new Map<string, Record<string, unknown>>(),
  documents: new Map<string, Array<Record<string, unknown>>>(),
  jobsByKey: new Map<string, Record<string, unknown>>(),
  storagePutCalls: [] as Array<{ key: string }>,
  recordDocumentCalls: [] as Array<{
    caseId: string;
    id: string;
    tenantId: string;
    storageKey: string;
  }>,
  createJobCalls: [] as Array<{ tenantId: string; idempotencyKey: string }>,
  enqueueCalls: [] as Array<{ type: string; idempotencyKey: string }>,
}));

vi.mock('@caselens/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@caselens/persistence')>();

  class InMemoryCaseStore {
    async health() {}
    async close() {}
    /** Real seeding is irrelevant to intake; every test creates its own case from scratch. */
    async seed() {}
    async listDocuments(_scope: unknown, caseId: string) {
      return seed.documents.get(caseId) ?? [];
    }
    async recordDocument(input: Record<string, unknown> & { caseId: string; id: string }) {
      seed.recordDocumentCalls.push({
        caseId: input.caseId,
        id: input.id,
        tenantId: String(input.tenantId),
        storageKey: String(input.storageKey),
      });
      const list = seed.documents.get(input.caseId) ?? [];
      list.push(input);
      seed.documents.set(input.caseId, list);
    }
    async get(_scope: unknown, id: string) {
      const item = seed.cases.get(id);
      return item ? structuredClone(item) : null;
    }
    async insert(item: Record<string, unknown> & { id: string }) {
      if (seed.cases.has(item.id)) return false;
      seed.cases.set(item.id, structuredClone(item));
      return true;
    }
    async save(
      item: Record<string, unknown> & { id: string; version: number },
      expectedVersion: number,
    ) {
      const current = seed.cases.get(item.id) as { version: number } | undefined;
      if (!current || current.version !== expectedVersion) {
        throw new Error(`VERSION_CONFLICT:${item.id}`);
      }
      seed.cases.set(item.id, structuredClone(item));
    }
    async createJob(
      job: Record<string, unknown> & { id: string; tenantId: string; idempotencyKey: string },
    ) {
      const key = `${job.tenantId}:${job.idempotencyKey}`;
      seed.createJobCalls.push({ tenantId: job.tenantId, idempotencyKey: job.idempotencyKey });
      const existing = seed.jobsByKey.get(key);
      if (existing) return existing;
      seed.jobsByKey.set(key, job);
      return job;
    }
    async updateJob() {}
  }

  /** Intake never touches the policy store; only `close()` (called from `onModuleDestroy`) matters. */
  class InertPolicyStore {
    async close() {}
  }

  return {
    ...actual,
    PostgresCaseStore: InMemoryCaseStore as unknown as typeof actual.PostgresCaseStore,
    PostgresPolicyStore: InertPolicyStore as unknown as typeof actual.PostgresPolicyStore,
  };
});

vi.mock('@caselens/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@caselens/providers')>();

  class InertStorageProvider {
    async put(key: string) {
      seed.storagePutCalls.push({ key });
      return { ok: true as const, value: { key }, meta: {} };
    }
    async health() {
      return { ok: true as const, value: undefined, meta: {} };
    }
    async close() {}
  }

  class InertQueueProvider {
    async enqueue(type: string, _payload: unknown, options: { idempotencyKey: string }) {
      seed.enqueueCalls.push({ type, idempotencyKey: options.idempotencyKey });
      return {
        ok: true as const,
        value: { jobId: `queue_${options.idempotencyKey}`, duplicate: false },
        meta: {},
      };
    }
    async health() {
      return { ok: true as const, value: undefined, meta: {} };
    }
  }

  return {
    ...actual,
    S3CompatibleStorageProvider:
      InertStorageProvider as unknown as typeof actual.S3CompatibleStorageProvider,
    BullMqQueueProvider: InertQueueProvider as unknown as typeof actual.BullMqQueueProvider,
  };
});

const durableComposition = {
  PERSISTENCE_PROVIDER: 'postgres',
  DATABASE_URL: 'postgresql://app:secret@postgres/caselens',
  QUEUE_PROVIDER: 'bullmq',
  REDIS_URL: 'redis://:secret@redis:6379',
  STORAGE_PROVIDER: 's3',
  S3_ENDPOINT: 'http://minio:9000',
  S3_ACCESS_KEY: 'app',
  S3_SECRET_KEY: 'secret',
} as const;

function pdf(body = '/Type /Page'): Buffer {
  return Buffer.from(`%PDF-1.7\n${body}\n%%EOF`);
}

describe('POST /v1/cases/intake (durable)', () => {
  let app: INestApplication;
  const originalEnvironment = { ...process.env };

  beforeAll(async () => {
    Object.assign(process.env, durableComposition);
    const { ContextMiddleware } = await import('../src/context.middleware.js');
    const { ProblemDetailsFilter } = await import('../src/problem.filter.js');
    const { CasesController } = await import('../src/cases.controller.js');
    const { ProductionCasesService } = await import('../src/production-cases.service.js');
    const { CASES_RUNTIME } = await import('../src/cases-runtime.js');
    const module = await Test.createTestingModule({
      controllers: [CasesController],
      providers: [{ provide: CASES_RUNTIME, useClass: ProductionCasesService }],
    }).compile();
    app = module.createNestApplication();
    // Registered exactly as main.ts does, so error bodies here are the RFC 7807 shape the
    // client actually receives rather than Nest's raw exception payload.
    app.useGlobalFilters(new ProblemDetailsFilter());
    const context = new ContextMiddleware();
    app.use(context.use.bind(context));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = originalEnvironment;
  });

  it('creates the case, attaches every document, and queues processing in one call', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/cases/intake')
      .set('x-test-profile-id', 'profile_lena_vogt')
      .set('idempotency-key', 'intake-happy-path')
      .field('subjectName', 'Example Supplier GmbH')
      .attach('file', pdf(), { filename: 'questionnaire.pdf', contentType: 'application/pdf' })
      .attach('file', pdf(), { filename: 'certificate.pdf', contentType: 'application/pdf' })
      .expect(201);

    expectMatchesSchema(CaseIntakeResponseSchema, response.body, 'POST /v1/cases/intake 201 body');
    expect(response.body).toMatchObject({
      caseId: expect.any(String),
      reference: expect.any(String),
    });
    expect(response.body.documentIds).toHaveLength(2);
    expect(response.body.jobIds).toHaveLength(1);

    const caseId = response.body.caseId as string;
    expect(seed.recordDocumentCalls.filter((call) => call.caseId === caseId)).toHaveLength(2);
    expect(
      seed.storagePutCalls.filter((call) => call.key.startsWith(`tenant_demo/${caseId}/`)),
    ).toHaveLength(2);
    expect(seed.createJobCalls.filter((call) => call.idempotencyKey.includes(caseId))).toHaveLength(
      1,
    );
  });

  it('locks a tenant user to their own tenant even if they name another one', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/cases/intake')
      .set('x-test-profile-id', 'profile_jonas_feld') // tenant_legal only
      .set('idempotency-key', 'intake-tenant-lock')
      .field('subjectName', 'Cross-Tenant Attempt GmbH')
      .field('tenantId', 'tenant_demo')
      .attach('file', pdf(), { filename: 'doc.pdf', contentType: 'application/pdf' })
      .expect(201);

    expectMatchesSchema(CaseIntakeResponseSchema, response.body, 'POST /v1/cases/intake 201 body');
    const stored = seed.cases.get(response.body.caseId as string);
    expect(stored).toMatchObject({ tenantId: 'tenant_legal' });
  });

  it('requires a platform administrator to name a tenant', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/cases/intake')
      .set('x-test-profile-id', 'profile_mara_stein') // platform admin, no default tenant
      .set('idempotency-key', 'intake-no-tenant')
      .field('subjectName', 'No Tenant Named GmbH')
      .attach('file', pdf(), { filename: 'doc.pdf', contentType: 'application/pdf' })
      .expect(400);

    expect(response.body).toMatchObject({ code: 'TENANT_REQUIRED' });
    expectMatchesSchema(
      ProblemDetailSchema,
      response.body,
      'POST /v1/cases/intake 400 body (TENANT_REQUIRED)',
    );
  });

  it('lets a platform administrator file into a tenant they belong to', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/cases/intake')
      .set('x-test-profile-id', 'profile_mara_stein')
      .set('idempotency-key', 'intake-platform-admin-choice')
      .field('subjectName', 'Legal Tenant Filing GmbH')
      .field('tenantId', 'tenant_legal')
      .attach('file', pdf(), { filename: 'doc.pdf', contentType: 'application/pdf' })
      .expect(201);

    expectMatchesSchema(CaseIntakeResponseSchema, response.body, 'POST /v1/cases/intake 201 body');
    const stored = seed.cases.get(response.body.caseId as string);
    expect(stored).toMatchObject({ tenantId: 'tenant_legal' });
  });

  it('aborts the whole intake with nothing created when one of several files is bad', async () => {
    const casesBefore = seed.cases.size;
    const documentCallsBefore = seed.recordDocumentCalls.length;
    const storageCallsBefore = seed.storagePutCalls.length;

    const response = await request(app.getHttpServer())
      .post('/v1/cases/intake')
      .set('x-test-profile-id', 'profile_lena_vogt')
      .set('idempotency-key', 'intake-bad-file')
      .field('subjectName', 'Partial Batch GmbH')
      .attach('file', pdf(), { filename: 'good-one.pdf', contentType: 'application/pdf' })
      .attach('file', Buffer.from('not a pdf at all'), {
        filename: 'bad-two.pdf',
        contentType: 'application/pdf',
      })
      .attach('file', pdf(), { filename: 'good-three.pdf', contentType: 'application/pdf' })
      .expect(400);

    // The problem-details filter emits only the documented RFC 7807 members, so the thrown
    // `fileName` extension never reaches a client. What the reviewer actually sees is `detail`,
    // which the service prefixes with the offending filename - so that is what is asserted.
    expect(response.body).toMatchObject({ code: 'UPLOAD_QUARANTINED' });
    expect(response.body.detail).toContain('bad-two.pdf');
    expectMatchesSchema(
      ProblemDetailSchema,
      response.body,
      'POST /v1/cases/intake 400 body (UPLOAD_QUARANTINED)',
    );
    // Nothing was created or attached anywhere - not just for this request's own (never minted)
    // case id, but at all: neither of the two GOOD files in the batch was stored either.
    expect(seed.cases.size).toBe(casesBefore);
    expect(seed.recordDocumentCalls).toHaveLength(documentCallsBefore);
    expect(seed.storagePutCalls).toHaveLength(storageCallsBefore);
  });

  it('refuses more documents than the per-case ceiling', async () => {
    let builder = request(app.getHttpServer())
      .post('/v1/cases/intake')
      .set('x-test-profile-id', 'profile_lena_vogt')
      .set('idempotency-key', 'intake-too-many')
      .field('subjectName', 'Too Many GmbH');
    for (let index = 0; index < 33; index += 1) {
      builder = builder.attach('file', pdf(), {
        filename: `doc-${index}.pdf`,
        contentType: 'application/pdf',
      });
    }
    const response = await builder.expect(400);
    expect(response.body).toMatchObject({ code: 'TOO_MANY_DOCUMENTS' });
    expectMatchesSchema(
      ProblemDetailSchema,
      response.body,
      'POST /v1/cases/intake 400 body (TOO_MANY_DOCUMENTS)',
    );
  });

  it('requires at least one file', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/cases/intake')
      .set('x-test-profile-id', 'profile_lena_vogt')
      .set('idempotency-key', 'intake-no-files')
      .field('subjectName', 'No Files GmbH')
      .expect(400);

    expect(response.body).toMatchObject({ code: 'FILE_REQUIRED' });
    expectMatchesSchema(
      ProblemDetailSchema,
      response.body,
      'POST /v1/cases/intake 400 body (FILE_REQUIRED)',
    );
  });

  it('replays the same idempotency key without re-attaching a document or re-queuing', async () => {
    const send = () =>
      request(app.getHttpServer())
        .post('/v1/cases/intake')
        .set('x-test-profile-id', 'profile_lena_vogt')
        .set('idempotency-key', 'intake-replay')
        .field('subjectName', 'Replay GmbH')
        .attach('file', pdf(), { filename: 'first.pdf', contentType: 'application/pdf' })
        .attach('file', pdf(), { filename: 'second.pdf', contentType: 'application/pdf' });

    const first = await send().expect(201);
    expectMatchesSchema(CaseIntakeResponseSchema, first.body, 'POST /v1/cases/intake 201 body');
    const caseId = first.body.caseId as string;
    // `createJob` is called with the descriptive durable key (which embeds the case id);
    // `queue.enqueue` is called with the job's own hash id instead - two different strings, so
    // each is matched against the value that actually appears in its own log.
    const jobId = first.body.jobIds[0] as string;
    const documentCallsAfterFirst = seed.recordDocumentCalls.filter(
      (call) => call.caseId === caseId,
    ).length;
    const storageCallsAfterFirst = seed.storagePutCalls.filter((call) =>
      call.key.startsWith(`tenant_demo/${caseId}/`),
    ).length;
    const jobCallsAfterFirst = seed.createJobCalls.filter((call) =>
      call.idempotencyKey.includes(caseId),
    ).length;
    const enqueueCallsAfterFirst = seed.enqueueCalls.filter(
      (call) => call.idempotencyKey === jobId,
    ).length;

    const second = await send().expect(201);

    expect(second.body).toEqual(first.body);
    expect(seed.recordDocumentCalls.filter((call) => call.caseId === caseId)).toHaveLength(
      documentCallsAfterFirst,
    );
    expect(
      seed.storagePutCalls.filter((call) => call.key.startsWith(`tenant_demo/${caseId}/`)),
    ).toHaveLength(storageCallsAfterFirst);
    expect(seed.createJobCalls.filter((call) => call.idempotencyKey.includes(caseId))).toHaveLength(
      jobCallsAfterFirst,
    );
    expect(seed.enqueueCalls.filter((call) => call.idempotencyKey === jobId)).toHaveLength(
      enqueueCallsAfterFirst,
    );
  });
});

/**
 * Regression guard for a tenant-isolation defect. `mutable()` scopes a case read by
 * `context.tenantIds`, so a platform administrator legitimately opens a case in any of their
 * tenants — but `addDocument` then derived the storage prefix and the document's own tenant from
 * `context.tenantId`, which for a platform administrator falls back to the first tenant in their
 * list. Attaching evidence to another tenant's case therefore filed it under `tenant_demo`, so
 * the document's tenant diverged from its case's. The case owns the tenant, not the caller.
 */
describe('POST /v1/cases/:id/documents tenant attribution', () => {
  let app: INestApplication;
  const originalEnvironment = { ...process.env };
  const caseId = 'case_cross_tenant_evidence';

  beforeAll(async () => {
    Object.assign(process.env, durableComposition);
    const { ContextMiddleware } = await import('../src/context.middleware.js');
    const { ProblemDetailsFilter } = await import('../src/problem.filter.js');
    const { CasesController } = await import('../src/cases.controller.js');
    const { ProductionCasesService } = await import('../src/production-cases.service.js');
    const { CASES_RUNTIME } = await import('../src/cases-runtime.js');
    const module = await Test.createTestingModule({
      controllers: [CasesController],
      providers: [{ provide: CASES_RUNTIME, useClass: ProductionCasesService }],
    }).compile();
    app = module.createNestApplication();
    // Registered exactly as main.ts does, so error bodies here are the RFC 7807 shape the
    // client actually receives rather than Nest's raw exception payload.
    app.useGlobalFilters(new ProblemDetailsFilter());
    const context = new ContextMiddleware();
    app.use(context.use.bind(context));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = { ...originalEnvironment };
  });

  it('files evidence under the case owner, not the platform administrator', async () => {
    // Created through the real intake path as the platform administrator, naming tenant_legal -
    // which also exercises the tenant selection this change added to `create`/`intake`.
    const created = await request(app.getHttpServer())
      .post('/v1/cases/intake')
      .set('x-test-profile-id', 'profile_mara_stein')
      .set('idempotency-key', 'cross-tenant-case')
      .field('subjectName', 'Nordstern Handel GmbH')
      .field('tenantId', 'tenant_legal')
      .attach('file', pdf(), { filename: 'contract.pdf', contentType: 'application/pdf' })
      .expect(201);
    expectMatchesSchema(CaseIntakeResponseSchema, created.body, 'POST /v1/cases/intake 201 body');

    const caseId = created.body.caseId as string;
    seed.recordDocumentCalls.length = 0;

    const uploaded = await request(app.getHttpServer())
      .post(`/v1/cases/${caseId}/documents`)
      .set('x-test-profile-id', 'profile_mara_stein')
      .set('idempotency-key', 'cross-tenant-evidence')
      .attach('file', pdf('/Type /Page /Annex true'), {
        filename: 'annex.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    const recorded = seed.recordDocumentCalls.filter((call) => call.caseId === caseId);
    expect(recorded).toHaveLength(1);
    // Mara Stein's own context.tenantId falls back to tenant_demo; the case owns tenant_legal.
    expect(recorded[0]!.tenantId).toBe('tenant_legal');
    expect(recorded[0]!.storageKey.startsWith('tenant_legal/')).toBe(true);
  });
});
