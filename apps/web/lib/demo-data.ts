import { cache } from 'react';
import { cookies } from 'next/headers';
import { DEFAULT_TEST_PROFILE_ID } from '@caselens/contracts';
import { PROFILE_COOKIE, testProfilesEnabled } from './session-profile';

export type CaseStatus = 'review_needed' | 'processing' | 'ready_for_decision' | 'approved';

export type Severity = 'critical' | 'major' | 'minor' | 'clear';

export interface CaseSummary {
  id: string;
  tenantId: string;
  tenantName: string;
  reference: string;
  supplier: string;
  subtitle: string;
  domain: string;
  status: CaseStatus;
  openFindings: number;
  documents: number;
  progress: number;
  updatedAt: string;
  assignee: string;
}

export interface CaseDocument {
  id: string;
  label: string;
  fileName: string;
  state: 'verified' | 'warning' | 'missing' | 'processing';
  pages: number;
  kind: string;
  sourceUrl?: string;
}

export interface EvidenceAnchor {
  id: string;
  index: number;
  documentId: string;
  page: number;
  label: string;
  excerpt: string;
  severity: Severity;
}

export interface Finding {
  id: string;
  severity: Exclude<Severity, 'clear'>;
  title: string;
  detail: string;
  action: string;
  evidenceIds: string[];
  policy: string;
  state: 'open' | 'accepted' | 'resolved';
  version?: number;
}

