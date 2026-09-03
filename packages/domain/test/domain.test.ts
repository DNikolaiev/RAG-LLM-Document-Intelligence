import { describe, expect, it } from 'vitest';
import {
  evaluateCondition,
  evaluateRequiredDocuments,
  evaluateRules,
  mapDecision,
  normalizeCurrency,
  parseDomainPack,
  pharmacySupplierPack,
  insuranceClaimsPack,
  legalContractPack,
  manufacturingQualityPack,
  reconcileFacts,
  resolveCompiledDomainPack,
  resolveDomainPack,
  resolvePersistedDomainPack,
  resolvePath,
  type Condition,
} from '../src/index.js';

describe('domain pack catalog', () => {
  it('selects a domain-specific pack for every seeded tenant domain', () => {
    expect(resolveDomainPack('Pharmacy supplier qualification')).toBe(pharmacySupplierPack);
    expect(resolveDomainPack('Commercial contract review')).toBe(legalContractPack);
    expect(resolveDomainPack('Insurance claims assessment')).toBe(insuranceClaimsPack);
    expect(resolveDomainPack('Supplier quality assurance')).toBe(manufacturingQualityPack);
    expect(resolvePersistedDomainPack('pack_tenant_legal')).toBe(legalContractPack);
    expect(resolvePersistedDomainPack('unknown')).toBeNull();
  });

  it('resolves the compiled fallback for persisted and minted pack identifiers', () => {
    expect(resolveCompiledDomainPack('pack_tenant_legal')).toBe(legalContractPack);
    expect(resolveCompiledDomainPack('pack_tenant_legal_1_2_0')).toBe(legalContractPack);
    expect(resolveCompiledDomainPack('insurance-claims-assessment')).toBe(insuranceClaimsPack);
    expect(resolveCompiledDomainPack('pack_insurance')).toBe(insuranceClaimsPack);
    expect(resolveCompiledDomainPack('pack_manufacturing_1_0_0')).toBe(manufacturingQualityPack);
    expect(resolveCompiledDomainPack('pack_tenant_demo')).toBe(pharmacySupplierPack);
    expect(resolveCompiledDomainPack('pack_tenant_unknown')).toBeNull();
  });
});

describe('safe condition DSL', () => {
  const context = {
    facts: {
      number: 10,
      text: 'Cold Chain GDP',
      list: ['DE', 'EN'],
      nil: null,
      date: '2026-08-27',
    },
  };

  it.each<readonly [Condition, boolean]>([
    [{ operator: 'exists', path: 'facts.number', value: true }, true],
    [{ operator: 'exists', path: 'facts.missing', value: false }, true],
    [{ operator: 'eq', path: 'facts.text', value: ' cold chain gdp ' }, true],
    [{ operator: 'neq', path: 'facts.number', value: 11 }, true],
    [{ operator: 'in', path: 'facts.number', value: [9, 10] }, true],
    [{ operator: 'contains', path: 'facts.text', value: 'chain' }, true],
    [{ operator: 'contains', path: 'facts.list', value: 'de' }, true],
    [{ operator: 'gte', path: 'facts.number', value: 10 }, true],
    [{ operator: 'lte', path: 'facts.number', value: 10 }, true],
    [{ operator: 'after', path: 'facts.date', value: '2026-08-26' }, true],
    [{ operator: 'before', path: 'facts.date', value: '2026-08-28' }, true],
    [
      {
        operator: 'all',
        conditions: [
          { operator: 'eq', path: 'facts.number', value: 10 },
          { operator: 'exists', path: 'facts.nil', value: false },
        ],
      },
      true,
    ],
    [
      {
        operator: 'any',
        conditions: [
          { operator: 'eq', path: 'facts.number', value: 9 },
          { operator: 'eq', path: 'facts.number', value: 10 },
        ],
      },
      true,
    ],
    [{ operator: 'not', condition: { operator: 'eq', path: 'facts.number', value: 9 } }, true],
  ])('evaluates %j', (condition, expected) =>
    expect(evaluateCondition(condition, context)).toBe(expected),
  );

  it('treats null and missing as absent and resolves safely', () => {
    expect(resolvePath(context, '__proto__.polluted')).toBeUndefined();
    expect(evaluateCondition({ operator: 'gte', path: 'facts.missing', value: 0 }, context)).toBe(
      false,
    );
    expect(evaluateCondition({ operator: 'exists', path: 'facts.nil', value: true }, context)).toBe(
      false,
    );
  });
});

