# Generic Policy Condition Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every supported policy condition receive deterministic, explainable rule tests while keeping unsupported or uncited suggestions blocked.

**Architecture:** The model continues to propose a typed condition and exact source citation. The worker derives a satisfying witness and a counterexample from the condition tree, then writes match, no-match, missing-value, and boundary tests itself. The Policy Library states this contract in plain language so administrators know what can become an approved rule.

**Tech Stack:** TypeScript, Zod condition schema, Nest worker, Vitest, Next.js, Playwright.

**Spec:** `docs/superpowers/plans/2026-08-31-policy-rule-recognition-correction.md`

## Global Constraints

- Never trust model-supplied test data or expected results.
- Keep exact-citation and domain-fact validation as blocking gates.
- A condition must evaluate true for its match witness and false for its counterexample before tests are persisted.
- Preserve the existing `Condition` schema and rule evaluator; no database migration is required.
- Explain support in user language, not implementation vocabulary.

---

### Task 1: Generalize deterministic condition witnesses

**Files:**

- Modify: `apps/worker/src/policy/policy-pipeline.ts`
- Test: `apps/worker/test/policy-pipeline.test.ts`

**Interfaces:**

- Consumes: `Condition` and `evaluateCondition` from `@caselens/domain`.
- Produces: `buildCanonicalRuleTests(condition): PolicyRuleProposal['tests']` for `exists`, equality, membership, containment, numeric, date, and nested `all`/`any`/`not` conditions.

- [ ] **Step 1: Add failing tests for non-numeric rules**

```ts
expect(proposal.tests).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ kind: 'match', actual: true }),
    expect.objectContaining({ kind: 'no_match', actual: false }),
    expect.objectContaining({ kind: 'missing_value' }),
    expect.objectContaining({ kind: 'boundary' }),
  ]),
);
```

Cover an `exists: false` condition, a string equality condition, a date condition, and an `any` condition using only fields in `pharmacySupplierPack`.

- [ ] **Step 2: Run the focused test before the implementation**

Run: `npm run test --workspace=@caselens/worker -- policy-pipeline.test.ts`

Expected: the existence-only proposal is invalid because no tests are generated.

- [ ] **Step 3: Build a true witness and false counterexample for each condition tree**

```ts
function buildWitness(condition: Condition): Record<string, unknown> | null;
function buildCounterexample(condition: Condition): Record<string, unknown> | null;
```

Use present/absent values for `exists`, different/equal values for `eq`/`neq`, out-of-set values for `in`, absent content for `contains`, comparison-edge values for numeric and date operators, and recursive composition for `all`, `any`, and `not`.

- [ ] **Step 4: Create the four canonical tests from witnesses**

Create `match` from the true witness, `no_match` from the false counterexample, `missing_value` by omitting a referenced field from the true witness, and `boundary` by using the selected predicate’s comparison value or representative presence value. Evaluate each input with `evaluateCondition`; never hard-code its actual result.

- [ ] **Step 5: Run the worker test suite**

Run: `npm run test --workspace=@caselens/worker -- policy-pipeline.test.ts`

Expected: all proposals with valid citations and supported conditions are `proposed` and persist four passing tests.

### Task 2: State the policy-library contract

**Files:**

- Modify: `apps/web/components/policy/policy-library.tsx`
- Modify: `apps/web/app/policies/policies.css`
- Test: `apps/web/e2e/policy-review.spec.ts`

**Interfaces:**

- Consumes: the Policy Library client component and existing `policy-*` styling tokens.
- Produces: an accessible, responsive explanation of supported rules and the evidence/testing gates.

- [ ] **Step 1: Add a concise "What can become a rule" panel**

State that the system parses presence, values, dates, amounts, allowed values, text/list checks, and combinations. State that every candidate needs an exact PDF citation and deterministic test cases before it can be approved.

- [ ] **Step 2: Add compact responsive styling**

Use the existing blue/teal evidence visual language, a semantic list, and no decorative animation. Ensure the panel wraps cleanly below the hero at mobile widths.

- [ ] **Step 3: Extend browser coverage**

```ts
await expect(page.getByRole('heading', { name: 'What can become a rule' })).toBeVisible();
await expect(page.getByText(/Exact PDF citation/)).toBeVisible();
```

- [ ] **Step 4: Run the targeted browser test**

Run: `npm run test:e2e -- policy-review.spec.ts`

Expected: desktop and mobile browser projects pass layout and runtime checks.

### Task 3: Ground cross-document identity rules in real facts

**Files:**

- Modify: `packages/domain/src/pharmacy-supplier.ts`
- Modify: `packages/domain/src/policies/governance.ts`
- Modify: `apps/worker/src/policy/policy-pipeline.ts`
- Modify: `apps/worker/src/production-runtime.ts`
- Test: `apps/worker/test/policy-pipeline.test.ts`

**Interfaces:**

- Consumes: insurance-certificate fields, domain reconciliation configuration, and exact policy citations.
- Produces: `facts.insurance.insuredLegalName`, `facts.insurance.validUntil`, `reconciliation.supplierLegalNameConflict`, and a blocking issue when a condition’s configured field is not grounded in its cited text.

- [ ] **Step 1: Add insurance identity and validity fields**

Add `insurance.insuredLegalName` (string) and `insurance.validUntil` (date) to the pharmacy insurance-certificate extraction schema. Include the insured-name fact in legal-name reconciliation.

- [ ] **Step 2: Expose reconciliation conflicts as governed boolean facts**

Derive a `reconciliation.<canonical path in camel case>Conflict` boolean for each configured reconciliation rule. Use the same derived fact list for model prompting and proposal validation.

- [ ] **Step 3: Perform production reconciliation from extracted evidence**

Build typed candidates from configured paths and their fact evidence, normalize with the configured reconciliation mode, and pass the resulting conflict into the workflow’s evaluation context.

- [ ] **Step 4: Reject ungrounded or too-weak conditions**

Require a condition field’s label or alias to occur in its exact citation. Reject an existence-only condition when the cited clause requires a comparison, date, threshold, or identity match.

- [ ] **Step 5: Add focused policy-pipeline assertions**

Assert that an ISO date condition cited from a name-matching clause is invalid, while a `reconciliation.supplierLegalNameConflict === true` condition cited from that clause is proposed and receives four passing tests.

### Task 4: Verify integrated behaviour

**Files:**

- Modify: no additional production files expected.

- [ ] **Step 1: Type-check the workspace**

Run: `npm run typecheck && npm run test:e2e:typecheck`

Expected: no TypeScript errors.

- [ ] **Step 2: Verify formatting and affected tests**

Run: `npm exec prettier -- --check apps/worker/src/policy/policy-pipeline.ts apps/worker/test/policy-pipeline.test.ts apps/web/components/policy/policy-library.tsx apps/web/app/policies/policies.css`

Expected: all files are formatted.

- [ ] **Step 3: Build and restart local production containers**

Run: `docker compose --progress quiet --env-file infra/.env.production-local -f infra/docker-compose.production-local.yml build worker web` then recreate those services.

Expected: policy processing and the Policy Library use the new behavior locally.

## Self-Review

- Spec coverage: generic test synthesis is Task 1; the administrator-facing rule contract is Task 2; test and container verification is Task 3.
- Placeholder scan: no unresolved implementation or test instructions remain.
- Type consistency: Task 1 uses the existing `Condition` and `PolicyRuleProposal['tests']` types; Task 2 only adds UI around existing Policy Library inputs.
