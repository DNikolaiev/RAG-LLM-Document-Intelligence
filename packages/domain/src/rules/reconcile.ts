export interface FactCandidate {
  path: string;
  value: unknown;
  confidence: number;
  documentId: string;
}

export interface ReconciliationResult {
  canonicalPath: string;
  selected: FactCandidate | null;
  alternatives: FactCandidate[];
  conflict: boolean;
}

function normalized(
  value: unknown,
  mode: 'legal_name' | 'text' | 'registration' | 'currency',
): unknown {
  if (mode === 'currency') {
    return typeof value === 'string' || typeof value === 'number' ? normalizeCurrency(value) : null;
  }
  const text = String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase();
  if (mode === 'legal_name') return text.replace(/[.,]/g, '').replace(/\s+/g, ' ');
  if (mode === 'registration') return text.replace(/[^a-z0-9]/g, '');
  return text.replace(/\s+/g, ' ');
}

export function reconcileFacts(
  canonicalPath: string,
  candidates: readonly FactCandidate[],
  mode: 'legal_name' | 'text' | 'registration' | 'currency',
): ReconciliationResult {
  const sorted = [...candidates].sort(
    (a, b) => b.confidence - a.confidence || a.documentId.localeCompare(b.documentId),
  );
  const selected = sorted[0] ?? null;
  const selectedValue = selected ? normalized(selected.value, mode) : undefined;
  return {
    canonicalPath,
    selected,
    alternatives: sorted.slice(1),
    conflict:
      selected !== null &&
      sorted.slice(1).some((candidate) => normalized(candidate.value, mode) !== selectedValue),
  };
}
import { normalizeCurrency } from './evaluator.js';