describe('normalization and reconciliation', () => {
  it.each([
    ['€1.000.000,00', 1_000_000],
    ['EUR 2,000,000.00', 2_000_000],
    ['1.000', 1_000],
    ['1,000', 1_000],
    [1200, 1200],
    ['n/a', null],
  ])('normalizes %j', (value, expected) => expect(normalizeCurrency(value)).toBe(expected));

  it('preserves and flags conflicting identities', () => {
    const result = reconcileFacts(
      'supplier.legalName',
      [
        {
          path: 'register.legalName',
          value: 'MediSupply GmbH',
          confidence: 0.99,
          documentId: 'register',
        },
        {
          path: 'contract.partyName',
          value: 'MediSupply Europe GmbH',
          confidence: 0.94,
          documentId: 'contract',
        },
        {
          path: 'questionnaire.legalName',
          value: 'MediSupply GmbH.',
          confidence: 0.9,
          documentId: 'questionnaire',
        },
      ],
      'legal_name',
    );
    expect(result.selected?.documentId).toBe('register');
    expect(result.conflict).toBe(true);
    expect(result.alternatives).toHaveLength(2);
  });
});

describe('pharmacy supplier pack', () => {
  const context = {
    facts: {
      supplier: { distributesTemperatureControlled: true },
      insurance: { liabilityLimitEur: 1_000_000 },
      certificates: { iso13485: { validUntil: '2027-12-31' } },
      dpa: { signed: true },
    },
    reconciliation: { supplierLegalNameConflict: true },
  };

  it('produces stable rules and the intentionally missing GDP finding', () => {
    expect(evaluateRules(pharmacySupplierPack, context).map((item) => item.ruleId)).toEqual([
      'insurance-minimum',
      'legal-name-conflict',
    ]);
    expect(
      evaluateRequiredDocuments(
        pharmacySupplierPack,
        context,
        new Set(['commercial_register', 'insurance_certificate']),
      )[0],
    ).toMatchObject({ ruleId: 'required_document:gdp-for-cold-chain', severity: 'critical' });
  });

  it('handles the insurance boundary and decision precedence', () => {
    const passing = structuredClone(context);
    passing.facts.insurance.liabilityLimitEur = 2_000_000;
    expect(evaluateRules(pharmacySupplierPack, passing).map((item) => item.ruleId)).toEqual([
      'legal-name-conflict',
    ]);
    expect(
      mapDecision(pharmacySupplierPack, {
        summary: { requestInformation: true, reject: true, approvable: false },
      }),
    ).toBe('request_information');
    expect(
      mapDecision(pharmacySupplierPack, {
        summary: { requestInformation: false, reject: false, approvable: true },
      }),
    ).toBe('approve');
  });

  it('assigns every baseline rule to a declared policy collection', () => {
    const declared = new Set(pharmacySupplierPack.policyCollections.map((item) => item.id));
    expect(
      Object.fromEntries(pharmacySupplierPack.rules.map((rule) => [rule.id, rule.collectionId])),
    ).toEqual({
      'insurance-minimum': 'insurance',
      'legal-name-conflict': 'supplier-qualification',
      'iso-expired': 'supplier-qualification',
      'dpa-unsigned': 'data-protection',
    });
    for (const rule of pharmacySupplierPack.rules) {
      expect(declared.has(rule.collectionId!)).toBe(true);
    }
  });

  it('rejects malformed packs and duplicate or unknown references', () => {
    expect(() => parseDomainPack({ ...pharmacySupplierPack, schemaVersion: 2 })).toThrow();
    expect(() =>
      parseDomainPack({
        ...pharmacySupplierPack,
        requiredDocuments: [
          { ...pharmacySupplierPack.requiredDocuments[0], documentType: 'made_up' },
        ],
      }),
    ).toThrow('Unknown required document type');
    expect(() =>
      parseDomainPack({
        ...pharmacySupplierPack,
        rules: [pharmacySupplierPack.rules[0], pharmacySupplierPack.rules[0]],
      }),
    ).toThrow('Duplicate rule');
    expect(() =>
      parseDomainPack({
        ...pharmacySupplierPack,
        rules: [{ ...pharmacySupplierPack.rules[0], collectionId: 'made-up-collection' }],
      }),
    ).toThrow('Unknown rule collection: made-up-collection');
  });
});
