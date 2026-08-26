import Link from 'next/link';

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

  return (
    <nav className="dossier-nav" aria-label="Case dossier">
      <div className="dossier-heading">
        <p className="eyebrow">Dossier</p>
        <h2>Source documents</h2>
        <span>
          {complete} verified · {documents.length} expected
        </span>
      </div>
      <ol className="document-list">
        {documents.map((document, index) => (
          <li key={document.id}>
            <Link
              aria-current={selectedDocumentId === document.id ? 'page' : undefined}
              className={`document-link document-${document.state}`}
              href={`/cases/${caseId}?document=${document.id}`}
            >
              <span className="document-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="document-label">
                <strong>{document.label}</strong>
                <small>{document.fileName}</small>
              </span>
              <span className="document-state" aria-label={document.state} />
            </Link>
          </li>
        ))}
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
