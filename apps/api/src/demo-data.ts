export type Severity = 'critical' | 'major' | 'minor';
export type CaseStatus =
  'processing' | 'needs_review' | 'request_information' | 'approved' | 'rejected';

export interface DemoDocument {
  id: string;
  name: string;
  type: string;
  status: 'ready' | 'missing' | 'needs_review';
  pages: number;
  confidence: number | null;
  fileName?: string;
  warning?: string;
}

export interface DemoFact {
  id: string;
  label: string;
  path: string;
  value: string | number | boolean | null;
  rawValue: string | number | boolean | null;
  confidence: number;
  reviewStatus: 'confirmed' | 'needs_review' | 'corrected';
  documentId: string;
  page: number;
  quote: string;
  version: number;
  correctionReason?: string;
}

export interface DemoFinding {
  id: string;
  ruleKey: string;
  severity: Severity;
  status: 'open' | 'accepted' | 'dismissed' | 'resolved';
  title: string;
  description: string;
  remediation: string;
  evidence?: { documentId: string; page: number; quote: string };
  version: number;
}

export interface DemoCase {
  id: string;
  tenantId: string;
  reference: string;
  subjectName: string;
  domain: string;
  domainPackVersion: string;
  status: CaseStatus;
  recommendation: 'request_information' | 'approve' | 'reject' | null;
  progress: number;
  createdAt: string;
  updatedAt: string;
  dueAt: string;
  assignedTo: string;
  version: number;
  documents: DemoDocument[];
  facts: DemoFact[];
  findings: DemoFinding[];
  audit: Array<{ id: string; at: string; actor: string; action: string; detail: string }>;
  decision: null | { outcome: string; reason: string; decidedAt: string; actor: string };
}

const now = '2026-08-26T06:32:00.000Z';

