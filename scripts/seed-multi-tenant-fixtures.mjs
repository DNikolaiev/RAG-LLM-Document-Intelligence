/**
 * Imports the synthetic fixture policies through the public API, approves their
 * already-validated proposals in local test-profile mode, activates them, and
 * runs the three expanded tenant cases through the real BullMQ worker path.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const api = process.env.CASELENS_API_URL ?? 'http://localhost:4100';
const root = resolve(import.meta.dirname, '..');
const pollIntervalMs = 1_500;
const timeoutMs = 10 * 60_000;

const fixtures = [
  {
    label: 'legal',
    profile: 'profile_jonas_feld',
    caseId: 'case_legal_001',
    file: 'fixtures/documents/legal-contract/05_contract-approval-control-policy.pdf',
    title: 'Commercial Contract Review Controls',
    policyVersion: '1.0',
    collectionId: 'commercial-contract-review-policy',
    domainPackId: 'pack_tenant_legal',
  },
  {
    label: 'insurance',
    profile: 'profile_amara_okafor',
    caseId: 'case_insurance_001',
    file: 'fixtures/documents/insurance-claim/05_claim-cost-escalation-policy.pdf',
    title: 'Claim Cost Escalation Policy',
    policyVersion: '1.0',
    collectionId: 'insurance-claims-assessment-policy',
    domainPackId: 'pack_tenant_insurance',
  },
  {
    label: 'manufacturing',
    profile: 'profile_mateo_klein',
    caseId: 'case_manufacturing_001',
    file: 'fixtures/documents/manufacturing-supplier/05_material-grade-control-policy.pdf',
    title: 'Supplier Material Grade Control',
    policyVersion: '1.0',
    collectionId: 'supplier-quality-assurance-policy',
    domainPackId: 'pack_tenant_manufacturing',
  },
];

async function request(path, { profile, method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { 'x-test-profile-id': profile, ...headers },
    body,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok)
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function waitFor(path, profile, predicate, description) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const resource = await request(path, { profile });
    if (predicate(resource)) return resource;
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function uploadOrFindPolicy(fixture) {
  const policies = await request(
    `/v1/policies?domainPackId=${encodeURIComponent(fixture.domainPackId)}`,
    {
      profile: fixture.profile,
    },
  );
  const existing = policies.items.find(
    (candidate) =>
      candidate.title === fixture.title && candidate.policyVersion === fixture.policyVersion,
  );
  if (existing) return existing;

  const bytes = await readFile(resolve(root, fixture.file));
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'application/pdf' }), fixture.file.split('/').at(-1));
  form.set('title', fixture.title);
  form.set('policyVersion', fixture.policyVersion);
  form.set('collectionId', fixture.collectionId);
  form.set('domainPackId', fixture.domainPackId);
  form.set('language', 'en');
  form.set('validFrom', '2026-01-01');
  return request('/v1/policies', {
    profile: fixture.profile,
    method: 'POST',
    headers: { 'idempotency-key': `fixture-policy-${fixture.label}-v1` },
    body: form,
  });
}

async function activatePolicy(fixture) {
  const uploaded = await uploadOrFindPolicy(fixture);
  let policy = await waitFor(
    `/v1/policies/${uploaded.id}`,
    fixture.profile,
    (candidate) => ['under_review', 'approved', 'active'].includes(candidate.status),
    `${fixture.label} policy extraction`,
  );
  if (policy.status === 'active') return policy;
  for (const proposal of policy.proposals) {
    if (proposal.status === 'invalid') {
      throw new Error(
        `${fixture.label} policy has an invalid proposal: ${JSON.stringify(proposal.validationIssues)}`,
      );
    }
    if (['proposed', 'under_review'].includes(proposal.status)) {
      await request(`/v1/policies/${policy.id}/proposals/${proposal.id}`, {
        profile: fixture.profile,
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'approve',
          reason: 'Synthetic fixture proposal passed the cited rule validation suite.',
          version: proposal.version,
        }),
      });
    }
  }
  policy = await request(`/v1/policies/${policy.id}`, { profile: fixture.profile });
  if (policy.status !== 'active') {
    await request(`/v1/policies/${policy.id}/activate`, {
      profile: fixture.profile,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: policy.version, priority: 50 }),
    });
  }
  return waitFor(
    `/v1/policies/${policy.id}`,
    fixture.profile,
    (candidate) => candidate.status === 'active',
    `${fixture.label} policy activation`,
  );
}

async function runCase(fixture) {
  const job = await request(`/v1/cases/${fixture.caseId}/process`, {
    profile: fixture.profile,
    method: 'POST',
    headers: { 'idempotency-key': `fixture-case-${fixture.label}-evidence-v1` },
  });
  const completed = await waitFor(
    `/v1/jobs/${job.id}`,
    fixture.profile,
    (candidate) => ['completed', 'needs_review', 'failed', 'cancelled'].includes(candidate.status),
    `${fixture.label} case processing`,
  );
  if (!['completed', 'needs_review'].includes(completed.status)) {
    throw new Error(
      `${fixture.label} case did not finish successfully: ${JSON.stringify(completed)}`,
    );
  }
  return completed;
}

for (const fixture of fixtures) {
  const policy = await activatePolicy(fixture);
  console.log(`Activated ${fixture.label} policy ${policy.id}`);
}

const jobs = await Promise.all(fixtures.map(runCase));
console.log(
  JSON.stringify(
    { policies: fixtures.map((fixture) => fixture.label), jobs: jobs.map((job) => job.id) },
    null,
    2,
  ),
);
