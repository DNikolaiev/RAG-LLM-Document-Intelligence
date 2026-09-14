import type { DomainPack } from './domain-pack/schema.js';
import { parseDomainPack } from './domain-pack/schema.js';
import { pharmacySupplierPack } from './pharmacy-supplier.js';

/**
 * The review packs shipped one placeholder collection each - `<pack id>-policy`, a name derived from
 * the pack rather than a category - until 1.1.0 gave them real starting collections. Each
 * placeholder id is kept and relabelled, not renamed: policies already filed under it reference it,
 * and a collection id is permanent once a policy uses it.
 *
 * Any change here is a new version. The seed applies a newer catalog version to tenants still on the
 * catalog's line and refuses a changed pack that kept its old version, because cases pinned to that
 * version would silently change vocabulary.
 */
function createReviewPack(input: {
  id: string;
  version: string;
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
  policyCollections: DomainPack['policyCollections'];
}): DomainPack {
  return parseDomainPack({
    schemaVersion: 1,
    id: input.id,
    version: input.version,
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
    policyCollections: input.policyCollections,
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
  version: '1.1.0',
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
  policyCollections: [
    {
      id: 'commercial-contract-review-policy',
      label: 'Contracting Standards',
      description:
        'The general contracting playbook: who may sign, the clauses every contract needs, and approved fallback positions.',
      chunkSize: 700,
      overlap: 90,
    },
    {
      id: 'liability-indemnity',
      label: 'Liability and Indemnity',
      description:
        'Limits of liability, the scope of indemnities, and the insurance that must back contractual risk.',
      chunkSize: 500,
      overlap: 70,
    },
    {
      id: 'data-protection-terms',
      label: 'Data Protection Terms',
      description:
        'Terms for contracts that process personal data: processing agreements, sub-processors, transfers and breach notice.',
      chunkSize: 500,
      overlap: 70,
    },
    {
      id: 'term-termination',
      label: 'Term and Termination',
      description:
        'Contract duration, renewal and notice periods, termination rights, and where disputes are heard.',
      chunkSize: 500,
      overlap: 70,
    },
  ],
});

export const insuranceClaimsPack = createReviewPack({
  id: 'insurance-claims-assessment',
  version: '1.1.0',
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
  policyCollections: [
    {
      id: 'insurance-claims-assessment-policy',
      label: 'Claims Handling Standards',
      description:
        'How claims are notified, registered, evidenced, reserved and closed, including reporting deadlines.',
      chunkSize: 700,
      overlap: 90,
    },
    {
      id: 'coverage-exclusions',
      label: 'Coverage and Exclusions',
      description:
        'What a policy covers and excludes, waiting periods and deductibles, and how disputed wording is read.',
      chunkSize: 500,
      overlap: 70,
    },
    {
      id: 'fraud-indicators',
      label: 'Fraud Indicators',
      description: 'Red flags that send a claim to special investigation before anything is paid.',
      chunkSize: 500,
      overlap: 70,
    },
    {
      id: 'settlement-authority',
      label: 'Settlement Authority',
      description:
        'Who may approve a settlement at which value, and the evidence each approval level requires.',
      chunkSize: 500,
      overlap: 70,
    },
  ],
});

export const manufacturingQualityPack = createReviewPack({
  id: 'supplier-quality-assurance',
  version: '1.1.0',
  name: 'Supplier quality assurance',
  subject: 'Supplier batch',
  documentType: 'material_certificate',
  documentLabel: 'Material certificate',
  fields: [
    { path: 'material.batchNumber', label: 'Batch number', type: 'string', aliases: ['batch'] },
    { path: 'material.grade', label: 'Material grade', type: 'string', aliases: ['grade'] },
    { path: 'material.heatNumber', label: 'Heat number', type: 'string', aliases: ['heat no'] },
  ],
  policyCollections: [
    {
      id: 'supplier-quality-assurance-policy',
      label: 'Supplier Quality Manual',
      description:
        'The quality-system expectations every approved supplier must meet, and how approval is kept.',
      chunkSize: 700,
      overlap: 90,
    },
    {
      id: 'material-specifications',
      label: 'Material Specifications',
      description:
        'Approved material grades, required mechanical properties, and the certificates each batch must carry.',
      chunkSize: 500,
      overlap: 70,
    },
    {
      id: 'certification-audit',
      label: 'Certification and Audit',
      description:
        'Certifications a supplier must hold, such as ISO 9001 or IATF 16949, and how often it is audited.',
      chunkSize: 500,
      overlap: 70,
    },
    {
      id: 'nonconformance-corrective-action',
      label: 'Nonconformance and Corrective Action',
      description:
        'How defects are reported, contained and corrected, and when a supplier is escalated or suspended.',
      chunkSize: 500,
      overlap: 70,
    },
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
