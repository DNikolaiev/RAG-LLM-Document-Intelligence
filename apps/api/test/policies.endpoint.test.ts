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
    async close() {}
  }
  class InMemoryCaseStore {
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
    async close() {}
  }
  class InertQueueProvider {}
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

  it('no longer splits the registry into baseline and policy rules', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/policies/domain-pack?tenantId=tenant_demo')
      .set('x-test-profile-id', 'profile_lena_vogt')
      .expect(200);

    expect(response.body.domainPack).not.toHaveProperty('baselineRules');
    expect(response.body.domainPack).not.toHaveProperty('policyRules');
  });
});