export interface Fact {
  id: string;
  label: string;
  value: string;
  confidence: number;
  evidenceId: string;
  state: 'confirmed' | 'conflict' | 'review';
  version?: number;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface CaseContact {
  name?: string;
  role?: string;
  email?: string;
}

export interface CaseDetail extends CaseSummary {
  recommendation: 'request_information' | 'approve' | 'reject';
  recommendationReason: string;
  domainPack: string;
  documentsList: CaseDocument[];
  evidence: EvidenceAnchor[];
  findings: Finding[];
  facts: Fact[];
  audit: AuditEvent[];
  contact?: CaseContact;
  version?: number;
}

export const statusLabels: Record<CaseStatus, string> = {
  review_needed: 'Review needed',
  processing: 'Processing',
  ready_for_decision: 'Ready for decision',
  approved: 'Approved',
};

const cases: CaseSummary[] = [
  {
    id: 'case_01J5M8P2X4Y6Z7A8B9C0D1E2F3',
    tenantId: 'tenant_demo',
    tenantName: 'Düsseldorf Health Operations',
    reference: 'SUP-2026-0142',
    supplier: 'MediSupply GmbH',
    subtitle: 'Temperature-controlled medicine distributor',
    domain: 'Pharmacy supplier qualification',
    status: 'review_needed',
    openFindings: 3,
    documents: 8,
    progress: 86,
    updatedAt: '26 Aug, 09:42',
    assignee: 'D. Nikolaiev',
  },
  {
    id: 'case_01J5M8P2X4Y6Z7A8B9C0D1E2F4',
    tenantId: 'tenant_demo',
    tenantName: 'Düsseldorf Health Operations',
    reference: 'SUP-2026-0141',
    supplier: 'Nordlicht Lab Services AG',
    subtitle: 'Clinical packaging and labelling',
    domain: 'Pharmacy supplier qualification',
    status: 'ready_for_decision',
    openFindings: 0,
    documents: 11,
    progress: 100,
    updatedAt: '25 Aug, 17:08',
    assignee: 'A. Weber',
  },
  {
    id: 'case_01J5M8P2X4Y6Z7A8B9C0D1E2F5',
    tenantId: 'tenant_demo',
    tenantName: 'Düsseldorf Health Operations',
    reference: 'SUP-2026-0140',
    supplier: 'CuraLogistik B.V.',
    subtitle: 'Cross-border cold-chain logistics',
    domain: 'Pharmacy supplier qualification',
    status: 'processing',
    openFindings: 0,
    documents: 14,
    progress: 43,
    updatedAt: '25 Aug, 15:26',
    assignee: 'Unassigned',
  },
  {
    id: 'case_01J5M8P2X4Y6Z7A8B9C0D1E2F6',
    tenantId: 'tenant_demo',
    tenantName: 'Düsseldorf Health Operations',
    reference: 'SUP-2026-0137',
    supplier: 'AlpenMed Verpackung KG',
    subtitle: 'Secondary pharmaceutical packaging',
    domain: 'Pharmacy supplier qualification',
    status: 'approved',
    openFindings: 0,
    documents: 9,
    progress: 100,
    updatedAt: '23 Aug, 11:12',
    assignee: 'D. Nikolaiev',
  },
];

const medSupplyDetail: CaseDetail = {
  ...cases[0]!,
  recommendation: 'request_information',
  recommendationReason:
    'One required certificate is absent and two supplied facts do not satisfy the current qualification policy.',
  domainPack: 'pharmacy-supplier · v1.2.0',
  contact: {
    name: 'Dr. Klara Rehm',
    role: 'Quality and Compliance',
    email: 'klara.rehm@medisupply.example',
  },
  documentsList: [
    {
      id: 'questionnaire',
      label: 'Supplier questionnaire',
      fileName: 'medisupply-questionnaire.pdf',
      state: 'verified',
      pages: 5,
      kind: 'Questionnaire',
      sourceUrl: '/demo-documents/01_supplier_questionnaire.pdf',
    },
    {
      id: 'register',
      label: 'Commercial register',
      fileName: 'commercial-register-extract.pdf',
      state: 'verified',
      pages: 3,
      kind: 'Legal identity',
      sourceUrl: '/demo-documents/02_commercial_register_extract.pdf',
    },
    {
      id: 'iso',
      label: 'ISO 13485 certificate',
      fileName: 'iso-13485-certificate.pdf',
      state: 'verified',
      pages: 2,
      kind: 'Certification',
      sourceUrl: '/demo-documents/03_iso_13485_certificate.pdf',
    },
    {
      id: 'insurance',
      label: 'Liability insurance',
      fileName: 'insurance-certificate.pdf',
      state: 'warning',
      pages: 2,
      kind: 'Insurance',
      sourceUrl: '/demo-documents/04_insurance_certificate.pdf',
    },
    {
      id: 'dpa',
      label: 'Data processing agreement',
      fileName: 'data-processing-agreement.pdf',
      state: 'verified',
      pages: 8,
      kind: 'Agreement',
      sourceUrl: '/demo-documents/05_data_processing_agreement.pdf',
    },
    {
      id: 'contract',
      label: 'Supply contract',
      fileName: 'supply-contract.pdf',
      state: 'warning',
      pages: 12,
      kind: 'Contract',
      sourceUrl: '/demo-documents/06_supply_contract.pdf',
    },
    {
      id: 'gdp',
      label: 'GDP certificate',
      fileName: 'Not supplied',
      state: 'missing',
      pages: 0,
      kind: 'Required certification',
    },
  ],
  evidence: [
    {
      id: 'ev-gdp',
      index: 1,
      documentId: 'questionnaire',
      page: 4,
      label: 'GDP evidence not attached',
      excerpt:
        'Good Distribution Practice certificate: pending renewal. Supporting document will be provided separately.',
      severity: 'critical',
    },
    {
      id: 'ev-insurance',
      index: 2,
      documentId: 'insurance',
      page: 1,
      label: 'Coverage limit',
      excerpt:
        'Public and product liability: EUR 1,000,000 per occurrence and EUR 2,000,000 aggregate.',
      severity: 'major',
    },
    {
      id: 'ev-register-name',
      index: 3,
      documentId: 'register',
      page: 1,
      label: 'Registered legal name',
      excerpt: 'Firma: MediSupply GmbH · Amtsgericht Düsseldorf · HRB 92831',
      severity: 'major',
    },
    {
      id: 'ev-contract-name',
      index: 4,
      documentId: 'contract',
      page: 1,
      label: 'Contracting party',
      excerpt: 'This Supply Agreement is entered into by MediSupply Europe GmbH (‘Supplier’).',
      severity: 'major',
    },
    {
      id: 'ev-iso',
      index: 5,
      documentId: 'iso',
      page: 1,
      label: 'Certificate validity',
      excerpt: 'ISO 13485:2016 · Certificate valid until 18 November 2027.',
      severity: 'clear',
    },
  ],
  findings: [
    {
      id: 'finding-gdp',
      severity: 'critical',
      title: 'GDP certificate is missing',
      detail: 'A current GDP certificate is mandatory for suppliers handling medicinal products.',
      action: 'Request GDP certificate',
      evidenceIds: ['ev-gdp'],
      policy: 'GDP-POL-04 §2.1',
      state: 'open',
    },
    {
      id: 'finding-insurance',
      severity: 'major',
      title: 'Liability cover is €1m below policy',
      detail:
        'The supplied per-occurrence limit is €1,000,000. Policy requires at least €2,000,000.',
      action: 'Request revised insurance evidence',
      evidenceIds: ['ev-insurance'],
      policy: 'RISK-POL-11 §4.3',
      state: 'open',
    },
    {
      id: 'finding-name',
      severity: 'major',
      title: 'Legal name conflicts across documents',
      detail:
        'The register names MediSupply GmbH, while the contract names MediSupply Europe GmbH.',
      action: 'Confirm contracting entity',
      evidenceIds: ['ev-register-name', 'ev-contract-name'],
      policy: 'SUP-POL-02 §3.2',
      state: 'open',
    },
  ],
  facts: [
    {
      id: 'legal-name',
      label: 'Registered legal name',
      value: 'MediSupply GmbH',
      confidence: 0.99,
      evidenceId: 'ev-register-name',
      state: 'conflict',
    },
    {
      id: 'contract-party',
      label: 'Contracting party',
      value: 'MediSupply Europe GmbH',
      confidence: 0.98,
      evidenceId: 'ev-contract-name',
      state: 'conflict',
    },
    {
      id: 'liability-limit',
      label: 'Liability limit',
      value: '€1,000,000 / occurrence',
      confidence: 0.97,
      evidenceId: 'ev-insurance',
      state: 'review',
    },
    {
      id: 'iso-valid-until',
      label: 'ISO 13485 valid until',
      value: '18 Nov 2027',
      confidence: 0.99,
      evidenceId: 'ev-iso',
      state: 'confirmed',
    },
    {
      id: 'registration-number',
      label: 'Commercial register',
      value: 'HRB 92831',
      confidence: 0.99,
      evidenceId: 'ev-register-name',
      state: 'confirmed',
    },
  ],
  audit: [
    {
      id: 'audit-4',
      at: '26 Aug 2026 · 09:42',
      actor: 'CaseLens rules',
      action: 'Recommendation updated',
      detail: 'Request information · 1 critical and 2 major findings',
    },
    {
      id: 'audit-3',
      at: '26 Aug 2026 · 09:41',
      actor: 'Extraction worker',
      action: 'Evidence reconciliation completed',
      detail: '5 material facts retained · 1 identity conflict found',
    },
    {
      id: 'audit-2',
      at: '26 Aug 2026 · 09:39',
      actor: 'Extraction worker',
      action: 'Documents processed',
      detail: '6 PDFs · 32 pages · OCR used on 2 pages',
    },
    {
      id: 'audit-1',
      at: '26 Aug 2026 · 09:31',
      actor: 'D. Nikolaiev',
      action: 'Case created',
      detail: 'Pharmacy supplier qualification · pack v1.2.0',
    },
  ],
};

const demoDetails: Record<string, CaseDetail> = {
  [medSupplyDetail.id]: medSupplyDetail,
};

interface ApiCaseSummary {
  id: string;
  tenantId?: string;
  tenantName?: string;
  reference: string;
  subjectName: string;
  domain: string;
  status: string;
  progress: number;
  documentCount: number;
  updatedAt: string;
  assignedTo: string;
  findingCounts?: Record<string, number>;
}

interface ApiCaseDetail extends ApiCaseSummary {
  version: number;
  domainPackVersion: string;
  recommendation: 'request_information' | 'approve' | 'reject' | null;
  contact?: CaseContact;
  documents: Array<{
    id: string;
    name: string;
    type: string;
    status: 'ready' | 'missing' | 'needs_review';
    pages: number;
    fileName?: string;
  }>;
  facts: Array<{
    id: string;
    label: string;
    value: string | number | boolean | null;
    confidence: number;
    reviewStatus: 'confirmed' | 'needs_review' | 'corrected';
    documentId: string;
    page: number;
    quote: string;
    version: number;
  }>;
  findings: Array<{
    id: string;
    ruleKey: string;
    severity: 'critical' | 'major' | 'minor';
    status: 'open' | 'accepted' | 'dismissed' | 'resolved';
    title: string;
    description: string;
    remediation: string;
    version: number;
    evidence?: { documentId: string; page: number; quote: string };
  }>;
  audit: Array<{ id: string; at: string; actor: string; action: string; detail: string }>;
}

function mapStatus(status: string): CaseStatus {
  if (status === 'processing') return 'processing';
  if (status === 'approved') return 'approved';
  if (status === 'ready_for_decision') return 'ready_for_decision';
  return 'review_needed';
}

function compactDocumentId(id: string): string {
  return id.replace(/^doc_/, '');
}

function mapApiSummary(item: ApiCaseSummary): CaseSummary {
  const openFindings = Object.values(item.findingCounts ?? {}).reduce(
    (total, count) => total + count,
    0,
  );
  return {
    id: item.id,
    tenantId: item.tenantId ?? 'tenant_demo',
    tenantName: item.tenantName ?? 'Düsseldorf Health Operations',
    reference: item.reference,
    supplier: item.subjectName,
    subtitle:
      item.subjectName === 'MediSupply GmbH'
        ? 'Temperature-controlled medicine distributor'
        : item.domain,
    domain: item.domain,
    status: mapStatus(item.status),
    openFindings,
    documents: item.documentCount,
    progress: item.progress,
    updatedAt: new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Berlin',
    }).format(new Date(item.updatedAt)),
    assignee: item.assignedTo,
  };
}

