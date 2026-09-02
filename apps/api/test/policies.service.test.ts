import { pharmacySupplierPack } from '@caselens/domain';
import { describe, expect, it } from 'vitest';
import { buildRuleRegistry } from '../src/policies/policies.service.js';

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
