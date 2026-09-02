# Policy Rule Recognition Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert enforceable policy text into a typed, reviewable rule with deterministic test cases, reject incomplete generated tests, and let an administrator safely regenerate a policy's proposals.

**Architecture:** The model remains responsible for proposing an allowlisted condition and exact source citation. The worker compiles the condition into a canonical test matrix, validates that numeric wording in a citation is represented by a numeric predicate, and persists only the evaluated canonical tests. The API adds an idempotent reprocess operation; the review page renders rule meaning and test values as compliance evidence rather than developer diagnostics.

**Tech Stack:** Next.js/React, NestJS, TypeScript, Zod, Vitest, Playwright, PostgreSQL, BullMQ, MinIO, Ollama-compatible structured generation.

**Spec:** User request in the current CaseLens Codex task; architecture reference: `docs/ARCHITECTURE.md`.

## Global Constraints

- Preserve original policy PDFs, citations, documents, findings, and approved rules.
- Never activate or approve an invalid proposal.
- Use only fact paths defined by the selected domain pack.
- Treat model output as untrusted; all executable behavior and expected test outcomes are deterministic.
- Keep tenant scope and administrator authorization unchanged.
- Rebuild only the local Docker services affected by code changes and verify the production-local stack.

---

### Task 1: Define canonical policy-rule tests and numeric-clause validation

**Files:**

- Modify: `packages/domain/src/policies/governance.ts`
- Modify: `packages/domain/test/policy-governance.test.ts`
- Create: `packages/domain/src/policies/canonical-tests.ts`
- Test: `packages/domain/test/policy-governance.test.ts`

**Interfaces:**

- Consumes: `Condition`, `PolicyRuleProposal`, and the domain-pack fact catalog.
- Produces: `buildCanonicalRuleTests(condition: Condition): PolicyRuleTestCase[]` and `validateCitationRequirementCoverage(condition, citations, catalog): ProposalValidationIssue[]`.

- [ ] **Step 1: Add a failing numeric-threshold test**

```ts
it('creates a truthful boundary matrix for a minimum currency rule', () => {
  const tests = buildCanonicalRuleTests({
    operator: 'all',
    conditions: [
      { operator: 'exists', path: 'facts.insurance.liabilityLimitEur', value: true },
      { operator: 'lte', path: 'facts.insurance.liabilityLimitEur', value: 1_999_999.99 },
    ],
  });
  expect(tests).toContainEqual(
    expect.objectContaining({
      kind: 'boundary',
      input: { facts: { insurance: { liabilityLimitEur: 1_999_999.99 } } },
      expected: true,
    }),
  );
  expect(tests.find((test) => test.kind === 'no_match')?.expected).toBe(false);
});
```

- [ ] **Step 2: Run the targeted test**

Run: `npm run test --workspace=@caselens/domain -- policy-governance.test.ts`

Expected: FAIL because `buildCanonicalRuleTests` does not exist.

- [ ] **Step 3: Implement canonical tests and clause coverage validation**

```ts
export function buildCanonicalRuleTests(condition: Condition): PolicyRuleTestCase[] {
  // Build match/no-match/missing-value/boundary cases from predicate paths and values.
  // For an lte currency predicate of 1_999_999.99, use that value as the matching boundary
  // and the next cent (2_000_000) as the non-matching value.
}
```

`validateCitationRequirementCoverage` must detect wording such as `at least EUR 2,000,000` or `minimum ... EUR 2,000,000` in an exact citation. It must return `numeric_requirement_missing` unless the condition contains a comparison predicate for the cited currency fact; it must never manufacture a new fact path.

- [ ] **Step 4: Replace model-supplied test cases during proposal validation**

Reject a proposal if a persisted test input does not contain a nested value for every fact it claims to exercise. Retain the four test categories as an audit requirement, but compare them with the canonical cases, not model-authored expected values.

- [ ] **Step 5: Run domain regression tests**

