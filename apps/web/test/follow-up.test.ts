import { describe, expect, it } from 'vitest';

import { buildFollowUpDraft } from '@/lib/follow-up';
import type { Finding } from '@/lib/demo-data';

const findings: Finding[] = [
  {
    id: 'one',
    severity: 'critical',
    title: 'GDP certificate is missing',
    detail: 'Evidence is required.',
    action: 'Provide a current GDP certificate.',
    evidenceIds: [],
    policy: 'GDP-01',
    state: 'accepted',
  },
  {
    id: 'two',
    severity: 'major',
    title: 'Coverage is below policy',
    detail: 'The limit is too low.',
    action: 'Provide evidence of €2m coverage.',
    evidenceIds: [],
    policy: 'RISK-02',
    state: 'accepted',
  },
  {
    id: 'three',
    severity: 'minor',
    title: 'Unselected note',
    detail: 'Not part of the request.',
    action: 'Do not include.',
    evidenceIds: [],
    policy: 'NOTE-03',
    state: 'open',
  },
];

describe('follow-up draft', () => {
  it('includes every accepted finding and produces an encoded mailto URL', () => {
    const draft = buildFollowUpDraft({
      caseReference: 'SUP-42',
      subjectName: 'MediSupply GmbH',
      findings,
      contact: { name: 'Dr. Rehm', email: 'quality@example.test' },
      senderName: 'Reviewer One',
    });

    expect(draft.body).toContain('1. GDP certificate is missing');
    expect(draft.body).toContain('2. Coverage is below policy');
    expect(draft.body).not.toContain('Unselected note');
    expect(draft.body).toContain('Dear Dr. Rehm,');
    expect(draft.mailto).toMatch(/^mailto:quality%40example\.test\?/);
    expect(decodeURIComponent(draft.mailto!)).toContain('Provide evidence of €2m coverage.');
  });

  it('keeps a complete copyable draft when no contact is available', () => {
    const draft = buildFollowUpDraft({
      caseReference: 'SUP-42',
      subjectName: 'Unknown supplier',
      findings,
    });

    expect(draft.mailto).toBeUndefined();
    expect(draft.body).toContain('Dear Sir or Madam,');
    expect(draft.body).toContain('Case review team');
  });
});
