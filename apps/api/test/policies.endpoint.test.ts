import type { CasesRuntime } from '../src/cases-runtime.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DomainPackConfigurationSchema } from '@caselens/contracts';
import { expectMatchesSchema } from './support/contract.js';

/**
 * The Policy Library composes durable stores only under the production-local profile, so the
 * demo-mode harness in `api.e2e.test.ts` cannot reach this handler. This file selects the durable
 * provider composition and replaces the PostgreSQL stores and the S3/BullMQ providers with
 * in-memory stand-ins, so the domain-pack response shape is asserted end to end over HTTP.
 */
const seed = vi.hoisted(() => ({
  uploaded: new Map<string, Record<string, unknown>>(),
  mintedVersions: [] as string[],
  filings: [] as Array<Record<string, unknown>>,
  jobUpdates: [] as Array<Record<string, unknown>>,
  pausedJobs: new Map<string, Record<string, unknown>>(),
  enqueued: [] as string[],
  policies: [
    {
      id: 'policy_cold_chain',
      tenantId: 'tenant_demo',
      domainPackId: 'pack_tenant_demo',
      title: 'Cold chain distribution policy',
      collectionId: 'pharmaceutical-distribution',
      status: 'active',
    },
  ],
  rules: [
    {
      id: 'policy_rule_cold_chain',
      title: 'Cold chain excursion reporting',
      description: 'Temperature excursions must be reported within 24 hours.',
      severity: 'critical' as const,
      policyDocumentId: 'policy_cold_chain',
      policyVersion: 'portfolio-2026.08.31',
    },
  ],
}));

vi.mock('@caselens/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@caselens/persistence')>();
  class InMemoryPolicyStore {
    async list(_scope: unknown, filters: { domainPackId?: string; status?: string } = {}) {
      return seed.policies.filter(
        (policy) =>
          (!filters.domainPackId || policy.domainPackId === filters.domainPackId) &&
          (!filters.status || policy.status === filters.status),
      );
    }
    /**
     * No persisted definition for this tenant, so the service falls back to the compiled
     * catalog - the pre-field-dictionary state every existing volume is still in.
     */
    async getActivePackDefinition() {
      return null;
    }
    async listActiveRules(tenantId: string, domainPackId: string) {
      const active = new Set(
        seed.policies
          .filter(
            (policy) =>
              policy.tenantId === tenantId &&
              policy.domainPackId === domainPackId &&
              policy.status === 'active',
          )
          .map((policy) => policy.id),
      );
      return seed.rules.filter((rule) => active.has(rule.policyDocumentId));
    }
    async getDomainPackDescriptor(_tenantId: string, id: string) {
      return { id, domainKey: 'pharmacy-supplier', semanticVersion: '1.0.0' };
    }
    async get(scope: { tenantIds: readonly string[]; platformAdmin: boolean }, id: string) {
      const policy = seed.uploaded.get(id);
      if (!policy) return null;
      return scope.platformAdmin || scope.tenantIds.includes(String(policy.tenantId))
        ? policy
        : null;
    }
    async create(input: Record<string, unknown>) {
      const policy = { ...input, status: 'processing' };
      seed.uploaded.set(String(input.id), policy);
      return policy;
    }
    async savePackVersion(input: { semanticVersion: string }) {
      seed.mintedVersions.push(input.semanticVersion);
      return { semanticVersion: input.semanticVersion };
    }
    /** Mirrors the SQL: only from awaiting_collection, only at the version the caller saw. */
    async fileCollection(input: {
      id: string;
      expectedVersion: number;
      collectionId: string;
      details: Record<string, unknown>;
    }) {
      const current = seed.uploaded.get(input.id);
      if (
        !current ||
        current.status !== 'awaiting_collection' ||
        current.version !== input.expectedVersion
      ) {
        throw new Error(`POLICY_COLLECTION_STATE_CONFLICT:${input.id}`);
      }
      const filed = {
        ...current,
        status: 'processing',
        collectionId: input.collectionId,
        version: Number(current.version) + 1,
      };
      seed.uploaded.set(input.id, filed);
      seed.filings.push(input);
      return filed;
    }
    async updateStatus(input: { id: string; status: string }) {
      const next = { ...seed.uploaded.get(input.id), status: input.status };
      seed.uploaded.set(input.id, next);
      return next;
    }
    async close() {}
  }
  /** `PoliciesService` takes its job store from `PostgresCaseStore`, not the policy store. */
  class InMemoryCaseStore {
    async createJob(input: Record<string, unknown>) {
      return { ...input, id: `job_${seed.uploaded.size}` };
    }
    async appendJobEvent() {}
    async updateJob(id: string, _tenantId: string, patch: Record<string, unknown>) {
      seed.jobUpdates.push({ id, ...patch });
    }
    async findPausedJob(_tenantId: string, _targetType: string, targetId: string) {
      return seed.pausedJobs.get(targetId) ?? null;
    }
    async close() {}
  }
  return {
    ...actual,
    PostgresPolicyStore: InMemoryPolicyStore as unknown as typeof actual.PostgresPolicyStore,
    PostgresCaseStore: InMemoryCaseStore as unknown as typeof actual.PostgresCaseStore,
  };
});

