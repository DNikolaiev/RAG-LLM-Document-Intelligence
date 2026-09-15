// Evaluates policy collection classification against the configured model and reports how often it
// agrees with the expected collections and with the deterministic lexical reading.
//
// Not part of CI, deliberately: a local model is not deterministic, so its accuracy is measured and
// reported here rather than gated on. CI gates the deterministic path instead
// (test/collection-classification.eval.test.ts). The one outcome this script treats as failure is a
// policy FILED into a collection outside its acceptable set - asking is always allowed.
//
// Run it inside the worker container, which has the model endpoint and the built code:
//   docker compose -f infra/docker-compose.production-local.yml --env-file infra/.env.production-local \
//     exec worker node scripts/evaluate-collection-classification.mjs
import { readFile } from 'node:fs/promises';
import { loadConfig } from '@caselens/config';
import { resolveDomainPack } from '@caselens/domain';
import { createWorkerModelRuntime } from '../dist/model-runtime.js';
import {
  createCollectionClassifier,
  independentReading,
  settleCollectionClassification,
} from '../dist/policy/collection-classification.js';

const dataset = JSON.parse(
  await readFile(
    new URL('../../../fixtures/evaluation/policy-collection-classification.json', import.meta.url),
    'utf8',
  ),
);
const config = loadConfig(process.env);
const runtime = createWorkerModelRuntime(config);
const classifier = createCollectionClassifier(
  { ...config, WORKER_COLLECTION_CLASSIFIER: 'model' },
  runtime.chat,
);
const thresholds = {
  autoFileConfidence: config.WORKER_COLLECTION_AUTO_FILE_CONFIDENCE,
  nearDuplicateSimilarity: config.WORKER_COLLECTION_NEAR_DUPLICATE_SIMILARITY,
};

const rows = [];
for (const item of dataset.cases) {
  const pack = resolveDomainPack(item.domain);
  const acceptable = new Set(item.acceptableCollectionIds);
  const started = Date.now();
  const raw = await classifier.classify({ pages: item.pages, collections: pack.policyCollections });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const reading = independentReading(classifier, item.pages, pack.policyCollections);
  if (!raw.ok) {
    rows.push({ item, seconds, pick: `error: ${raw.message}`, pickRight: false, verdict: 'asked' });
    continue;
  }
  const { suggestion, filedCollectionId } = await settleCollectionClassification({
    raw: raw.value,
    pages: item.pages,
    collections: pack.policyCollections,
    classifier,
    packVersion: pack.version,
    thresholds,
    embeddings: runtime.embeddings,
    corroboratingCollectionId: reading,
  });
  const pick = suggestion.decision === 'new' ? `new: ${suggestion.label}` : suggestion.collectionId;
  // Right: the pick is acceptable, or - where nothing fits - the model proposed a new collection.
  const pickRight =
    item.expectedCollectionId === null
      ? suggestion.decision === 'new'
      : suggestion.decision === 'existing' && acceptable.has(suggestion.collectionId);
  const verdict = filedCollectionId
    ? acceptable.has(filedCollectionId)
      ? 'filed correctly'
      : 'FILED WRONGLY'
    : 'asked';
  rows.push({
    item,
    seconds,
    pick,
    pickRight,
    verdict,
    confidence: suggestion.confidence,
    reading: reading ?? '(no clear winner)',
    reasons: suggestion.reasons.join(', ') || '-',
  });
}

console.log(`\nClassifier: ${classifier.providerId} / ${classifier.model}`);
for (const row of rows) {
  console.log(
    `\n${row.item.id} (${row.seconds}s)\n` +
      `  expected : ${row.item.expectedCollectionId ?? '(nothing fits)'}\n` +
      `  model    : ${row.pick}${row.confidence === undefined ? '' : ` @ ${row.confidence}`}` +
      `${row.pickRight ? '  [right]' : '  [wrong]'}\n` +
      `  lexical  : ${row.reading ?? '-'}\n` +
      `  outcome  : ${row.verdict}${row.reasons ? ` (${row.reasons})` : ''}`,
  );
}
const count = (predicate) => rows.filter(predicate).length;
const wrong = count((row) => row.verdict === 'FILED WRONGLY');
console.log(
  `\n${rows.length} cases: model pick right ${count((row) => row.pickRight)}/${rows.length}; ` +
    `filed correctly ${count((row) => row.verdict === 'filed correctly')}, ` +
    `asked ${count((row) => row.verdict === 'asked')}, filed wrongly ${wrong}.`,
);
process.exitCode = wrong > 0 ? 1 : 0;
