'use client';

import { useState } from 'react';
import { ExternalLink, Minus, Plus, ScanText } from 'lucide-react';

import type { CaseDocument, EvidenceAnchor } from '@/lib/demo-data';

const documentCopy: Record<string, { heading: string; lines: string[] }> = {
  questionnaire: {
    heading: 'Supplier Qualification Questionnaire',
    lines: [
      'Organisation: MediSupply GmbH',
      'Registered office: Düsseldorf, Germany',
      'Scope: Storage and distribution of temperature-controlled medicinal products',
      'Good Distribution Practice certificate: pending renewal.',
      'Supporting document will be provided separately.',
    ],
  },
  register: {
    heading: 'Handelsregister B · Current extract',
    lines: [
      'Amtsgericht Düsseldorf',
      'Firma: MediSupply GmbH',
      'Sitz: Düsseldorf · HRB 92831',
      'Gegenstand: Großhandel mit pharmazeutischen Erzeugnissen',
      'Vertretungsberechtigt: Dr. Klara Rehm',
    ],
  },
  insurance: {
    heading: 'Certificate of Liability Insurance',
    lines: [
      'Policyholder: MediSupply GmbH',
      'Policy number: HDI-PH-884210',
      'Public and product liability: EUR 1,000,000 per occurrence',
      'Aggregate annual limit: EUR 2,000,000',
      'Period of cover: 01 January 2026 to 31 December 2026',
    ],
  },
  contract: {
    heading: 'Pharmaceutical Supply Agreement',
    lines: [
      'Effective date: 15 August 2026',
      'This Supply Agreement is entered into by MediSupply Europe GmbH (‘Supplier’).',
      'and Northstar Online Apotheke GmbH (‘Customer’).',
      'Supplier will maintain controlled distribution conditions.',
      'Applicable law: Federal Republic of Germany',
    ],
  },
  iso: {
    heading: 'Certificate of Registration',
    lines: [
      'MediSupply GmbH',
      'Quality management system certified to ISO 13485:2016',
      'Scope: Distribution and controlled storage of medical devices',
      'Certificate valid until 18 November 2027',
      'Certification body: Q-Audit Europe GmbH',
    ],
  },
};

const sourceFixtures: Record<string, string> = {
  questionnaire: '01_supplier_questionnaire.pdf',
  register: '02_commercial_register_extract.pdf',
  iso: '03_iso_13485_certificate.pdf',
  insurance: '04_insurance_certificate.pdf',
  dpa: '05_data_processing_agreement.pdf',
  contract: '06_supply_contract.pdf',
  catalog: '11_multilingual_product_catalog.pdf',
  delivery: '12_rotated_low_contrast_delivery_note.pdf',
};

export function DocumentSurface({
  document,
  evidence,
}: {
  document: CaseDocument;
  evidence: EvidenceAnchor[];
}) {
  const [zoom, setZoom] = useState(92);
  const copy = documentCopy[document.id] ?? {
    heading: document.label,
    lines: [
      `Source file: ${document.fileName}`,
      `Classified as: ${document.kind}`,
      'No highlighted material evidence on this page.',
    ],
  };
  const documentEvidence = evidence.filter((item) => item.documentId === document.id);
  const sourceFixture = sourceFixtures[document.id];

  return (
    <div className="document-viewer">
      <div className="document-toolbar">
        <div className="toolbar-document-title">
          <span className="toolbar-document-icon" aria-hidden="true">
            <ScanText size={17} />
          </span>
          <div>
            <span className="toolbar-kicker">Source document</span>
            <strong>{document.label}</strong>
            {sourceFixture ? (
              <a
                href={`/demo-documents/${encodeURIComponent(sourceFixture)}`}
                target="_blank"
                rel="noreferrer"
              >
                Open verified PDF <ExternalLink aria-hidden="true" size={11} />
              </a>
            ) : null}
          </div>
        </div>
        <div className="zoom-controls" aria-label="Document zoom">
          <button
            aria-label="Zoom out"
            onClick={() => setZoom((value) => Math.max(70, value - 10))}
            type="button"
          >
            <Minus aria-hidden="true" size={15} />
          </button>
          <output aria-live="polite">{zoom}%</output>
          <button
            aria-label="Zoom in"
            onClick={() => setZoom((value) => Math.min(130, value + 10))}
            type="button"
          >
            <Plus aria-hidden="true" size={15} />
          </button>
        </div>
      </div>

      {document.state === 'missing' ? (
        <div className="missing-document">
          <span aria-hidden="true">!</span>
          <h2>GDP certificate was not supplied</h2>
          <p>This required document has no file or page evidence. Request it from the supplier.</p>
        </div>
      ) : (
        <div className="document-stage">
          <article
            className="paper-page"
            style={{ '--document-zoom': zoom / 100 } as React.CSSProperties}
            aria-label={`${document.label}, page 1`}
          >
            <header className="paper-letterhead">
              <span>MEDISUPPLY</span>
              <small>Controlled healthcare distribution</small>
            </header>
            <div className="paper-body">
              <p className="paper-reference">DOCUMENT / {document.kind.toUpperCase()}</p>
              <h2>{copy.heading}</h2>
              <div className="paper-rule" />
              {copy.lines.map((line, index) => {
                const matchingEvidence = documentEvidence.find((item) =>
                  line
                    .toLowerCase()
                    .includes(item.excerpt.split(' ').slice(0, 3).join(' ').toLowerCase()),
                );
                const looseMatch = documentEvidence[index - 1];
                const highlightedEvidence = matchingEvidence ?? looseMatch;

                return (
                  <p className={highlightedEvidence ? 'evidence-highlight' : undefined} key={line}>
                    {line}
                    {highlightedEvidence ? (
                      <a
                        className={`page-anchor severity-${highlightedEvidence.severity}`}
                        href={`#finding-${highlightedEvidence.id}`}
                        id={`evidence-${highlightedEvidence.id}`}
                        aria-label={`Evidence ${highlightedEvidence.index}: ${highlightedEvidence.label}`}
                      >
                        E{String(highlightedEvidence.index).padStart(2, '0')}
                      </a>
                    ) : null}
                  </p>
                );
              })}
              <div className="paper-signature">
                <span>Verified source</span>
                <strong>26 AUG 2026</strong>
              </div>
            </div>
            <footer>
              <span>{document.fileName}</span>
              <span>1 / {document.pages}</span>
            </footer>
          </article>
        </div>
      )}
    </div>
  );
}