vi.mock('@caselens/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@caselens/providers')>();
  class InertStorageProvider {
    async put(key: string) {
      return { ok: true as const, value: { key }, meta: {} };
    }
    async close() {}
  }
  class InertQueueProvider {
    async enqueue(_type: string, _payload: unknown, options: { idempotencyKey: string }) {
      seed.enqueued.push(options.idempotencyKey);
      return {
        ok: true as const,
        value: { jobId: `queue_${options.idempotencyKey}`, duplicate: false },
        meta: {},
      };
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

describe('GET /v1/policies/domain-pack', () => {
  let app: INestApplication;
  const originalEnvironment = { ...process.env };

  beforeAll(async () => {
    Object.assign(process.env, durableComposition);
    const { ContextMiddleware } = await import('../src/context.middleware.js');
    const { ProblemDetailsFilter } = await import('../src/problem.filter.js');
    const { PoliciesController } = await import('../src/policies/policies.controller.js');
    const { PoliciesService } = await import('../src/policies/policies.service.js');
    const module = await Test.createTestingModule({
      controllers: [PoliciesController],
      providers: [PoliciesService],
    }).compile();
    app = module.createNestApplication();
    // Registered exactly as main.ts does, so error bodies here are the RFC 7807 shape the
    // client actually receives rather than Nest's raw exception payload.
    app.useGlobalFilters(new ProblemDetailsFilter());
    // This module provides no cases runtime. Test-profile mode never consults it - only subject
    // mapping under verified identity does - so an explicit stub states that rather than hiding it
    // behind an optional parameter, which would fail open if injection ever went missing in production.
    const context = new ContextMiddleware({} as CasesRuntime);
    app.use(context.use.bind(context));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = originalEnvironment;
  });

  it('returns one rule registry in which every rule declares its origin', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/policies/domain-pack?tenantId=tenant_demo')
      .set('x-test-profile-id', 'profile_lena_vogt')
      .expect(200);

    expectMatchesSchema(
      DomainPackConfigurationSchema,
      response.body,
      'GET /v1/policies/domain-pack response',
    );
    expect(response.body.domainPack.rules).toContainEqual({
      id: 'insurance-minimum',
      title: 'Liability coverage below policy',
      description: 'Coverage must be at least EUR 2,000,000 per occurrence.',
      severity: 'major',
      collectionId: 'insurance',
      origin: {
        kind: 'domain_pack',
        domainPackName: 'Pharmaceutical supplier qualification',
        domainPackVersion: response.body.domainPack.version,
      },
    });
    expect(response.body.domainPack.rules).toContainEqual({
      id: 'policy_rule_cold_chain',
      title: 'Cold chain excursion reporting',
      description: 'Temperature excursions must be reported within 24 hours.',
      severity: 'critical',
      collectionId: 'pharmaceutical-distribution',
      origin: {
        kind: 'policy_document',
        policyId: 'policy_cold_chain',
        policyTitle: 'Cold chain distribution policy',
        policyVersion: 'portfolio-2026.08.31',
      },
    });
  });

  it("offers only the pack's own collections as upload targets", async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/policies/domain-pack?tenantId=tenant_demo')
      .set('x-test-profile-id', 'profile_lena_vogt')
      .expect(200);
    expectMatchesSchema(
      DomainPackConfigurationSchema,
      response.body,
      'GET /v1/policies/domain-pack response',
    );

    // Straight from `pack.policyCollections`, so every option the upload form builds from this
    // list is one `POST /v1/policies` will accept.
    expect(response.body.domainPack.uploadableCollections).toEqual([
      { id: 'supplier-qualification', label: 'Supplier Qualification Policy' },
      { id: 'pharmaceutical-distribution', label: 'Pharmaceutical Distribution Policy' },
      { id: 'insurance', label: 'Insurance Requirements' },
      { id: 'data-protection', label: 'Data Protection Policy' },
    ]);
  });

  it('never offers the synthetic general-controls collection as an upload target', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/policies/domain-pack?tenantId=tenant_demo')
      .set('x-test-profile-id', 'profile_lena_vogt')
      .expect(200);
    expectMatchesSchema(
      DomainPackConfigurationSchema,
      response.body,
      'GET /v1/policies/domain-pack response',
    );

    // `general-controls` exists so rules that declare no collection have somewhere to be shown.
    // It is not in `pack.policyCollections`, so uploading into it would always be refused.
    expect(
      response.body.domainPack.uploadableCollections.some(
        (collection: { id: string }) => collection.id === 'general-controls',
      ),
    ).toBe(false);
  });

  it('no longer splits the registry into baseline and policy rules', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/policies/domain-pack?tenantId=tenant_demo')
      .set('x-test-profile-id', 'profile_lena_vogt')
      .expect(200);
    expectMatchesSchema(
      DomainPackConfigurationSchema,
      response.body,
      'GET /v1/policies/domain-pack response',
    );

    expect(response.body.domainPack).not.toHaveProperty('baselineRules');
    expect(response.body.domainPack).not.toHaveProperty('policyRules');
  });
});

