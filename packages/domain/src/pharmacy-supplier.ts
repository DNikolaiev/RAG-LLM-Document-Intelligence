import { parseDomainPack } from './domain-pack/schema.js';

export const pharmacySupplierPack = parseDomainPack({
  schemaVersion: 1,
  id: 'pharmacy-supplier',
  version: '1.0.0',
  name: 'Pharmaceutical supplier qualification',
  timezone: 'Europe/Berlin',
  terminology: {
    case: 'Supplier dossier',
    subject: 'Supplier',
    decision: 'Qualification decision',
  },
  thresholds: { extractionReview: 0.82, retrieval: 0.55 },
  documentTypes: [
    {
      id: 'supplier_questionnaire',
      label: 'Supplier questionnaire',
      description: 'Supplier-provided capabilities and identity',
      extractionFields: [
        {
          path: 'supplier.legalName',
          label: 'Legal name',
          type: 'string',
          required: true,
          aliases: ['company name'],
        },
        {
          path: 'supplier.distributesTemperatureControlled',
          label: 'Temperature-controlled distribution',
          type: 'boolean',
          required: true,
          aliases: ['cold chain'],
        },
      ],
    },
    {
      id: 'commercial_register',
      label: 'Commercial register extract',
      description: 'Authoritative registration identity',
      extractionFields: [
        {
          path: 'register.legalName',
          label: 'Registered name',
          type: 'string',
          required: true,
          aliases: ['firma'],
        },
        {
          path: 'register.number',
          label: 'Registration number',
          type: 'string',
          required: true,
          aliases: ['HRB'],
        },
      ],
    },
    {
      id: 'iso_13485',
      label: 'ISO 13485 certificate',
      description: 'Medical-device quality certificate',
      extractionFields: [
        {
          path: 'certificates.iso13485.validUntil',
          label: 'Valid until',
          type: 'date',
          required: true,
          aliases: ['expiry'],
        },
      ],
    },
    {
      id: 'insurance_certificate',
      label: 'Liability insurance',
      description: 'Professional and product liability coverage',
      extractionFields: [
        {
          path: 'insurance.liabilityLimitEur',
          label: 'Liability limit',
          type: 'currency',
          required: true,
          aliases: ['coverage', 'cover'],
        },
        {
          path: 'insurance.insuredLegalName',
          label: 'Insured legal entity',
          type: 'string',
          required: true,
          aliases: ['named insured', 'policyholder', 'insured name'],
        },
        {
          path: 'insurance.validUntil',
          label: 'Coverage valid until',
          type: 'date',
          required: true,
          aliases: ['expiry', 'coverage expiry', 'validity'],
        },
      ],
    },
    {
      id: 'data_processing_agreement',
      label: 'Data processing agreement',
      description: 'GDPR Article 28 agreement',
      extractionFields: [
        {
          path: 'dpa.signed',
          label: 'Signed',
          type: 'boolean',
          required: true,
          aliases: ['executed'],
        },
      ],
    },
    {
      id: 'supply_contract',
      label: 'Supply contract',
      description: 'Commercial agreement and contracting identity',
      extractionFields: [
        {
          path: 'contract.partyName',
          label: 'Supplier party',
          type: 'string',
          required: true,
          aliases: ['contractor'],
        },
      ],
    },
    {
      id: 'gdp_certificate',
      label: 'GDP certificate',
      description: 'Good Distribution Practice evidence',
      extractionFields: [
        {
          path: 'certificates.gdp.validUntil',
          label: 'Valid until',
          type: 'date',
          required: true,
          aliases: ['expiry'],
        },
      ],
    },
    {
      id: 'product_catalog',
      label: 'Product catalog',
      description: 'Multilingual product and handling list',
      extractionFields: [
        {
          path: 'catalog.languages',
          label: 'Languages',
          type: 'list',
          required: false,
          aliases: [],
        },
      ],
    },
    {
      id: 'delivery_note',
      label: 'Delivery note',
      description: 'Shipment and cold-chain delivery record',
      extractionFields: [
        {
          path: 'delivery.temperatureC',
          label: 'Temperature',
          type: 'number',
          required: false,
          aliases: ['°C'],
        },
      ],
    },
  ],
  requiredDocuments: [
    {
      id: 'gdp-for-cold-chain',
      documentType: 'gdp_certificate',
      when: {
        operator: 'eq',
        path: 'facts.supplier.distributesTemperatureControlled',
        value: true,
      },
      severity: 'critical',
      message:
        'A current GDP certificate is required for temperature-controlled medicine distribution.',
    },
    {
      id: 'register-always',
      documentType: 'commercial_register',
      severity: 'critical',
      message: 'A current commercial-register extract is required to verify the legal entity.',
    },
    {
      id: 'insurance-always',
      documentType: 'insurance_certificate',
      severity: 'major',
      message: 'A liability insurance certificate is required.',
    },
  ],
  reconciliation: [
    {
      canonicalPath: 'supplier.legalName',
      candidatePaths: [
        'facts.supplier.legalName',
        'facts.register.legalName',
        'facts.contract.partyName',
        'facts.insurance.insuredLegalName',
      ],
      normalizer: 'legal_name',
    },
  ],
  policyCollections: [
    {
      id: 'supplier-qualification',
      label: 'Supplier Qualification Policy',
      chunkSize: 700,
      overlap: 90,
    },
    {
      id: 'pharmaceutical-distribution',
      label: 'Pharmaceutical Distribution Policy',
      chunkSize: 700,
      overlap: 90,
    },
    { id: 'insurance', label: 'Insurance Requirements', chunkSize: 500, overlap: 70 },
    { id: 'data-protection', label: 'Data Protection Policy', chunkSize: 500, overlap: 70 },
  ],
  rules: [
    {
      id: 'insurance-minimum',
      title: 'Liability coverage below policy',
      description: 'Coverage must be at least EUR 2,000,000 per occurrence.',
      severity: 'major',
      when: {
        operator: 'all',
        conditions: [
          { operator: 'exists', path: 'facts.insurance.liabilityLimitEur', value: true },
          { operator: 'lte', path: 'facts.insurance.liabilityLimitEur', value: 1999999.99 },
        ],
      },
      policyTags: ['insurance', 'coverage'],
    },
    {
      id: 'legal-name-conflict',
      title: 'Legal identity conflict',
      description: 'The supplier identity differs between authoritative and contractual documents.',
      severity: 'major',
      when: { operator: 'eq', path: 'reconciliation.supplierLegalNameConflict', value: true },
      policyTags: ['identity', 'supplier-qualification'],
    },
    {
      id: 'iso-expired',
      title: 'ISO certificate expired',
      description: 'The ISO 13485 certificate is not current on the review date.',
      severity: 'major',
      when: {
        operator: 'before',
        path: 'facts.certificates.iso13485.validUntil',
        value: '2026-08-26',
      },
      policyTags: ['quality', 'certificate', 'supplier-qualification'],
    },
    {
      id: 'dpa-unsigned',
      title: 'Data processing agreement unsigned',
      description: 'A signed DPA is required before personal data is exchanged.',
      severity: 'major',
      when: { operator: 'eq', path: 'facts.dpa.signed', value: false },
      policyTags: ['data-protection'],
    },
  ],
  decisions: [
    {
      decision: 'request_information',
      when: { operator: 'eq', path: 'summary.requestInformation', value: true },
      priority: 100,
    },
    {
      decision: 'reject',
      when: { operator: 'eq', path: 'summary.reject', value: true },
      priority: 90,
    },
    {
      decision: 'approve',
      when: { operator: 'eq', path: 'summary.approvable', value: true },
      priority: 50,
    },
  ],
  reviewerChecklist: [
    { id: 'confirm-identity', label: 'Confirm legal entity against the register' },
    {
      id: 'confirm-gdp',
      label: 'Confirm GDP scope and validity',
      when: {
        operator: 'eq',
        path: 'facts.supplier.distributesTemperatureControlled',
        value: true,
      },
    },
    { id: 'confirm-insurance', label: 'Confirm coverage and policy period' },
    { id: 'confirm-dpa', label: 'Confirm DPA signatures' },
  ],
});