function mapApiDetail(item: ApiCaseDetail): CaseDetail {
  const summary = mapApiSummary({
    ...item,
    findingCounts: item.findings
      .filter((finding) => finding.status === 'open')
      .reduce<Record<string, number>>((counts, finding) => {
        counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
        return counts;
      }, {}),
  });
  const evidence: EvidenceAnchor[] = item.facts.map((fact, index) => ({
    id: `fact-${fact.id}`,
    index: index + 1,
    documentId: compactDocumentId(fact.documentId),
    page: fact.page,
    label: fact.label,
    excerpt: fact.quote,
    severity: fact.reviewStatus === 'needs_review' ? 'major' : 'clear',
  }));

  for (const finding of item.findings) {
    if (!finding.evidence) continue;
    const duplicate = evidence.find(
      (anchor) =>
        anchor.documentId === compactDocumentId(finding.evidence!.documentId) &&
        anchor.page === finding.evidence!.page &&
        anchor.excerpt === finding.evidence!.quote,
    );
    if (!duplicate) {
      evidence.push({
        id: `finding-${finding.id}`,
        index: evidence.length + 1,
        documentId: compactDocumentId(finding.evidence.documentId),
        page: finding.evidence.page,
        label: finding.title,
        excerpt: finding.evidence.quote,
        severity: finding.severity,
      });
    }
  }

  const gdpFinding = item.findings.find((finding) => finding.ruleKey.includes('gdp'));
  if (gdpFinding) {
    evidence.unshift({
      id: 'gdp-missing',
      index: 1,
      documentId: 'gdp',
      page: 0,
      label: 'Required GDP evidence absent',
      excerpt: gdpFinding.description,
      severity: 'critical',
    });
    evidence.forEach((anchor, index) => {
      anchor.index = index + 1;
    });
  }

  return {
    ...summary,
    version: item.version,
    recommendation: item.recommendation ?? 'request_information',
    recommendationReason:
      item.recommendation === 'approve'
        ? 'All deterministic policy gates are satisfied and no material exception remains.'
        : `${item.findings.filter((finding) => finding.status === 'open').length} open finding(s) require human review before a final decision.`,
    domainPack: `${item.domain} · v${item.domainPackVersion}`,
    ...(item.contact ? { contact: item.contact } : {}),
    documentsList: item.documents.map((document) => ({
      id: compactDocumentId(document.id),
      label: document.name,
      fileName: document.fileName ?? 'Not supplied',
      state:
        document.status === 'ready'
          ? 'verified'
          : document.status === 'missing'
            ? 'missing'
            : 'warning',
      pages: document.pages,
      kind: document.type.replaceAll('_', ' '),
      sourceUrl:
        process.env.APP_MODE === 'demo'
          ? (demoSourceUrl(compactDocumentId(document.id)) ??
            `/api/cases/${encodeURIComponent(item.id)}/documents/${encodeURIComponent(document.id)}/content`)
          : `/api/cases/${encodeURIComponent(item.id)}/documents/${encodeURIComponent(document.id)}/content`,
    })),
    evidence,
    findings: item.findings.map((finding) => {
      const matching = finding.evidence
        ? evidence.find(
            (anchor) =>
              anchor.documentId === compactDocumentId(finding.evidence!.documentId) &&
              anchor.page === finding.evidence!.page,
          )
        : evidence.find((anchor) => anchor.id === 'gdp-missing');
      return {
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
        detail: finding.description,
        action: finding.remediation,
        evidenceIds: matching ? [matching.id] : [],
        policy: finding.ruleKey,
        state:
          finding.status === 'resolved'
            ? 'resolved'
            : finding.status === 'open'
              ? 'open'
              : 'accepted',
        version: finding.version,
      };
    }),
    facts: item.facts.map((fact) => ({
      id: fact.id,
      label: fact.label,
      value: fact.value === null ? 'Not extracted' : String(fact.value),
      confidence: fact.confidence,
      evidenceId: `fact-${fact.id}`,
      state:
        fact.reviewStatus === 'needs_review'
          ? 'conflict'
          : fact.reviewStatus === 'corrected'
            ? 'confirmed'
            : 'confirmed',
      version: fact.version,
    })),
    audit: item.audit.map((event) => ({
      ...event,
      at: new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Europe/Berlin',
      }).format(new Date(event.at)),
    })),
  };
}

