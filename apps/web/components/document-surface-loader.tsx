'use client';

import dynamic from 'next/dynamic';

import type { CaseDocument, EvidenceAnchor } from '@/lib/demo-data';

const DocumentSurface = dynamic(
  () => import('./document-surface').then((module) => module.DocumentSurface),
  {
    loading: () => (
      <div className="viewer-loading" aria-busy="true">
        <div className="skeleton skeleton-document" />
        <span className="sr-only">Loading document viewer…</span>
      </div>
    ),
    ssr: false,
  },
);

export function DocumentSurfaceLoader({
  document,
  evidence,
  selectedEvidence,
  page,
  onPageChange,
}: {
  document: CaseDocument;
  evidence: EvidenceAnchor[];
  selectedEvidence?: EvidenceAnchor | undefined;
  page: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <DocumentSurface
      key={document.id}
      document={document}
      evidence={evidence}
      onPageChange={onPageChange}
      page={page}
      selectedEvidence={selectedEvidence}
    />
  );
}