Run: `npm run test --workspace=@caselens/domain -- policy-governance.test.ts`

Expected: PASS, including a rejection for an existence-only rule cited from a numeric minimum clause and a rejection for `propertyNames`-only input.

### Task 2: Harden worker proposal generation

**Files:**

- Modify: `apps/worker/src/policy/policy-pipeline.ts`
- Modify: `apps/worker/test/policy-pipeline.test.ts`
- Test: `apps/worker/test/policy-pipeline.test.ts`

**Interfaces:**

- Consumes: canonical tests and citation validation from Task 1.
- Produces: persisted proposal tests whose `input`, `expected`, and `actual` are generated from the compiled condition.

- [ ] **Step 1: Add a failing worker fixture**

```ts
const modelOutput = {
  proposals: [
    {
      title: 'Minimum cover',
      when: { operator: 'exists', path: 'facts.insurance.liabilityLimitEur', value: true },
      citations: [{ chunkId: 'chunk_insurance', page: 1, quote: '... at least EUR 2,000,000 ...' }],
      tests: [
        {
          kind: 'match',
          name: 'coverage exists',
          input: { propertyNames: ['facts.insurance.liabilityLimitEur'] },
          expected: true,
        },
      ],
    },
  ],
};
expect(result[0]?.proposal.validationIssues).toContainEqual(
  expect.objectContaining({ code: 'numeric_requirement_missing' }),
);
```

- [ ] **Step 2: Run the worker test**

Run: `npm run test --workspace=@caselens/worker -- policy-pipeline.test.ts`

Expected: FAIL because generated test payloads are still copied into storage.

- [ ] **Step 3: Narrow the model output contract**

Keep `tests` out of the structured generation schema. Update the model instruction to require the full numeric comparator for a numerical requirement and to return no proposal if no allowlisted fact path can represent the requirement.

- [ ] **Step 4: Persist canonical tests and explicit validation issues**

```ts
const tests = buildCanonicalRuleTests(proposal.when);
const issues = [
  ...validateRuleProposal({ ...candidate, tests }, input.pack).issues,
  ...validateCitationRequirementCoverage(proposal.when, candidate.citations, input.pack),
  ...citationIssues,
];
```

Evaluate `actual` using each canonical test input. No model-provided test input or expected result may be persisted.

- [ ] **Step 5: Run worker tests**

Run: `npm run test --workspace=@caselens/worker -- policy-pipeline.test.ts`

Expected: PASS, with a valid €2m rule producing €1m / €1,999,999.99 / €2m / missing-value cases.

### Task 3: Add safe policy regeneration

**Files:**

- Modify: `apps/api/src/policies/policies.controller.ts`
- Modify: `apps/api/src/policies/policies.service.ts`
- Modify: `packages/persistence/src/policy-store.ts`
- Modify: `apps/api/test/policies.service.test.ts` or the existing policy service test file
- Test: API policy reprocess tests

**Interfaces:**

- Consumes: existing policy storage record and `process_policy` BullMQ payload.
- Produces: `POST /v1/policies/:id/reprocess`, restricted to administrators, which creates one fresh job and replaces only unapproved proposals after processing.

- [ ] **Step 1: Add a failing reprocess service test**

```ts
await expect(service.reprocess(adminContext, policyId, 'repair-001')).resolves.toMatchObject({
  policyId,
  jobId: expect.any(String),
});
expect(queue.enqueue).toHaveBeenCalledWith(
  'process_policy',
  expect.objectContaining({ policyDocumentId: policyId }),
  expect.anything(),
);
```

- [ ] **Step 2: Implement the service and route**

Require an administrator, reject active/revoked policies, create a fresh idempotent `process_policy` job, update the policy status to `processing`, then enqueue it. Reuse the original MinIO object; do not upload or duplicate the source PDF.

- [ ] **Step 3: Preserve approved rules**

