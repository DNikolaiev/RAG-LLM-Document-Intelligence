import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DomainPackConfigurationSchema } from '@caselens/contracts';

/**
 * The Policy Library composes durable stores only under the production-local profile, so the
 * demo-mode harness in `api.e2e.test.ts` cannot reach this handler. This file selects the durable
 * provider composition and replaces the PostgreSQL stores and the S3/BullMQ providers with
 * in-memory stand-ins, so the domain-pack response shape is asserted end to end over HTTP.
 */
const seed = vi.hoisted(() => ({
  uploaded: new Map<string, Record<string, unknown>>(),
  mintedVersions: [] as string[],
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
    async get(_scope: unknown, id: string) {
      return seed.uploaded.get(id) ?? null;
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
    async close() {}
  }
  /** `PoliciesService` takes its job store from `PostgresCaseStore`, not the policy store. */
  class InMemoryCaseStore {
    async createJob(input: Record<string, unknown>) {
      return { ...input, id: `job_${seed.uploaded.size}` };
    }
    async appendJobEvent() {}
    async updateJob() {}
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
    const { PoliciesController } = await import('../src/policies/policies.controller.js');
    const { PoliciesService } = await import('../src/policies/policies.service.js');
    const module = await Test.createTestingModule({
      controllers: [PoliciesController],
      providers: [PoliciesService],
    }).compile();
    app = module.createNestApplication();
    const context = new ContextMiddleware();
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

    expect(() => DomainPackConfigurationSchema.parse(response.body)).not.toThrow();
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
    const { PoliciesController } = await import('../src/policies/policies.controller.js');
    const { PoliciesService } = await import('../src/policies/policies.service.js');
    const module = await Test.createTestingModule({
      controllers: [PoliciesController],
      providers: [PoliciesService],
    }).compile();
    app = module.createNestApplication();
    const context = new ContextMiddleware();
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
