import { pharmacySupplierPack, type DomainPack } from '@caselens/domain';
import type { SavePackVersionInput, StoredFieldProposal } from '@caselens/persistence';
import { describe, expect, it } from 'vitest';
import type { RequestContext } from '../src/request-context.js';
import {
  applyFieldProposal,
  approveFieldProposal,
  buildRuleRegistry,
  rejectFieldProposal,
  type FieldProposalGovernanceStore,
} from '../src/policies/policies.service.js';

const activePolicies = [
  {
    id: 'policy_01',
    title: 'Cold chain distribution policy',
    collectionId: 'pharmaceutical-distribution',
  },
];

const activePolicyRules = [
  {
    id: 'rule_cold_chain',
    title: 'Cold chain excursion reporting',
    description: 'Temperature excursions must be reported within 24 hours.',
    severity: 'critical' as const,
    policyDocumentId: 'policy_01',
    policyVersion: '2026.3',
  },
  {
    id: 'rule_orphan',
    title: 'Rule from a policy that is no longer active',
    description: 'Must not reach the registry.',
    severity: 'minor' as const,
    policyDocumentId: 'policy_retired',
    policyVersion: '2025.1',
  },
];

describe('buildRuleRegistry', () => {
  it('unifies domain-pack and policy-derived rules under one collection key', () => {
    const registry = buildRuleRegistry(pharmacySupplierPack, activePolicies, activePolicyRules);

    expect(registry.rules).toContainEqual({
      id: 'insurance-minimum',
      title: 'Liability coverage below policy',
      description: 'Coverage must be at least EUR 2,000,000 per occurrence.',
      severity: 'major',
      collectionId: 'insurance',
      origin: {
        kind: 'domain_pack',
        domainPackName: pharmacySupplierPack.name,
        domainPackVersion: pharmacySupplierPack.version,
      },
    });
    expect(registry.rules).toContainEqual({
      id: 'rule_cold_chain',
      title: 'Cold chain excursion reporting',
      description: 'Temperature excursions must be reported within 24 hours.',
      severity: 'critical',
      collectionId: 'pharmaceutical-distribution',
      origin: {
        kind: 'policy_document',
        policyId: 'policy_01',
        policyTitle: 'Cold chain distribution policy',
        policyVersion: '2026.3',
      },
    });
  });

  it('skips a rule whose source policy is not active', () => {
    const registry = buildRuleRegistry(pharmacySupplierPack, activePolicies, activePolicyRules);
    expect(registry.rules.map((rule) => rule.id)).not.toContain('rule_orphan');
  });

  it('omits the general-controls collection when every rule declares one', () => {
    const registry = buildRuleRegistry(pharmacySupplierPack, activePolicies, activePolicyRules);
    expect(registry.collections.map((collection) => collection.id)).toEqual(
      pharmacySupplierPack.policyCollections.map((collection) => collection.id),
    );
    expect(registry.rules.every((rule) => rule.collectionId !== 'general-controls')).toBe(true);
  });

  it('appends the general-controls collection only when a rule falls into it', () => {
    const unassigned = {
      ...pharmacySupplierPack,
      rules: pharmacySupplierPack.rules.map((rule) =>
        rule.id === 'dpa-unsigned' ? { ...rule, collectionId: undefined } : rule,
      ),
    };
    const registry = buildRuleRegistry(unassigned, activePolicies, activePolicyRules);

    expect(registry.collections.at(-1)).toEqual({
      id: 'general-controls',
      label: 'General controls',
    });
    expect(registry.rules.find((rule) => rule.id === 'dpa-unsigned')).toMatchObject({
      collectionId: 'general-controls',
      origin: { kind: 'domain_pack' },
    });
  });
});

/**
 * `PoliciesService.runtime()` throws `POLICY_LIBRARY_REQUIRES_PRODUCTION_LOCAL` (503) unless
 * durable Postgres/S3/BullMQ stores are composed, so the demo-mode Nest harness in
 * `api.e2e.test.ts` can never reach the field-proposal endpoints. `approveFieldProposal` and
 * `rejectFieldProposal` are exported as pure functions over an injected
 * `FieldProposalGovernanceStore` for exactly this reason: this in-memory stand-in exercises the
 * governance logic directly, with no Nest module, no Postgres, and no HTTP layer involved.
 */