export function createDemoCases(): DemoCase[] {
  return [
    {
      id: 'case_01J67X4Q7B5E6QG4S9CY0F7R2K',
      tenantId: 'tenant_demo',
      reference: 'SUP-2026-0142',
      subjectName: 'MediSupply GmbH',
      domain: 'Pharmacy supplier qualification',
      domainPackVersion: '1.0.0',
      status: 'needs_review',
      recommendation: 'request_information',
      progress: 100,
      createdAt: '2026-08-25T09:10:00.000Z',
      updatedAt: now,
      dueAt: '2026-08-29T16:00:00.000Z',
      assignedTo: 'Dmytro Nikolaiev',
      version: 3,
      documents: [
        {
          id: 'doc_questionnaire',
          name: 'Supplier questionnaire',
          type: 'supplier_questionnaire',
          status: 'ready',
          pages: 4,
          confidence: 0.98,
          fileName: 'supplier-questionnaire.pdf',
        },
        {
          id: 'doc_register',
          name: 'Commercial register extract',
          type: 'commercial_register',
          status: 'ready',
          pages: 2,
          confidence: 0.99,
          fileName: 'commercial-register-extract.pdf',
        },
        {
          id: 'doc_iso',
          name: 'ISO 13485 certificate',
          type: 'iso_certificate',
          status: 'ready',
          pages: 1,
          confidence: 0.97,
          fileName: 'iso-13485-certificate.pdf',
        },
        {
          id: 'doc_insurance',
          name: 'Liability insurance',
          type: 'insurance_certificate',
          status: 'needs_review',
          pages: 2,
          confidence: 0.91,
          fileName: 'insurance-certificate.pdf',
          warning: 'Coverage is below policy requirement.',
        },
        {
          id: 'doc_dpa',
          name: 'Data processing agreement',
          type: 'data_processing_agreement',
          status: 'ready',
          pages: 5,
          confidence: 0.96,
          fileName: 'data-processing-agreement.pdf',
        },
        {
          id: 'doc_contract',
          name: 'Supply contract',
          type: 'supply_contract',
          status: 'needs_review',
          pages: 6,
          confidence: 0.94,
          fileName: 'supply-contract.pdf',
          warning: 'Contract party conflicts with the register.',
        },
        {
          id: 'doc_gdp',
          name: 'GDP certificate',
          type: 'gdp_certificate',
          status: 'missing',
          pages: 0,
          confidence: null,
        },
      ],
      facts: [
        {
          id: 'fact_legal_name',
          label: 'Registered legal name',
          path: 'supplier.legalName',
          value: 'MediSupply GmbH',
          rawValue: 'MediSupply GmbH',
          confidence: 0.99,
          reviewStatus: 'confirmed',
          documentId: 'doc_register',
          page: 1,
          quote: 'Firma: MediSupply GmbH, Düsseldorf',
          version: 1,
        },
        {
          id: 'fact_contract_party',
          label: 'Contract party',
          path: 'contract.partyName',
          value: 'MediSupply Europe GmbH',
          rawValue: 'MediSupply Europe GmbH',
          confidence: 0.96,
          reviewStatus: 'needs_review',
          documentId: 'doc_contract',
          page: 1,
          quote: 'between RedCare Pharmacy N.V. and MediSupply Europe GmbH',
          version: 1,
        },
        {
          id: 'fact_insurance',
          label: 'Liability coverage',
          path: 'insurance.liabilityLimitEur',
          value: 1000000,
          rawValue: 'EUR 1,000,000',
          confidence: 0.97,
          reviewStatus: 'confirmed',
          documentId: 'doc_insurance',
          page: 1,
          quote: 'General product liability limit: EUR 1,000,000 per occurrence',
          version: 1,
        },
        {
          id: 'fact_iso_expiry',
          label: 'ISO 13485 valid until',
          path: 'certifications.iso13485.validUntil',
          value: '2027-04-30',
          rawValue: '30 April 2027',
          confidence: 0.98,
          reviewStatus: 'confirmed',
          documentId: 'doc_iso',
          page: 1,
          quote: 'Valid until: 30 April 2027',
          version: 1,
        },
        {
          id: 'fact_dpa_signed',
          label: 'DPA signed',
          path: 'privacy.dpaSigned',
          value: true,
          rawValue: 'Signed electronically',
          confidence: 0.99,
          reviewStatus: 'confirmed',
          documentId: 'doc_dpa',
          page: 5,
          quote: 'Signed for MediSupply GmbH — 18 August 2026',
          version: 1,
        },
      ],
      findings: [
        {
          id: 'finding_gdp',
          ruleKey: 'required.gdp',
          severity: 'critical',
          status: 'open',
          title: 'GDP certificate is missing',
          description:
            'Cold-chain medicinal distribution requires current GDP evidence before onboarding.',
          remediation:
            'Ask the supplier for a current GDP certificate covering the Düsseldorf distribution site.',
          version: 1,
        },
        {
          id: 'finding_insurance',
          ruleKey: 'insurance.minimum_limit',
          severity: 'major',
          status: 'open',
          title: 'Liability coverage is €1m below policy',
          description:
            'Extracted coverage is €1,000,000; supplier policy requires at least €2,000,000 per occurrence.',
          remediation: 'Request an updated certificate or endorsement showing at least €2,000,000.',
          evidence: {
            documentId: 'doc_insurance',
            page: 1,
            quote: 'General product liability limit: EUR 1,000,000 per occurrence',
          },
          version: 1,
        },
        {
          id: 'finding_name',
          ruleKey: 'identity.legal_name_match',
          severity: 'major',
          status: 'open',
          title: 'Contract party does not match the register',
          description:
            'The register names MediSupply GmbH while the contract names MediSupply Europe GmbH.',
          remediation:
            'Confirm whether the contract party is an alias or related entity and obtain corrected evidence.',
          evidence: { documentId: 'doc_contract', page: 1, quote: 'MediSupply Europe GmbH' },
          version: 1,
        },
      ],
      audit: [
        {
          id: 'audit_1',
          at: '2026-08-25T09:10:00.000Z',
          actor: 'Dmytro Nikolaiev',
          action: 'case.created',
          detail: 'Created with pharmacy supplier pack v1.0.0',
        },
        {
          id: 'audit_2',
          at: '2026-08-25T09:13:18.000Z',
          actor: 'document-worker',
          action: 'documents.processed',
          detail: '6 documents, 20 pages, OCR used on 1 page',
        },
        {
          id: 'audit_3',
          at: '2026-08-25T09:14:02.000Z',
          actor: 'rules-engine',
          action: 'rules.completed',
          detail: '1 critical and 2 major findings',
        },
        {
          id: 'audit_4',
          at: now,
          actor: 'workflow',
          action: 'review.requested',
          detail: 'Recommendation: request information',
        },
      ],
      decision: null,
    },
    {
      id: 'case_01J67Y7HFXCQ1D78Y09N8ZABPV',
      tenantId: 'tenant_demo',
      reference: 'SUP-2026-0141',
      subjectName: 'NordMed Logistics AG',
      domain: 'Pharmacy supplier qualification',
      domainPackVersion: '1.0.0',
      status: 'processing',
      recommendation: null,
      progress: 64,
      createdAt: '2026-08-25T07:48:00.000Z',
      updatedAt: '2026-08-26T05:15:00.000Z',
      dueAt: '2026-08-30T16:00:00.000Z',
      assignedTo: 'Dmytro Nikolaiev',
      version: 1,
      documents: [],
      facts: [],
      findings: [],
      audit: [],
      decision: null,
    },
  ];
}
