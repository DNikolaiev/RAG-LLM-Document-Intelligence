import { describe, expect, it } from 'vitest';
import { legalContractPack } from '@caselens/domain';
import {
  buildExtractionFieldCatalog,
  chunkSourcePage,
  evidenceContainsQuote,
  isExtractionValueAllowed,
  mapWithConcurrency,
} from '../src/production-runtime.js';

describe('production worker safeguards', () => {
  it('derives the extraction allowlist from the selected domain pack', () => {
    const fields = buildExtractionFieldCatalog(legalContractPack);

    expect([...fields.keys()]).toEqual([
      'contract.parties',
      'contract.terminationNoticeDays',
      'contract.governingLaw',
    ]);
    expect(fields.get('contract.terminationNoticeDays')).toMatchObject({
      type: 'number',
      aliases: ['notice period'],
    });
    expect(isExtractionValueAllowed('number', 30)).toBe(true);
    expect(isExtractionValueAllowed('number', '30')).toBe(false);
    expect(isExtractionValueAllowed('list', ['Buyer', 'Seller'])).toBe(true);
    expect(isExtractionValueAllowed('list', [{ name: 'Buyer' }])).toBe(false);
  });

  it('requires an exact normalized quote from the cited evidence', () => {
    expect(
      evidenceContainsQuote(
        'Coverage\nshall be EUR 2,000,000.',
        'coverage shall be EUR 2,000,000.',
      ),
    ).toBe(true);
    expect(evidenceContainsQuote('Coverage shall be EUR 2,000,000.', 'EUR 3,000,000')).toBe(false);
    expect(evidenceContainsQuote('Evidence', '   ')).toBe(false);
  });

  it('does not produce an empty or redundant trailing overlap chunk', () => {
    const text = 'x'.repeat(11_700);
    const chunks = chunkSourcePage({ documentId: 'document-1', page: 1, text }, 6_000, 300);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.text.length)).toEqual([6_000, 6_000]);
    expect(chunkSourcePage({ documentId: 'document-1', page: 2, text: '  ' }, 6_000, 300)).toEqual(
      [],
    );
  });

  it('preserves result order while bounding model concurrency', async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await mapWithConcurrency([30, 10, 20, 5], 2, async (delay, index) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return index;
    });

    expect(results).toEqual([0, 1, 2, 3]);
    expect(maximumActive).toBe(2);
  });
});