class InMemoryGovernanceStore implements FieldProposalGovernanceStore {
  readonly packs = new Map<string, DomainPack>();
  readonly proposals = new Map<string, StoredFieldProposal>();
  savedVersions: SavePackVersionInput[] = [];

  seedPack(tenantId: string, domainPackId: string, pack: DomainPack): void {
    this.packs.set(`${tenantId}:${domainPackId}`, pack);
  }

  seedProposal(proposal: StoredFieldProposal): void {
    this.proposals.set(proposal.id, proposal);
  }

  async getFieldProposal(tenantId: string, id: string): Promise<StoredFieldProposal | null> {
    const proposal = this.proposals.get(id);
    return proposal && proposal.tenantId === tenantId ? proposal : null;
  }

  async getActivePackDefinition(
    tenantId: string,
    domainPackId: string,
  ): Promise<DomainPack | null> {
    return this.packs.get(`${tenantId}:${domainPackId}`) ?? null;
  }

  async savePackVersion(input: SavePackVersionInput): Promise<{ semanticVersion: string }> {
    const key = `${input.tenantId}:${input.domainPackId}`;
    const current = this.packs.get(key);
    if (!current) throw new Error(`DOMAIN_PACK_NOT_FOUND:${input.domainPackId}`);
    if (current.version !== input.supersedes) {
      throw new Error(`PACK_SUPERSEDES_NOT_FOUND:${input.supersedes}`);
    }
    this.savedVersions.push(input);
    this.packs.set(key, { ...input.definition, version: input.semanticVersion });
    return { semanticVersion: input.semanticVersion };
  }

  async setFieldProposalStatus(
    tenantId: string,
    id: string,
    status: StoredFieldProposal['status'],
    actorUserId: string,
    reason?: string,
  ): Promise<void> {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.tenantId !== tenantId) {
      throw new Error(`FIELD_PROPOSAL_NOT_FOUND:${id}`);
    }
    const terminal = proposal.status === 'approved' || proposal.status === 'rejected';
    if (terminal && proposal.status !== status) {
      throw new Error(`FIELD_PROPOSAL_STATE_CONFLICT:${id}`);
    }
    this.proposals.set(id, {
      ...proposal,
      status,
      reviewedByUserId: actorUserId,
      reviewReason: reason ?? null,
      reviewedAt: new Date().toISOString(),
    });
  }
}

const tenantId = 'tenant_field_dictionary';
const adminContext: RequestContext = {
  profileId: 'profile_admin',
  tenantId,
  tenantIds: [tenantId],
  userId: 'user_admin',
  role: 'admin',
  platformAdmin: false,
  correlationId: 'corr_admin',
};
const reviewerContext: RequestContext = {
  ...adminContext,
  profileId: 'profile_reviewer',
  userId: 'user_reviewer',
  role: 'reviewer',
};

