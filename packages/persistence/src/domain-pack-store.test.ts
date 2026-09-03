import { insuranceClaimsPack, legalContractPack, parseDomainPack } from '@caselens/domain';
import { describe, expect, it } from 'vitest';
import {
  FIELD_EMBEDDING_DIMENSIONS,
  canonicalPackDefinition,
  fieldEmbeddingFingerprint,
  isPersistedPackDefinition,
  nextMinorVersion,
  packVersionRowId,
  resolvePackDefinition,
  toEmbeddingLiteral,
} from './domain-pack-store.js';

describe('persisted pack definition resolution', () => {
  it('round-trips a persisted definition through parseDomainPack', () => {
    const stored = JSON.parse(JSON.stringify(legalContractPack)) as unknown;
    const resolved = resolvePackDefinition('pack_tenant_legal', stored);
    expect(resolved).toEqual(parseDomainPack(legalContractPack));
    expect(resolved?.documentTypes[0]?.extractionFields.map((field) => field.path)).toEqual([
      'contract.parties',
      'contract.terminationNoticeDays',
      'contract.governingLaw',
    ]);
  });

  it('falls back to the compiled catalog when a tenant has no persisted definition', () => {
    expect(resolvePackDefinition('pack_tenant_insurance', null)).toBe(insuranceClaimsPack);
    expect(resolvePackDefinition('pack_tenant_insurance', undefined)).toBe(insuranceClaimsPack);
  });

  it('treats the pre-dictionary { name } stub as an absent definition', () => {
    expect(isPersistedPackDefinition({ name: 'Insurance claims assessment' })).toBe(false);
    expect(
      resolvePackDefinition('pack_tenant_insurance', { name: 'Insurance claims assessment' }),
    ).toBe(insuranceClaimsPack);
  });

  it('resolves a minted version row id back to its compiled fallback', () => {
    expect(resolvePackDefinition('pack_tenant_legal_1_1_0', null)).toBe(legalContractPack);
  });

  it('returns null when neither a persisted nor a compiled pack exists', () => {
    expect(resolvePackDefinition('pack_tenant_unknown_domain', null)).toBeNull();
  });

  it('fails loudly instead of degrading when a stored definition is malformed', () => {
    expect(() =>
      resolvePackDefinition('pack_tenant_legal', { schemaVersion: 1, id: 'broken' }),
    ).toThrow('DOMAIN_PACK_DEFINITION_INVALID:pack_tenant_legal');
    expect(() =>
      resolvePackDefinition('pack_tenant_legal', {
        ...JSON.parse(JSON.stringify(legalContractPack)),
        documentTypes: [],
      }),
    ).toThrow('DOMAIN_PACK_DEFINITION_INVALID:pack_tenant_legal');
  });
});

describe('pack version minting helpers', () => {
  it('bumps the semver minor', () => {
    expect(nextMinorVersion('1.0.0')).toBe('1.1.0');
    expect(nextMinorVersion('2.9.3')).toBe('2.10.0');
    expect(() => nextMinorVersion('1.0')).toThrow('INVALID_SEMANTIC_VERSION:1.0');
  });

  it('derives a deterministic, retry-stable row id per version', () => {
    expect(packVersionRowId('pack_tenant_demo', '1.1.0')).toBe('pack_tenant_demo_1_1_0');
    expect(packVersionRowId('pack_tenant_demo_1_1_0', '1.2.0')).toBe('pack_tenant_demo_1_2_0');
    expect(packVersionRowId('pack_tenant_demo', '1.1.0')).toBe(
      packVersionRowId('pack_tenant_demo', '1.1.0'),
    );
  });

  it('canonicalizes definitions so a retry is distinguishable from a conflicting write', () => {
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(legalContractPack).reverse())),
    ) as typeof legalContractPack;
    expect(canonicalPackDefinition(reordered)).toBe(canonicalPackDefinition(legalContractPack));
    expect(canonicalPackDefinition(insuranceClaimsPack)).not.toBe(
      canonicalPackDefinition(legalContractPack),
    );
  });
});

describe('field embedding guard', () => {
  it('rejects an absent embedding, because every dictionary row carries one', () => {
    expect(() => toEmbeddingLiteral([], 'query')).toThrow('EMBEDDING_DIMENSION_MISMATCH:query:0');
  });

  it('serializes a full-width embedding', () => {
    const embedding = Array.from({ length: FIELD_EMBEDDING_DIMENSIONS }, () => 0.5);
    expect(toEmbeddingLiteral(embedding, 'query')).toBe(JSON.stringify(embedding));
  });

  it('rejects a wrong-width or non-finite embedding', () => {
    expect(() => toEmbeddingLiteral([0.1, 0.2], 'query')).toThrow(
      'EMBEDDING_DIMENSION_MISMATCH:query:2',
    );
    expect(() =>
      toEmbeddingLiteral(
        Array.from({ length: FIELD_EMBEDDING_DIMENSIONS }, (_, index) =>
          index === 3 ? Number.NaN : 0.1,
        ),
        'field_1',
      ),
    ).toThrow('EMBEDDING_NOT_FINITE:field_1');
  });
});

describe('field embedding fingerprint', () => {
  it('ignores alias order, so a pack rewrite alone never forces a re-embedding', () => {
    expect(fieldEmbeddingFingerprint('Liability limit', ['coverage', 'cover'])).toBe(
      fieldEmbeddingFingerprint('Liability limit', ['cover', 'coverage']),
    );
    expect(fieldEmbeddingFingerprint('Liability limit', ['coverage', ' cover '])).toBe(
      fieldEmbeddingFingerprint('Liability limit', ['cover', 'coverage']),
    );
  });

  it('changes when the wording changes, so the field is embedded again', () => {
    const base = fieldEmbeddingFingerprint('Liability limit', ['coverage', 'cover']);
    expect(fieldEmbeddingFingerprint('Liability limit', ['coverage'])).not.toBe(base);
    expect(
      fieldEmbeddingFingerprint('Liability limit', ['coverage', 'cover', 'sum insured']),
    ).not.toBe(base);
    expect(fieldEmbeddingFingerprint('Liability ceiling', ['coverage', 'cover'])).not.toBe(base);
  });
});
