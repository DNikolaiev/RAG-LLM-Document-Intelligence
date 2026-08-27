import Link from 'next/link';
import { FileCheck2, FileClock, Files, FileWarning, LoaderCircle, ShieldCheck } from 'lucide-react';

import { DocumentUpload } from '@/components/document-upload';
import type { CaseDocument } from '@/lib/demo-data';

export function DossierNav({
  caseId,
  documents,
  selectedDocumentId,
}: {
  caseId: string;
  documents: CaseDocument[];
  selectedDocumentId: string;
}) {
  const complete = documents.filter((item) => item.state === 'verified').length;
  const stateIcons = {
    verified: FileCheck2,
    warning: FileWarning,
    missing: FileClock,
    processing: LoaderCircle,
  } as const;

  return (
    <nav className="dossier-nav" aria-label="Case dossier">
      <div className="dossier-heading">
        <span className="section-icon" aria-hidden="true">
          <Files size={17} />
        </span>
        <p className="eyebrow">Dossier</p>
        <h2>Source documents</h2>
        <span className="dossier-progress-copy">
          <ShieldCheck aria-hidden="true" size={13} /> {complete} verified · {documents.length}{' '}
          expected
        </span>
        <progress
          value={complete}
          max={documents.length}
          aria-label={`${complete} of ${documents.length} documents verified`}
        />
      </div>
      <ol className="document-list">
        {documents.map((document, index) => {
          const StateIcon = stateIcons[document.state];
          return (
            <li key={document.id}>
              <Link
                aria-current={selectedDocumentId === document.id ? 'page' : undefined}
                className={`document-link document-${document.state}`}
                href={`/cases/${caseId}?document=${document.id}`}
              >
                <span className="document-index" aria-hidden="true">
                  <StateIcon size={15} />
                </span>
                <span className="document-label">
                  <strong>{document.label}</strong>
                  <small>
                    {String(index + 1).padStart(2, '0')} · {document.fileName}
                  </small>
                </span>
                <span className="document-state" aria-label={document.state} />
              </Link>
            </li>
          );
        })}
      </ol>
      <DocumentUpload caseId={caseId} />
      <div className="dossier-note">
        <strong>Processing record</strong>
        <span>32 pages · OCR on 2</span>
        <span>Last run 09:41 · deterministic</span>
      </div>
    </nav>
  );
}
