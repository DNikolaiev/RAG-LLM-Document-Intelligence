import type { DomainPack } from './domain-pack/schema.js';
import { parseDomainPack } from './domain-pack/schema.js';
import { pharmacySupplierPack } from './pharmacy-supplier.js';

function createReviewPack(input: {
  id: string;
  name: string;
  subject: string;
  documentType: string;
  documentLabel: string;
  fields: Array<{
    path: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'date' | 'currency' | 'list';
    aliases: string[];
  }>;
}): DomainPack {
  return parseDomainPack({
    schemaVersion: 1,
    id: input.id,
    version: '1.0.0',
    name: input.name,
    timezone: 'Europe/Berlin',
    terminology: { case: 'Review case', subject: input.subject, decision: 'Review decision' },
    thresholds: { extractionReview: 0.82, retrieval: 0.55 },
    documentTypes: [
      {
        id: input.documentType,
        label: input.documentLabel,
        description: `Primary evidence for ${input.name.toLocaleLowerCase()}`,
        extractionFields: input.fields.map((field) => ({ ...field, required: true })),
      },
    ],
    requiredDocuments: [
      {
        id: `${input.documentType}-required`,
        documentType: input.documentType,
        severity: 'critical',
        message: `${input.documentLabel} is required before a decision can be made.`,
      },
    ],
    reconciliation: [],
    policyCollections: [
      {
        id: `${input.id}-policy`,
        label: `${input.name} policy`,
        chunkSize: 700,
        overlap: 90,
      },
    ],
    rules: [],
    decisions: [
      {
        decision: 'request_information',
        when: { operator: 'eq', path: 'summary.requestInformation', value: true },
        priority: 100,
      },
      {
        decision: 'approve',
        when: { operator: 'eq', path: 'summary.approvable', value: true },
        priority: 50,
      },
    ],
    reviewerChecklist: [
      {
        id: 'confirm-evidence',
        label: `Confirm the extracted ${input.subject.toLowerCase()} evidence`,
      },
      { id: 'confirm-policy', label: 'Confirm the active policy version and exceptions' },
    ],
  });
}

export const legalContractPack = createReviewPack({
  id: 'commercial-contract-review',
  name: 'Commercial contract review',
  subject: 'Contract',
  documentType: 'commercial_contract',
  documentLabel: 'Commercial contract',
  fields: [
    { path: 'contract.parties', label: 'Contract parties', type: 'list', aliases: ['between'] },
    {
      path: 'contract.terminationNoticeDays',
      label: 'Termination notice days',
      type: 'number',
      aliases: ['notice period'],
    },
    {
      path: 'contract.governingLaw',
      label: 'Governing law',
      type: 'string',
      aliases: ['applicable law'],
    },
  ],
});

export const insuranceClaimsPack = createReviewPack({
  id: 'insurance-claims-assessment',
  name: 'Insurance claims assessment',
  subject: 'Claim',
  documentType: 'claim_evidence',
  documentLabel: 'Claim evidence package',
  fields: [
    { path: 'claim.policyNumber', label: 'Policy number', type: 'string', aliases: ['policy no'] },
    { path: 'claim.lossDate', label: 'Loss date', type: 'date', aliases: ['date of loss'] },
    {
      path: 'claim.estimatedCostEur',
      label: 'Estimated cost',
      type: 'currency',
      aliases: ['restoration cost', 'repair estimate'],
    },
  ],
});

export const manufacturingQualityPack = createReviewPack({
  id: 'supplier-quality-assurance',
  name: 'Supplier quality assurance',
  subject: 'Supplier batch',
  documentType: 'material_certificate',
  documentLabel: 'Material certificate',
  fields: [
    { path: 'material.batchNumber', label: 'Batch number', type: 'string', aliases: ['batch'] },
    { path: 'material.grade', label: 'Material grade', type: 'string', aliases: ['grade'] },
    { path: 'material.heatNumber', label: 'Heat number', type: 'string', aliases: ['heat no'] },
  ],
});

const domainPacks = new Map<string, DomainPack>([
  [pharmacySupplierPack.name.toLocaleLowerCase(), pharmacySupplierPack],
  [legalContractPack.name.toLocaleLowerCase(), legalContractPack],
  [insuranceClaimsPack.name.toLocaleLowerCase(), insuranceClaimsPack],
  [manufacturingQualityPack.name.toLocaleLowerCase(), manufacturingQualityPack],
]);

const persistedDomainPacks = new Map<string, DomainPack>([
  ['pack_tenant_demo', pharmacySupplierPack],
  ['pack_tenant_legal', legalContractPack],
  ['pack_tenant_insurance', insuranceClaimsPack],
  ['pack_tenant_manufacturing', manufacturingQualityPack],
  ...[...domainPacks.values()].map((pack) => [pack.id, pack] as const),
]);

export function resolveDomainPack(domain: string): DomainPack {
  return domainPacks.get(domain.trim().toLocaleLowerCase()) ?? pharmacySupplierPack;
}

export function resolvePersistedDomainPack(domainPackId: string): DomainPack | null {
  return persistedDomainPacks.get(domainPackId) ?? null;
}

const persistedPackAliases: Readonly<Record<string, string>> = {
  demo: 'pharmacy-supplier',
  legal: 'commercial-contract-review',
  insurance: 'insurance-claims-assessment',
  manufacturing: 'supplier-quality-assurance',
};

/**
 * Resolves the compiled fallback pack for a persisted `domain_packs.id`, tolerating the
 * `pack_<tenant>` and `pack_<tenant>_<major>_<minor>_<patch>` identifiers minted by the
 * persistence layer. Returns `null` when no compiled pack matches, so callers can decide
 * whether a missing pack is an error.
 */
export function resolveCompiledDomainPack(domainPackId: string): DomainPack | null {
  const withoutVersion = domainPackId.replace(/_\d+_\d+_\d+$/, '');
  const direct =
    resolvePersistedDomainPack(domainPackId) ?? resolvePersistedDomainPack(withoutVersion);
  if (direct) return direct;
  const key = withoutVersion.startsWith('pack_tenant_')
    ? withoutVersion.slice('pack_tenant_'.length).replaceAll('_', '-')
    : withoutVersion.replace(/^pack_/, '').replaceAll('_', '-');
  return resolvePersistedDomainPack(persistedPackAliases[key] ?? key);
}
