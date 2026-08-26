import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ReviewPanel } from '@/components/review-panel';
import type { Fact, Finding } from '@/lib/demo-data';

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
});