Extend `replaceProcessingOutput` to refuse a reprocess when an approved or activated proposal exists. For a policy under review, delete and replace only its proposal tests, citations, proposals, chunks, pages, and embeddings in one transaction.

- [ ] **Step 4: Run API and persistence tests**

Run: `npm run test --workspace=@caselens/api -- policies.service.test.ts` and `npm run test:integration:database`

Expected: PASS; reprocessing never crosses tenant boundaries and never overwrites active rules.

### Task 4: Make policy review self-explanatory

**Files:**

- Modify: `apps/web/components/policy/policy-review-workspace.tsx`
- Modify: `apps/web/app/foundation.css`
- Modify: `apps/web/e2e/policy-review.spec.ts`
- Test: `apps/web/e2e/policy-review.spec.ts`

**Interfaces:**

- Consumes: proposal condition and canonical `input`, `expected`, `actual`, and `passed` test values.
- Produces: readable rule logic, concrete test evidence, and a regenerate action for eligible invalid proposals.

- [ ] **Step 1: Add browser assertions for readable tests**

```ts
await expect(page.getByText('When liability cover is below €2,000,000')).toBeVisible();
await expect(page.getByText('Test value: €1,999,999.99')).toBeVisible();
await expect(page.getByText('Expected: flag this case')).toBeVisible();
```

- [ ] **Step 2: Render a plain-language condition summary**

For the currency minimum rule, display: `Flag when liability cover is below €2,000,000.` Keep structured JSON in a collapsed technical-details disclosure for auditability.

- [ ] **Step 3: Render test input and verdict separately**

Show `Test value`, `Expected result`, and `Observed result` in every test card. Replace ambiguous labels such as `Match` and `Boundary` with their scenario meaning while retaining the category as a small audit tag.

- [ ] **Step 4: Add regenerate proposal interaction**

For an invalid, non-active policy, show `Regenerate rules from this policy`. Disable it while the request is pending; announce the queued job in the existing status message.

- [ ] **Step 5: Run UI checks**

Run: `npm run test:e2e -- apps/web/e2e/policy-review.spec.ts --reporter=line`

Expected: PASS at desktop and mobile sizes, with no horizontal overflow and a visible, clickable regenerate action.

### Task 5: Reprocess and verify the affected insurance policy

**Files:**

- Modify: `README.md`
- Test: local production API, worker, and browser view

**Interfaces:**

- Consumes: the production-local policy `policy_60b5408f60449744336ed329` and the Task 3 endpoint.
- Produces: a fresh, auditable proposal set or an explicit blocked reason that tells the administrator which unsupported fact is missing.

- [ ] **Step 1: Build and restart API, worker, and web**

Run: `docker compose --env-file infra/.env.production-local -f infra/docker-compose.production-local.yml build api worker web`

Expected: all images build successfully.

- [ ] **Step 2: Requeue the insurance policy as the tenant administrator**

Call `POST /v1/policies/policy_60b5408f60449744336ed329/reprocess` with the tenant-demo administrator profile and a fresh idempotency key.

- [ ] **Step 3: Verify output**

Confirm the new proposal either has the canonical €1m / €1,999,999.99 / €2m / missing matrix and is reviewable, or is explicitly blocked because the domain fact catalog cannot model a requirement. Confirm the exact source citation still highlights page 1.

- [ ] **Step 4: Document the safeguard**

Add a short README note: model output proposes conditions and citations; CaseLens generates and evaluates test cases deterministically before any rule may be approved.

## Review Checklist

- Policy wording, fact path, comparator, and canonical tests agree.
- A numeric requirement cannot become an existence-only proposal.
- `propertyNames` metadata cannot pass as a rule-test input.
- Reprocessing retains the original PDF and cannot alter active/approved rules.
- The UI tells an administrator what was tested, with which value, and why the result passed or failed.
- Targeted unit, API, and desktop/mobile browser tests pass.
