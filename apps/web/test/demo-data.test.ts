import { describe, expect, it } from 'vitest';

import { countByStatus, filterCases, listCases } from '@/lib/demo-data';

describe('case queue filtering', () => {
  it('matches supplier names and references without case sensitivity', async () => {
    const cases = await listCases();

    expect(filterCases(cases, 'medisupply', 'all')).toHaveLength(1);
    expect(filterCases(cases, 'SUP-2026-0142', 'all')[0]?.supplier).toBe('MediSupply GmbH');
  });

  it('combines status and text filters and returns an intentional empty result', async () => {
    const cases = await listCases();

    expect(filterCases(cases, 'MediSupply', 'approved')).toEqual([]);
    expect(filterCases(cases, '', 'processing')[0]?.supplier).toBe('CuraLogistik B.V.');
  });

  it('counts each workflow state deterministically', async () => {
    const counts = countByStatus(await listCases());

    expect(counts).toEqual({
      approved: 1,
      processing: 1,
      ready_for_decision: 1,
      review_needed: 1,
    });
  });
});