function demoSourceUrl(documentId: string): string | undefined {
  const fixtureByDocument: Record<string, string> = {
    questionnaire: '01_supplier_questionnaire.pdf',
    register: '02_commercial_register_extract.pdf',
    iso: '03_iso_13485_certificate.pdf',
    insurance: '04_insurance_certificate.pdf',
    dpa: '05_data_processing_agreement.pdf',
    contract: '06_supply_contract.pdf',
    catalog: '11_multilingual_product_catalog.pdf',
    delivery: '12_rotated_low_contrast_delivery_note.pdf',
  };
  const fixture = fixtureByDocument[documentId];
  return fixture ? `/demo-documents/${encodeURIComponent(fixture)}` : undefined;
}

async function apiGet<T>(path: string): Promise<T | null> {
  if (process.env.NODE_ENV === 'test') return null;
  const baseUrl = process.env.PUBLIC_API_URL ?? 'http://localhost:4100';
  const store = await cookies();
  const profileId = store.get(PROFILE_COOKIE)?.value ?? DEFAULT_TEST_PROFILE_ID;
  try {
    const response = await fetch(new URL(path, baseUrl), {
      cache: 'no-store',
      headers: testProfilesEnabled() ? { 'x-test-profile-id': profileId } : {},
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

const demoFallbackEnabled = (process.env.APP_MODE ?? 'demo') === 'demo';

export const listCases = cache(async (): Promise<CaseSummary[]> => {
  const response = await apiGet<{ items: ApiCaseSummary[] }>('/v1/cases?limit=100');
  if (response) return response.items.map(mapApiSummary);
  if (demoFallbackEnabled) return cases;
  throw new Error('The CaseLens API is unavailable.');
});

export const getCase = cache(async (id: string): Promise<CaseDetail | null> => {
  const response = await apiGet<ApiCaseDetail>(`/v1/cases/${encodeURIComponent(id)}`);
  if (response) return mapApiDetail(response);
  if (demoFallbackEnabled) return demoDetails[id] ?? null;
  throw new Error('The CaseLens API is unavailable.');
});

export function filterCases(
  input: CaseSummary[],
  query: string,
  status: CaseStatus | 'all',
): CaseSummary[] {
  const term = query.trim().toLocaleLowerCase('en');

  return input.filter((item) => {
    const hasStatus = status === 'all' || item.status === status;
    const hasTerm =
      term.length === 0 ||
      `${item.supplier} ${item.reference} ${item.subtitle}`.toLocaleLowerCase('en').includes(term);

    return hasStatus && hasTerm;
  });
}

export function countByStatus(input: CaseSummary[]): Record<CaseStatus, number> {
  return input.reduce<Record<CaseStatus, number>>(
    (counts, item) => {
      counts[item.status] += 1;
      return counts;
    },
    { review_needed: 0, processing: 0, ready_for_decision: 0, approved: 0 },
  );
}
