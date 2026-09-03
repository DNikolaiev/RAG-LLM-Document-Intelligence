import { createHash } from 'node:crypto';

/** Deterministic identifier for every policy-derived row the worker creates. */
export function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

/**
 * Case- and punctuation-insensitive form used to compare model wording against cited policy text.
 * Quote verification itself uses `evidenceContainsQuote`, which preserves punctuation.
 */
export function normalizeCitationText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Whitespace- and case-insensitive form used to verify that a quote is genuinely in the source. */
function normalizeEvidence(value: string): string {
  return value.normalize('NFKC').replaceAll(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/**
 * True when `quote` appears verbatim in `source`, ignoring only case and whitespace. Every cited
 * model claim - an extracted fact, a rule proposal, a proposed field - passes through here.
 */
export function evidenceContainsQuote(source: string, quote: string): boolean {
  const normalizedQuote = normalizeEvidence(quote);
  return normalizedQuote.length > 0 && normalizeEvidence(source).includes(normalizedQuote);
}
