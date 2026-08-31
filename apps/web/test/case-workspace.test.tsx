import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CaseWorkspace } from '@/components/case-workspace';
import type { CaseDocument, EvidenceAnchor, Fact, Finding } from '@/lib/demo-data';

vi.mock('@/components/document-surface-loader', () => ({
  DocumentSurfaceLoader: ({
    document,
    page,
    selectedEvidence,
  }: {
    document: CaseDocument;
    page: number;
    selectedEvidence?: EvidenceAnchor;
  }) => (
    <div aria-label="document test surface">
      <span>{document.id}</span>
      <span>page {page}</span>
      <span>{selectedEvidence?.id ?? 'no evidence'}</span>
    </div>
  ),
}));

vi.mock('@/components/document-upload', () => ({
  DocumentUpload: () => <button type="button">Add document</button>,
}));

const documents: CaseDocument[] = [
  {
    id: 'questionnaire',
    label: 'Supplier questionnaire',
    fileName: 'questionnaire.pdf',
    state: 'verified',
    pages: 5,
    kind: 'Questionnaire',
    sourceUrl: '/questionnaire.pdf',
  },
  {
    id: 'register',
    label: 'Register extract',
    fileName: 'register.pdf',
    state: 'verified',
    pages: 2,
    kind: 'Register',
    sourceUrl: '/register.pdf',
  },
];

const evidence: EvidenceAnchor[] = [
  {
    id: 'ev-register',
    index: 1,
    documentId: 'register',
    page: 2,
    label: 'Registered name',
    excerpt: 'Firma: MediSupply GmbH',
    severity: 'major',
  },
];

const facts: Fact[] = [
  {
    id: 'fact-1',
    label: 'Registered name',
    value: 'MediSupply GmbH',
    confidence: 0.98,
    evidenceId: 'ev-register',
    state: 'confirmed',
  },
];

const findings: Finding[] = [
  {
    id: 'finding-1',
    severity: 'major',
    title: 'Name requires review',
    detail: 'The name needs confirmation.',
    action: 'Verify the register.',
    evidenceIds: ['ev-register'],
    policy: 'LEGAL-01',
    state: 'open',
  },
];

describe('case evidence workspace', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/cases/case-1?document=questionnaire&page=1');
  });

  it('keeps document, page, evidence, mobile pane, and browser URL synchronized', () => {
    const { container } = render(
      <CaseWorkspace
        audit={[]}
        authoritative={false}
        caseId="case-1"
        caseReference="SUP-1"
        caseVersion={1}
        documents={documents}
        evidence={evidence}
        facts={facts}
        findings={findings}
        initialDocumentId="questionnaire"
        initialPage={1}
      />,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Open source 1' }));
    expect(screen.getByLabelText('document test surface')).toHaveTextContent(
      'registerpage 2ev-register',
    );
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
      document: 'register',
      evidence: 'ev-register',
      page: '2',
    });
    expect(container.querySelector('.workspace-shell')).toHaveAttribute(
      'data-active-pane',
      'document',
    );

    act(() => {
      window.history.pushState(null, '', '/cases/case-1?document=questionnaire&page=4');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByLabelText('document test surface')).toHaveTextContent(
      'questionnairepage 4no evidence',
    );
  });
});
