import { readFileSync } from 'node:fs';
import { resolveDomainPack } from '@caselens/domain';
import { describe, expect, it } from 'vitest';
import {
  createLexicalCollectionClassifier,
  settleCollectionClassification,
} from '../src/policy/collection-classification.js';

/**
 * The deterministic half of the classification evaluation (fixtures/evaluation/). The model half is
 * scripts/evaluate-collection-classification.mjs, which reports and never gates: a local model is
 * not deterministic.
 *
 * Two things are asserted. The rule that matters: nothing is ever filed outside a case's acceptable
 * collections - asking is always allowed. And the exact outcome of every case, recorded from
 * measurement, so a change to the classifier, a description or the thresholds shows up as a diff to
 * this table rather than silently.
 */
interface EvaluationCase {
  id: string;
  domain: string;
  expectedCollectionId: string | null;
  acceptableCollectionIds: string[];
  pages: Array<{ page: number; text: string }>;
}

const dataset = JSON.parse(
  readFileSync(
    new URL('../../../fixtures/evaluation/policy-collection-classification.json', import.meta.url),
    'utf8',
  ),
) as { cases: EvaluationCase[] };

/**
 * Measured 2026-09-15, 1.1.0 packs, default thresholds. The word matcher files 3 of 10 and asks
 * about the other 7: conservative by design. It files the heat-number and tensile-strength policies
 * nowhere because three shared words put it at 0.75, under the 0.8 threshold, although its pick is
 * right; and it would pick Data Protection Terms for the jurisdiction policy, which is exactly why it
 * asks rather than files at 0.25.
 */
const RECORDED: Record<string, { filed: string | null; suggested: string | null }> = {
  'legal-termination-notice': { filed: 'term-termination', suggested: 'term-termination' },
  'legal-jurisdiction-escalation': { filed: null, suggested: 'data-protection-terms' },
  'insurance-loss-date-cutoff': { filed: null, suggested: 'insurance-claims-assessment-policy' },
  'insurance-settlement-value': { filed: null, suggested: 'insurance-claims-assessment-policy' },
  'manufacturing-approved-grades': {
    filed: 'material-specifications',
    suggested: 'material-specifications',
  },
  'manufacturing-heat-number': { filed: null, suggested: 'material-specifications' },
  'manufacturing-tensile-strength': { filed: null, suggested: 'material-specifications' },
  'legal-anti-bribery': { filed: null, suggested: 'commercial-contract-review-policy' },
  'legal-data-protection-injection': {
    filed: 'data-protection-terms',
    suggested: 'data-protection-terms',
  },
  'manufacturing-visitor-hygiene': { filed: null, suggested: 'supplier-quality-assurance-policy' },
};

async function classifyLexically(item: EvaluationCase) {
  const pack = resolveDomainPack(item.domain);
  const classifier = createLexicalCollectionClassifier();
  const raw = await classifier.classify({ pages: item.pages, collections: pack.policyCollections });
  if (!raw.ok) throw new Error(`${item.id}: ${raw.message}`);
  const { suggestion, filedCollectionId } = await settleCollectionClassification({
    raw: raw.value,
    pages: item.pages,
    collections: pack.policyCollections,
    classifier,
    packVersion: pack.version,
    thresholds: { autoFileConfidence: 0.8, nearDuplicateSimilarity: 0.8 },
  });
  return {
    filed: filedCollectionId,
    suggested: suggestion.decision === 'existing' ? suggestion.collectionId : null,
  };
}

describe('collection classification evaluation, deterministic classifier', () => {
  it.each(dataset.cases.map((item) => [item.id, item] as const))(
    '%s is filed into an acceptable collection or asked about, never misfiled',
    async (_id, item) => {
      const { filed } = await classifyLexically(item);
      if (filed !== null) expect(item.acceptableCollectionIds).toContain(filed);
    },
  );

  it('produces exactly the recorded outcome for every case', async () => {
    // A case added to the dataset must be measured and recorded here too.
    expect(Object.keys(RECORDED).sort()).toEqual(dataset.cases.map((item) => item.id).sort());
    const outcomes = Object.fromEntries(
      await Promise.all(
        dataset.cases.map(async (item) => [item.id, await classifyLexically(item)]),
      ),
    );
    expect(outcomes).toEqual(RECORDED);
  });

  it('covers every policy in the policy lab, plus cases that fit nowhere', () => {
    const lab = JSON.parse(
      readFileSync(
        new URL(
          '../../../fixtures/documents/policy-lab/policy-lab-fixture-pack.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { documents: Array<{ filename: string; kind: string }> };
    const policies = lab.documents
      .filter((document) => document.kind === 'policy')
      .map((document) => `policy-lab/${document.filename}`);
    const evaluated = (dataset.cases as Array<EvaluationCase & { source: { filename?: string } }>)
      .map((item) => item.source.filename)
      .filter(Boolean);
    expect(evaluated.sort()).toEqual(policies.sort());
    expect(dataset.cases.some((item) => item.expectedCollectionId === null)).toBe(true);
  });
});
