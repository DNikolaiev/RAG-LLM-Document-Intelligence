import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReviewPanel } from '@/components/review-panel';
import type { EvidenceAnchor, Fact, Finding } from '@/lib/demo-data';

const findings: Finding[] = [
  {
    id: 'finding-1',
    severity: 'critical',
    title: 'GDP certificate is missing',
    detail: 'Evidence is required.',
    action: 'Request certificate',
    evidenceIds: ['ev-1'],
    policy: 'GDP-01',
    state: 'open',
  },
];

const facts: Fact[] = [
  {
    id: 'fact-1',
    label: 'Legal name',
    value: 'MediSupply Europe GmbH',
    confidence: 0.91,
    evidenceId: 'ev-1',
    state: 'conflict',
  },
];

const evidence: EvidenceAnchor[] = [
  {
    id: 'ev-1',
    index: 1,
    documentId: 'doc-1',
    page: 3,
    label: 'Registered legal name',
    excerpt: 'Firma: MediSupply GmbH',
    severity: 'critical',
  },
];

describe('review actions', () => {
  it('requires a reason before saving a fact correction', () => {
    render(
      <ReviewPanel
        authoritative={false}
        initialFindings={findings}
        initialFacts={facts}
        audit={[]}
        caseId="case-1"
        caseReference="SUP-1"
        caseVersion={1}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Facts 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Correct value' }));
    const dialog = screen.getByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save correction' });
    expect(save).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Corrected value'), {
      target: { value: 'MediSupply GmbH' },
    });
    fireEvent.change(within(dialog).getByLabelText('Reason for correction'), {
      target: { value: 'Confirmed against the current register extract.' },
    });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    expect(screen.getByText('MediSupply GmbH')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Correction saved');
  });

  it('keeps finding resolution explicit and announces the result', () => {
    render(
      <ReviewPanel
        authoritative={false}
        initialFindings={findings}
        initialFacts={facts}
        audit={[]}
        caseId="case-1"
        caseReference="SUP-1"
        caseVersion={1}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));

    expect(screen.getByText('resolved')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Finding marked resolved');
    expect(screen.getByRole('tab', { name: 'Findings 0' })).toBeInTheDocument();
  });

  it('turns accepted findings into a reviewable information request', () => {
    render(
      <ReviewPanel
        authoritative={false}
        initialFindings={findings}
        initialFacts={facts}
        audit={[]}
        caseId="case-1"
        caseReference="SUP-1"
        caseVersion={1}
        subjectName="MediSupply GmbH"
        senderName="Mara Stein"
        contact={{ name: 'Dr. Rehm', email: 'quality@example.test' }}
      />,
    );

    const request = screen.getByRole('button', { name: 'Request information' });
    expect(request).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add to follow-up' }));
    expect(screen.getByText('Included in follow-up')).toBeInTheDocument();
    expect(request).toBeEnabled();
    fireEvent.click(request);

    const dialog = screen.getByRole('dialog', { name: 'Review the information request' });
    expect(within(dialog).getByDisplayValue(/Information request — SUP-1/)).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue(/GDP certificate is missing/)).toBeInTheDocument();
    expect(
      (within(dialog).getByLabelText(/Message covering/) as HTMLTextAreaElement).value,
    ).toContain('Kind regards,\nMara Stein');
    expect(within(dialog).getByRole('button', { name: 'Record and open email' })).toBeEnabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: 'Review the information request' }),
    ).not.toBeInTheDocument();
    expect(request).toHaveFocus();
  });

  it('records and copies a request when the source document has no contact', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ caseVersion: 2 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      render(
        <ReviewPanel
          authoritative={false}
          initialFindings={findings}
          initialFacts={facts}
          audit={[]}
          caseId="case-1"
          caseReference="SUP-1"
          caseVersion={1}
          senderName="Mara Stein"
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Add to follow-up' }));
      fireEvent.click(screen.getByRole('button', { name: /Request information/ }));
      const dialog = screen.getByRole('dialog', { name: 'Review the information request' });
      expect(within(dialog).getByText('No document contact found')).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Record and copy' }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/cases/case-1/decisions',
          expect.objectContaining({ method: 'POST' }),
        );
        expect(writeText).toHaveBeenCalledOnce();
      });
      expect(within(dialog).getByRole('status')).toHaveTextContent('copied to the clipboard');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('exposes deep links and delegates evidence navigation from findings and facts', () => {
    const onOpenEvidence = vi.fn();
    render(
      <ReviewPanel
        authoritative={false}
        initialFindings={findings}
        initialFacts={facts}
        audit={[]}
        caseId="case-1"
        caseReference="SUP-1"
        caseVersion={1}
        evidence={evidence}
        onOpenEvidence={onOpenEvidence}
      />,
    );

    const findingLink = screen.getByRole('link', { name: 'Open source 1' });
    expect(findingLink).toHaveAttribute(
      'href',
      '/cases/case-1?document=doc-1&evidence=ev-1&page=3',
    );
    fireEvent.click(findingLink);
    expect(onOpenEvidence).toHaveBeenLastCalledWith('ev-1');

    fireEvent.click(screen.getByRole('tab', { name: 'Facts 1' }));
    expect(screen.getByText('Registered legal name · page 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Open in document' }));
    expect(onOpenEvidence).toHaveBeenCalledTimes(2);
  });
});