/**
 * Regression guard for an ordering defect. `resolveUploadCollection` originally ran before the
 * idempotency replay, so retrying a successful upload that had created a collection hit
 * POLICY_COLLECTION_EXISTS instead of returning the stored policy - breaking the idempotency
 * invariant. No unit test can catch this: the defect is the ORDER of side effects inside
 * `upload()`, which is only reachable over HTTP against a durable composition.
 */
describe('POST /v1/policies collection creation', () => {
  let app: INestApplication;
  const originalEnvironment = { ...process.env };
  const pdf = readFileSync(
    join(
      fileURLToPath(new URL('../../../', import.meta.url)),
      'fixtures/documents/policy-lab/legal/01_termination-notice-minimum-policy.pdf',
    ),
  );

  beforeAll(async () => {
    Object.assign(process.env, durableComposition);
    const { ContextMiddleware } = await import('../src/context.middleware.js');
    const { ProblemDetailsFilter } = await import('../src/problem.filter.js');
    const { PoliciesController } = await import('../src/policies/policies.controller.js');
    const { PoliciesService } = await import('../src/policies/policies.service.js');
    const module = await Test.createTestingModule({
      controllers: [PoliciesController],
      providers: [PoliciesService],
    }).compile();
    app = module.createNestApplication();
    // Registered exactly as main.ts does, so error bodies here are the RFC 7807 shape the
    // client actually receives rather than Nest's raw exception payload.
    app.useGlobalFilters(new ProblemDetailsFilter());
    // This module provides no cases runtime. Test-profile mode never consults it - only subject
    // mapping under verified identity does - so an explicit stub states that rather than hiding it
    // behind an optional parameter, which would fail open if injection ever went missing in production.
    const context = new ContextMiddleware({} as CasesRuntime);
    app.use(context.use.bind(context));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = { ...originalEnvironment };
  });

  it('replays an upload that created a collection instead of refusing the taken slug', async () => {
    seed.uploaded.clear();
    seed.mintedVersions.length = 0;
    const send = () =>
      request(app.getHttpServer())
        .post('/v1/policies')
        .set('x-test-profile-id', 'profile_mara_stein')
        .set('idempotency-key', 'collection-replay')
        .field('tenantId', 'tenant_demo')
        .field('title', 'Cold chain quality controls')
        .field('policyVersion', '2026.1')
        .field('newCollectionLabel', 'Quality Controls')
        .field('validFrom', '2026-01-01')
        .attach('file', pdf, { filename: 'policy.pdf', contentType: 'application/pdf' });

    const first = await send();
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(seed.mintedVersions).toHaveLength(1);

    const replay = await send();
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
    // The replay must not mint a second version, and must not fail on the slug it just created.
    expect(seed.mintedVersions).toHaveLength(1);
  });
});