function newFieldProposal(overrides: Partial<StoredFieldProposal> = {}): StoredFieldProposal {
  return {
    id: 'field_proposal_new',
    tenantId,
    domainPackId: `pack_${tenantId}`,
    policyDocumentId: 'policy_01',
    kind: 'new_field',
    documentTypeId: 'supplier_questionnaire',
    path: 'supplier.foundedYear',
    label: 'Year founded',
    fieldType: 'number',
    aliases: ['founding year'],
    citation: { chunkId: 'chunk_01', page: 2, quote: 'founded in 1998' },
    dedup: {
      verdict: 'distinct',
      matchedPath: null,
      similarity: null,
      reason: 'No similar field above the floor.',
    },
    status: 'proposed',
    issues: [],
    embedding: [],
    reviewedByUserId: null,
    reviewReason: null,
    reviewedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function aliasProposal(overrides: Partial<StoredFieldProposal> = {}): StoredFieldProposal {
  return newFieldProposal({
    id: 'field_proposal_alias',
    kind: 'alias',
    path: 'supplier.legalName',
    label: 'Legal name',
    fieldType: 'string',
    aliases: ['registered business name'],
    dedup: {
      verdict: 'duplicate',
      matchedPath: 'supplier.legalName',
      similarity: 0.94,
      reason: 'Matches the existing legal-name field.',
    },
    ...overrides,
  });
}

describe('applyFieldProposal', () => {
  it('lands a new_field proposal on the named documentType only', () => {
    const proposal = newFieldProposal();
    const next = applyFieldProposal(pharmacySupplierPack, proposal);

    const documentType = next.documentTypes.find(
      (candidate) => candidate.id === 'supplier_questionnaire',
    )!;
    expect(documentType.extractionFields).toContainEqual({
      path: 'supplier.foundedYear',
      label: 'Year founded',
      type: 'number',
      required: false,
      aliases: ['founding year'],
    });
    // No other document type gained a field.
    for (const other of next.documentTypes.filter(
      (candidate) => candidate.id !== 'supplier_questionnaire',
    )) {
      const before = pharmacySupplierPack.documentTypes.find(
        (candidate) => candidate.id === other.id,
      )!;
      expect(other.extractionFields).toEqual(before.extractionFields);
    }
  });

  it('appends only the new wording for an alias proposal, leaving the field otherwise untouched', () => {
    const proposal = aliasProposal();
    const next = applyFieldProposal(pharmacySupplierPack, proposal);

    const documentType = next.documentTypes.find(
      (candidate) => candidate.id === 'supplier_questionnaire',
    )!;
    const field = documentType.extractionFields.find(
      (candidate) => candidate.path === 'supplier.legalName',
    )!;
    expect(field.aliases).toEqual(['company name', 'registered business name']);
    expect(field.label).toBe('Legal name');
    expect(field.type).toBe('string');
    expect(field.required).toBe(true);
    // No new field was minted for the alias.
    expect(documentType.extractionFields).toHaveLength(
      pharmacySupplierPack.documentTypes.find((c) => c.id === 'supplier_questionnaire')!
        .extractionFields.length,
    );
  });

  it('does not duplicate wording the field already has', () => {
    const proposal = aliasProposal({ aliases: ['company name'] });
    const next = applyFieldProposal(pharmacySupplierPack, proposal);
    const field = next.documentTypes
      .find((candidate) => candidate.id === 'supplier_questionnaire')!
      .extractionFields.find((candidate) => candidate.path === 'supplier.legalName')!;
    expect(field.aliases).toEqual(['company name']);
  });

  it('fails without writing when a new_field path now collides with an existing field', () => {
    const proposal = newFieldProposal({ path: 'supplier.legalName' });
    expect(() => applyFieldProposal(pharmacySupplierPack, proposal)).toThrow();
    try {
      applyFieldProposal(pharmacySupplierPack, proposal);
      throw new Error('expected the call to throw');
    } catch (error) {
      expect((error as { getResponse: () => { code: string } }).getResponse().code).toBe(
        'FIELD_PROPOSAL_PATH_COLLISION',
      );
    }
  });

  it('fails cleanly when the named document type no longer exists', () => {
    try {
      applyFieldProposal(
        pharmacySupplierPack,
        newFieldProposal({ documentTypeId: 'retired_type' }),
      );
      throw new Error('expected the call to throw');
    } catch (error) {
      expect((error as { getResponse: () => { code: string } }).getResponse().code).toBe(
        'FIELD_PROPOSAL_DOCUMENT_TYPE_NOT_FOUND',
      );
    }
  });

  it('fails cleanly when an alias targets a field that no longer exists', () => {
    try {
      applyFieldProposal(pharmacySupplierPack, aliasProposal({ path: 'supplier.vanishedField' }));
      throw new Error('expected the call to throw');
    } catch (error) {
      expect((error as { getResponse: () => { code: string } }).getResponse().code).toBe(
        'FIELD_PROPOSAL_FIELD_NOT_FOUND',
      );
    }
  });
});

describe('approveFieldProposal', () => {
  function setup() {
    const store = new InMemoryGovernanceStore();
    store.seedPack(tenantId, `pack_${tenantId}`, pharmacySupplierPack);
    return store;
  }

  it('mints exactly one pack version for a proposed field', async () => {
    const store = setup();
    store.seedProposal(newFieldProposal());

    const result = await approveFieldProposal(store, adminContext, tenantId, 'field_proposal_new');

    expect(result).toEqual({ semanticVersion: '1.1.0' });
    expect(store.savedVersions).toHaveLength(1);
    expect(store.proposals.get('field_proposal_new')).toMatchObject({
      status: 'approved',
      reviewedByUserId: 'user_admin',
    });
    const active = await store.getActivePackDefinition(tenantId, `pack_${tenantId}`);
    expect(
      active!.documentTypes
        .find((documentType) => documentType.id === 'supplier_questionnaire')!
        .extractionFields.some((field) => field.path === 'supplier.foundedYear'),
    ).toBe(true);
  });

  it('is a no-op on a second approval, returning the same version without minting again', async () => {
    const store = setup();
    store.seedProposal(newFieldProposal());

    const first = await approveFieldProposal(store, adminContext, tenantId, 'field_proposal_new');
    const second = await approveFieldProposal(store, adminContext, tenantId, 'field_proposal_new');

    expect(second).toEqual(first);
    expect(store.savedVersions).toHaveLength(1);
  });

  it('rewrites an alias proposal onto the existing field and mints one version', async () => {
    const store = setup();
    store.seedProposal(aliasProposal());

    const result = await approveFieldProposal(
      store,
      adminContext,
      tenantId,
      'field_proposal_alias',
    );

    expect(result).toEqual({ semanticVersion: '1.1.0' });
    expect(store.savedVersions).toHaveLength(1);
    const active = await store.getActivePackDefinition(tenantId, `pack_${tenantId}`);
    const field = active!.documentTypes
      .find((documentType) => documentType.id === 'supplier_questionnaire')!
      .extractionFields.find((candidate) => candidate.path === 'supplier.legalName')!;
    expect(field.aliases).toEqual(['company name', 'registered business name']);
  });

  it('fails cleanly and mints nothing when the proposed path now collides', async () => {
    const store = setup();
    store.seedProposal(newFieldProposal({ path: 'supplier.legalName' }));

    try {
      await approveFieldProposal(store, adminContext, tenantId, 'field_proposal_new');
      throw new Error('expected the call to throw');
    } catch (error) {
      expect((error as { getResponse: () => { code: string } }).getResponse().code).toBe(
        'FIELD_PROPOSAL_PATH_COLLISION',
      );
    }
    expect(store.savedVersions).toHaveLength(0);
    expect(store.proposals.get('field_proposal_new')?.status).toBe('proposed');
  });

  it('refuses a non-administrator', async () => {
    const store = setup();
    store.seedProposal(newFieldProposal());

    try {
      await approveFieldProposal(store, reviewerContext, tenantId, 'field_proposal_new');
      throw new Error('expected the call to throw');
    } catch (error) {
      expect((error as { getStatus: () => number }).getStatus()).toBe(403);
      expect((error as { getResponse: () => { code: string } }).getResponse().code).toBe(
        'POLICY_ADMIN_REQUIRED',
      );
    }
    expect(store.savedVersions).toHaveLength(0);
    expect(store.proposals.get('field_proposal_new')?.status).toBe('proposed');
  });

  it('rejects approving a blocked (invalid) proposal', async () => {
    const store = setup();
    store.seedProposal(
      newFieldProposal({ status: 'invalid', issues: [{ code: 'BAD', message: 'bad' }] }),
    );

    try {
      await approveFieldProposal(store, adminContext, tenantId, 'field_proposal_new');
      throw new Error('expected the call to throw');
    } catch (error) {
      expect((error as { getStatus: () => number }).getStatus()).toBe(400);
      expect((error as { getResponse: () => { code: string } }).getResponse().code).toBe(
        'INVALID_FIELD_PROPOSAL',
      );
    }
    expect(store.savedVersions).toHaveLength(0);
  });
});

describe('rejectFieldProposal', () => {
  it('records the actor and reason without touching the pack', async () => {
    const store = new InMemoryGovernanceStore();
    store.seedPack(tenantId, `pack_${tenantId}`, pharmacySupplierPack);
    store.seedProposal(newFieldProposal());

    const result = await rejectFieldProposal(
      store,
      adminContext,
      tenantId,
      'field_proposal_new',
      'Not grounded in this policy version.',
    );

    expect(result).toEqual({ status: 'rejected' });
    expect(store.savedVersions).toHaveLength(0);
    expect(store.proposals.get('field_proposal_new')).toMatchObject({
      status: 'rejected',
      reviewedByUserId: 'user_admin',
      reviewReason: 'Not grounded in this policy version.',
    });
  });

  it('refuses a non-administrator', async () => {
    const store = new InMemoryGovernanceStore();
    store.seedPack(tenantId, `pack_${tenantId}`, pharmacySupplierPack);
    store.seedProposal(newFieldProposal());

    try {
      await rejectFieldProposal(store, reviewerContext, tenantId, 'field_proposal_new');
      throw new Error('expected the call to throw');
    } catch (error) {
      expect((error as { getStatus: () => number }).getStatus()).toBe(403);
    }
    expect(store.proposals.get('field_proposal_new')?.status).toBe('proposed');
  });
});
