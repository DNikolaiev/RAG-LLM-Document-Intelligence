import { describe, expect, it } from 'vitest';

import { findCitationSpanIndexes } from '@/lib/citation-matching';

describe('citation highlighting', () => {
  it('matches the full normalized citation across adjacent PDF text spans', () => {
    expect(
      findCitationSpanIndexes(
        ['Product liability cover of at least', 'EUR 2,000,000 per occurrence', 'is required.'],
        'product liability cover of at least EUR 2,000,000 per occurrence',
      ),
    ).toEqual([0, 1]);
  });

  it('does not highlight a repeated term without the complete adjacent citation', () => {
    expect(
      findCitationSpanIndexes(
        ['Liability cover is reviewed annually.', 'At least EUR 2,000,000 is required.'],
        'product liability cover of at least EUR 2,000,000 per occurrence',
      ),
    ).toEqual([]);
  });
});