describe('POST /v1/policies/:id/collection', () => {
  let app: INestApplication;
  const originalEnvironment = { ...process.env };
  const pdf = readFileSync(
    join(
      fileURLToPath(new URL('../../../', import.meta.url)),
      'fixtures/documents/policy-lab/legal/01_termination-notice-minimum-policy.pdf',
    ),
  );

  function waiting(id: string, tenantId = 'tenant_demo') {
    seed.uploaded.set(id, {
      id,
      tenantId,
      domainPackId: `pack_${tenantId}`,
      title: 'Anti-bribery policy',
      policyVersion: '2026.1',
      collectionId: null,
      status: 'awaiting_collection',
      version: 4,
      collectionSuggestion: {
        decision: 'new',
        label: 'Anti-Bribery',
        rationale: 'Governs gifts and payments to officials; no collection covers that.',
        nearestCollectionId: null,
        confidence: 0.64,
        evidence: { quote: 'No employee may offer or accept a payment', page: 1 },
        disposition: 'decision_required',
        reasons: ['new_collection'],
        providerId: 'test-model',
        model: 'test-model-v1',
        packVersion: '1.0.0',
        classifiedAt: '2026-09-14T10:00:00.000Z',
      },
    });
    seed.pausedJobs.set(id, {
      id: `job_paused_${id}`,
      tenantId,
      targetType: 'policy_version',
      targetId: id,
      status: 'paused',
    });
  }

  const decide = (id: string, body: Record<string, unknown>, profile = 'profile_lena_vogt') =>
    request(app.getHttpServer())
      .post(`/v1/policies/${id}/collection`)
      .set('x-test-profile-id', profile)
      .send(body);

  beforeAll(async () => {
    Object.assign(process.env, durableComposition);
    const { ContextMiddleware } = await import('../src/context.middleware.js');
    const { ProblemDetailsFilter } = await import('../src/problem.filter.js');
    const { PoliciesController } = await import('../src/policies/policies.controller.js');
    const { PoliciesService } = await import('../src/policies/policies.service.js');
    const module = await Test.createTestingModule({
      controllers: [PoliciesController],
      providers: [PoliciesService],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    const context = new ContextMiddleware({} as CasesRuntime);
    app.use(context.use.bind(context));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = { ...originalEnvironment };
  });

  it('files a waiting policy into an existing collection and resumes its paused job', async () => {
    waiting('policy_wait_existing');
    const response = await decide('policy_wait_existing', {
      collectionId: 'insurance',
      version: 4,
    }).expect(201);

    expect(response.body).toMatchObject({
      policy: { collectionId: 'insurance', status: 'processing', version: 5 },
      jobId: 'job_paused_policy_wait_existing',
      alreadyDecided: false,
    });
    // The audit record says what was suggested and that the administrator chose otherwise.
    expect(seed.filings.at(-1)).toMatchObject({
      collectionId: 'insurance',
      expectedVersion: 4,
      details: {
        collectionId: 'insurance',
        createdCollection: false,
        suggestion: { decision: 'new', collectionId: 'anti-bribery' },
        followedSuggestion: false,
      },
    });
    // The same job resumes, under a fresh queue id with no ':' in it.
    expect(seed.enqueued.at(-1)).toBe('job_paused_policy_wait_existing-collection-insurance');
    expect(seed.jobUpdates.at(-1)).toMatchObject({
      id: 'job_paused_policy_wait_existing',
      status: 'queued',
      eventType: 'queue.enqueued',
      message: 'Filed into Insurance Requirements by an administrator; processing resumes.',
    });
  });

  it('accepts the suggested new collection, minting it before filing', async () => {
    waiting('policy_wait_new');
    const minted = seed.mintedVersions.length;
    const response = await decide('policy_wait_new', {
      newCollectionLabel: 'Anti-Bribery',
      version: 4,
    }).expect(201);

    expect(response.body.policy).toMatchObject({ collectionId: 'anti-bribery' });
    expect(seed.mintedVersions).toHaveLength(minted + 1);
    expect(seed.filings.at(-1)).toMatchObject({
      details: { createdCollection: true, followedSuggestion: true },
    });
  });

  it('requires exactly one of choosing and naming', async () => {
    waiting('policy_wait_ambiguous');
    for (const body of [
      { version: 4 },
      { collectionId: '  ', version: 4 },
      { collectionId: 'insurance', newCollectionLabel: 'Anti-Bribery', version: 4 },
    ]) {
      const response = await decide('policy_wait_ambiguous', body).expect(400);
      expect(response.body.code, JSON.stringify(body)).toBe('POLICY_COLLECTION_DECISION_REQUIRED');
    }
  });

  it('refuses a decision made on a stale screen', async () => {
    waiting('policy_wait_stale');
    const response = await decide('policy_wait_stale', {
      collectionId: 'insurance',
      version: 3,
    }).expect(409);
    expect(response.body.code).toBe('VERSION_CONFLICT');
  });

  it('returns a decision already applied, and refuses a different one', async () => {
    waiting('policy_wait_repeat');
    await decide('policy_wait_repeat', { collectionId: 'insurance', version: 4 }).expect(201);
    const enqueuedBefore = seed.enqueued.length;

    const repeated = await decide('policy_wait_repeat', {
      collectionId: 'insurance',
      version: 4,
    }).expect(201);
    expect(repeated.body).toMatchObject({ alreadyDecided: true, jobId: null });
    expect(seed.enqueued).toHaveLength(enqueuedBefore);

    const different = await decide('policy_wait_repeat', {
      collectionId: 'data-protection',
      version: 5,
    }).expect(409);
    expect(different.body.code).toBe('POLICY_COLLECTION_ALREADY_SETTLED');
  });

  it("does not let another tenant's administrator see the policy at all", async () => {
    // Every test identity administers its workspace, so isolation is the boundary to prove here.
    waiting('policy_wait_foreign');
    const response = await decide(
      'policy_wait_foreign',
      { collectionId: 'insurance', version: 4 },
      'profile_jonas_feld',
    ).expect(404);
    expect(response.body.code).toBe('POLICY_NOT_FOUND');
  });

  it('accepts an upload that names no collection, leaving it to classification', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/policies')
      .set('x-test-profile-id', 'profile_lena_vogt')
      .set('idempotency-key', 'upload-without-collection')
      .field('tenantId', 'tenant_demo')
      .field('title', 'Anti-bribery policy')
      .field('policyVersion', '2026.2')
      .field('validFrom', '2026-01-01')
      .attach('file', pdf, { filename: 'anti-bribery.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(response.body).toMatchObject({ title: 'Anti-bribery policy', collectionId: null });
    expect(seed.jobUpdates.at(-1)).toMatchObject({
      eventType: 'queue.enqueued',
      message: 'Policy queued. CaseLens will file it into a collection once its text is read.',
    });
  });
});
