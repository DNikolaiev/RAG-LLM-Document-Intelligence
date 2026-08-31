'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { DocumentSurfaceLoader } from '@/components/document-surface-loader';
import { DossierNav } from '@/components/dossier-nav';
import { EmptyDocumentSurface } from '@/components/empty-document-surface';
import { ReviewPanel } from '@/components/review-panel';
import { WorkspaceTabs, type WorkspacePane } from '@/components/workspace-tabs';
import type {
  AuditEvent,
  CaseContact,
  CaseDocument,
  EvidenceAnchor,
  Fact,
  Finding,
} from '@/lib/demo-data';

interface EvidenceSelection {
  documentId?: string | undefined;
  evidenceId?: string | undefined;
  page: number;
}

export function CaseWorkspace({
  caseId,
  caseReference,
  caseVersion,
  authoritative,
  documents,
  evidence,
  facts,
  findings,
  audit,
  contact,
  subjectName,
  senderName,
  initialDocumentId,
  initialEvidenceId,
  initialPage,
}: {
  caseId: string;
  caseReference: string;
  caseVersion: number;
  authoritative: boolean;
  documents: CaseDocument[];
  evidence: EvidenceAnchor[];
  facts: Fact[];
  findings: Finding[];
  audit: AuditEvent[];
  contact?: CaseContact | undefined;
  subjectName?: string | undefined;
  senderName?: string | undefined;
  initialDocumentId?: string | undefined;
  initialEvidenceId?: string | undefined;
  initialPage: number;
}) {
  const initialSelection = useMemo(
    () =>
      normalizeSelection(
        { documentId: initialDocumentId, evidenceId: initialEvidenceId, page: initialPage },
        documents,
        evidence,
      ),
    [documents, evidence, initialDocumentId, initialEvidenceId, initialPage],
  );
  const [selection, setSelection] = useState<EvidenceSelection>(initialSelection);
  const [activePane, setActivePane] = useState<WorkspacePane>('document');
  const selectedDocument = documents.find((item) => item.id === selection.documentId);
  const selectedEvidence = evidence.find((item) => item.id === selection.evidenceId);

  const commitSelection = useCallback(
    (next: EvidenceSelection, history: 'push' | 'replace' = 'push') => {
      const normalized = normalizeSelection(next, documents, evidence);
      setSelection(normalized);
      const params = new URLSearchParams(window.location.search);
      updateParam(params, 'document', normalized.documentId);
      updateParam(params, 'evidence', normalized.evidenceId);
      params.set('page', String(normalized.page));
      const query = params.toString();
      const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
      window.history[history === 'push' ? 'pushState' : 'replaceState'](null, '', url);
    },
    [documents, evidence],
  );

  useEffect(() => {
    function restoreSelection() {
      const params = new URLSearchParams(window.location.search);
      setSelection(
        normalizeSelection(
          {
            documentId: params.get('document') ?? undefined,
            evidenceId: params.get('evidence') ?? undefined,
            page: parsePage(params.get('page')),
          },
          documents,
          evidence,
        ),
      );
    }
    window.addEventListener('popstate', restoreSelection);
    return () => window.removeEventListener('popstate', restoreSelection);
  }, [documents, evidence]);

  function selectDocument(documentId: string) {
    commitSelection({ documentId, page: 1 });
    setActivePane('document');
  }

  function openEvidence(evidenceId: string) {
    const anchor = evidence.find((item) => item.id === evidenceId);
    if (!anchor) return;
    commitSelection({ documentId: anchor.documentId, evidenceId: anchor.id, page: anchor.page });
    setActivePane('document');
  }

  return (
    <WorkspaceTabs
      activePane={activePane}
      onPaneChange={setActivePane}
      dossier={
        <DossierNav
          caseId={caseId}
          documents={documents}
          onSelectDocument={selectDocument}
          selectedDocumentId={selection.documentId}
        />
      }
      document={
        selectedDocument ? (
          <DocumentSurfaceLoader
            document={selectedDocument}
            evidence={evidence.filter((item) => item.documentId === selectedDocument.id)}
            onPageChange={(page) => commitSelection({ ...selection, page }, 'replace')}
            page={selection.page}
            selectedEvidence={selectedEvidence}
          />
        ) : (
          <EmptyDocumentSurface />
        )
      }
      review={
        <ReviewPanel
          audit={audit}
          authoritative={authoritative}
          caseId={caseId}
          caseReference={caseReference}
          caseVersion={caseVersion}
          contact={contact}
          evidence={evidence}
          initialFacts={facts}
          initialFindings={findings}
          senderName={senderName}
          subjectName={subjectName ?? caseReference}
          onOpenEvidence={openEvidence}
          selectedEvidenceId={selection.evidenceId}
        />
      }
    />
  );
}

function normalizeSelection(
  selection: EvidenceSelection,
  documents: CaseDocument[],
  evidence: EvidenceAnchor[],
): EvidenceSelection {
  const anchor = evidence.find((item) => item.id === selection.evidenceId);
  const requestedDocumentId = anchor?.documentId ?? selection.documentId;
  const document = documents.find((item) => item.id === requestedDocumentId) ?? documents.at(0);
  const requestedPage = anchor?.page ?? selection.page;
  const page = Math.min(Math.max(1, requestedPage || 1), Math.max(1, document?.pages ?? 1));
  return {
    ...(document ? { documentId: document.id } : {}),
    ...(anchor && anchor.documentId === document?.id ? { evidenceId: anchor.id } : {}),
    page,
  };
}

function parsePage(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function updateParam(params: URLSearchParams, name: string, value: string | undefined) {
  if (value) params.set(name, value);
  else params.delete(name);
}
