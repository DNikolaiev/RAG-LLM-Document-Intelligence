import { FileUp, ShieldCheck } from 'lucide-react';

export function EmptyDocumentSurface() {
  return (
    <section className="empty-document-surface" aria-labelledby="empty-document-title">
      <span className="empty-document-mark" aria-hidden="true">
        <FileUp size={28} strokeWidth={1.6} />
      </span>
      <p className="eyebrow">Evidence intake</p>
      <h2 id="empty-document-title">This dossier is ready for its first source</h2>
      <p>
        Add a PDF or text document from the dossier panel. Processing starts only after evidence is
        attached, so the case remains visible and reviewable in the meantime.
      </p>
      <span className="empty-document-assurance">
        <ShieldCheck aria-hidden="true" size={15} /> Tenant access remains enforced
      </span>
    </section>
  );
}
