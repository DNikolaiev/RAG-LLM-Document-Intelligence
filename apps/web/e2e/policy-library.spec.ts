import { expect, test } from '@playwright/test';

import {
  expectHealthyLayout,
  expectNoRuntimeFailures,
  monitorRuntimeFailures,
} from './support/ui-assertions';

const registryFixture = {
  tenantId: 'tenant_demo',
  domainPack: {
    id: 'pack_tenant_demo',
    key: 'pharmacy-supplier',
    name: 'Pharmaceutical supplier qualification',
    version: '1.0.0',
    terminology: { case: 'case', subject: 'supplier', decision: 'decision' },
    collections: [
      { id: 'insurance', label: 'Insurance Requirements' },
      { id: 'data-protection', label: 'Data Protection Policy' },
      { id: 'distribution', label: 'Pharmaceutical Distribution Policy' },
    ],
    uploadableCollections: [
      { id: 'insurance', label: 'Insurance Requirements' },
      { id: 'data-protection', label: 'Data Protection Policy' },
      { id: 'distribution', label: 'Pharmaceutical Distribution Policy' },
    ],
    requiredDocuments: [
      {
        id: 'insurance-always',
        documentType: 'insurance_certificate',
        documentLabel: 'Liability insurance',
        severity: 'major',
        message: 'A liability insurance certificate is required.',
        conditional: false,
      },
    ],
    documentTypes: [
      {
        id: 'insurance_certificate',
        label: 'Liability insurance',
        description: 'Insurance certificate for the supplier.',
        fields: [
          {
            path: 'insurance.liabilityLimitEur',
            label: 'Liability limit',
            type: 'number',
            required: true,
            aliases: [],
          },
        ],
      },
    ],
    rules: [
      {
        id: 'insurance-minimum',
        title: 'Liability coverage below policy',
        description: 'Coverage must be at least EUR 2,000,000 per occurrence.',
        severity: 'major',
        collectionId: 'insurance',
        origin: {
          kind: 'domain_pack',
          domainPackName: 'Pharmaceutical supplier qualification',
          domainPackVersion: '1.0.0',
        },
      },
      {
        id: 'rule_from_policy',
        title: 'Minimum product liability cover',
        description: 'Flag suppliers whose cover is below the required minimum.',
        severity: 'critical',
        collectionId: 'insurance',
        origin: {
          kind: 'policy_document',
          policyId: 'policy-registry-fixture',
          policyTitle: 'Supplier insurance requirements',
          policyVersion: '2026.1',
        },
      },
      {
        id: 'dpa-unsigned',
        title: 'Data processing agreement unsigned',
        description: 'The data processing agreement must be signed by both parties.',
        severity: 'major',
        collectionId: 'data-protection',
        origin: {
          kind: 'domain_pack',
          domainPackName: 'Pharmaceutical supplier qualification',
          domainPackVersion: '1.0.0',
        },
      },
    ],
  },
};

const legalRegistryFixture = {
  tenantId: 'tenant_legal',
  domainPack: {
    id: 'pack_tenant_legal',
    key: 'commercial-contract-review',
    name: 'Commercial contract review',
    version: '2.4.0',
    terminology: { case: 'matter', subject: 'counterparty', decision: 'decision' },
    collections: [{ id: 'commercial-contract-review-policy', label: 'Commercial contract policy' }],
    uploadableCollections: [
      { id: 'commercial-contract-review-policy', label: 'Commercial contract policy' },
    ],
    requiredDocuments: [
      {
        id: 'signed-contract',
        documentType: 'contract',
        documentLabel: 'Signed contract',
        severity: 'major',
        message: 'A countersigned contract is required.',
        conditional: false,
      },
    ],
    documentTypes: [
      {
        id: 'contract',
        label: 'Signed contract',
        description: 'The executed commercial agreement.',
        fields: [
          {
            path: 'contract.terminationNoticeDays',
            label: 'Termination notice',
            type: 'number',
            required: true,
            aliases: [],
          },
        ],
      },
    ],
    rules: [
      {
        id: 'termination-notice',
        title: 'Termination notice period too short',
        description: 'Termination requires at least three months of written notice.',
        severity: 'major',
        collectionId: 'commercial-contract-review-policy',
        origin: {
          kind: 'domain_pack',
          domainPackName: 'Commercial contract review',
          domainPackVersion: '2.4.0',
        },
      },
    ],
  },
};

/**
 * The registry's display grouping and the uploadable list are different things. This fixture is
 * the case that proves it: `general-controls` is a synthetic bucket the API appends so pack rules
 * that declare no collection have somewhere to be shown, and it is not in the pack's
 * `policyCollections` - so uploading into it would always be refused.
 */
const syntheticCollectionFixture = {
  ...registryFixture,
  domainPack: {
    ...registryFixture.domainPack,
    collections: [
      ...registryFixture.domainPack.collections,
      { id: 'general-controls', label: 'General controls' },
    ],
  },
};

const fieldProposalsFixture = {
  items: [
    {
      id: 'fp_new_field',
      tenantId: 'tenant_demo',
      domainPackId: 'pack_tenant_demo',
      policyDocumentId: 'policy-registry-fixture',
      kind: 'new_field',
      documentTypeId: 'insurance_certificate',
      path: 'insurance.deductibleEur',
      label: 'Deductible amount',
      fieldType: 'currency',
      aliases: ['excess amount'],
      citation: {
        chunkId: 'chunk_deductible',
        page: 4,
        quote: 'The policyholder bears a deductible of the stated amount per occurrence.',
      },
      dedup: {
        verdict: 'distinct',
        matchedPath: null,
        similarity: null,
        reason: 'No existing field was recalled for this wording.',
      },
      status: 'proposed',
      issues: [],
    },
    {
      id: 'fp_alias',
      tenantId: 'tenant_demo',
      domainPackId: 'pack_tenant_demo',
      policyDocumentId: 'policy-registry-fixture',
      kind: 'alias',
      documentTypeId: 'insurance_certificate',
      path: 'insurance.liabilityLimitEur',
      label: 'Liability limit',
      fieldType: 'number',
      aliases: ['cover amount'],
      citation: {
        chunkId: 'chunk_cover_amount',
        page: 6,
        quote: 'The cover amount must not fall below the minimum required limit.',
      },
      dedup: {
        verdict: 'duplicate',
        matchedPath: 'insurance.liabilityLimitEur',
        similarity: 0.82,
        reason: 'Both describe the maximum insurer payout per occurrence.',
      },
      status: 'proposed',
      issues: [],
    },
  ],
};

test('policy library explains what conditions can become governed rules', async ({ page }) => {
  const failures = monitorRuntimeFailures(page);
  const response = await page.goto('/policies');

  expect(response?.ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'What can become a rule' })).toBeVisible();
  await expect(
    page.getByText('Exact PDF citation + four deterministic checks are required before approval.'),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Supported policy condition categories' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What a policy may become' })).toBeVisible();
  const domainPack = page.getByTestId('domain-pack-configuration');
  await expect(domainPack.getByText(/Pharmaceutical supplier qualification/).first()).toBeVisible();

  await expect(domainPack.getByRole('heading', { name: 'Rule registry' })).toBeVisible();
  await expect(
    domainPack.getByText('Liability coverage below policy', { exact: true }),
  ).toBeVisible();
  await expect(domainPack.getByText('SYSTEM DEFAULT', { exact: true }).first()).toBeVisible();
  await expect(
    domainPack.getByRole('region', { name: 'Insurance Requirements rules' }),
  ).toBeVisible();

  const evidenceGates = domainPack.locator('.domain-evidence-gates');
  const factVocabulary = domainPack.locator('.domain-fact-vocabulary');
  await expect(evidenceGates).not.toHaveAttribute('open', '');
  await expect(factVocabulary).not.toHaveAttribute('open', '');
  await expect(page.getByText('Evidence gates', { exact: true })).toBeVisible();
  await expect(page.getByText('Fact vocabulary', { exact: true })).toBeVisible();

  await evidenceGates.locator('summary').click();
  await expect(evidenceGates).toHaveAttribute('open', '');
  await expect(evidenceGates.getByText('Liability insurance', { exact: true })).toBeVisible();

  await factVocabulary.locator('summary').click();
  await expect(factVocabulary).toHaveAttribute('open', '');
  await expect(factVocabulary.getByText('Supplier questionnaire', { exact: true })).toBeVisible();

  await expect(page.getByText('Time & limits', { exact: true })).toBeVisible();
  await expect(page.getByText('Combinations', { exact: true })).toBeVisible();
  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});

test('rule registry groups rules by collection and names each origin', async ({ page }) => {
  const failures = monitorRuntimeFailures(page);
  await page.route(
    (url) => url.pathname === '/api/policies/domain-pack',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(registryFixture),
      });
    },
  );

  const response = await page.goto('/policies');
  expect(response?.ok()).toBe(true);

  const domainPack = page.getByTestId('domain-pack-configuration');
  await expect(domainPack.getByRole('heading', { name: 'Rule registry' })).toBeVisible();
  await expect(domainPack.getByText('3 active rules in 3 collections.')).toBeVisible();

  const insurance = domainPack.getByRole('region', { name: 'Insurance Requirements rules' });
  const dataProtection = domainPack.getByRole('region', { name: 'Data Protection Policy rules' });
  await expect(insurance).toBeVisible();
  await expect(dataProtection).toBeVisible();
  await expect(insurance.getByText('2 rules', { exact: true })).toBeVisible();
  await expect(dataProtection.getByText('1 rule', { exact: true })).toBeVisible();

  // A collection a policy can still be uploaded into stays visible with an explicit empty state.
  const distribution = domainPack.getByRole('region', {
    name: 'Pharmaceutical Distribution Policy rules',
  });
  await expect(distribution).toBeVisible();
  await expect(distribution.getByText('0 rules', { exact: true })).toBeVisible();
  await expect(distribution.getByText(/No rules yet/)).toBeVisible();

  const systemBadges = domainPack.getByText('SYSTEM DEFAULT', { exact: true });
  const policyBadges = domainPack.getByText('FROM POLICY REGISTER', { exact: true });
  await expect(systemBadges).toHaveCount(2);
  await expect(policyBadges).toHaveCount(1);
  await expect(systemBadges.first()).toBeVisible();
  await expect(policyBadges.first()).toBeVisible();

  await expect(
    insurance.getByText('Pharmaceutical supplier qualification v1.0.0', { exact: true }),
  ).toBeVisible();
  const policySource = insurance.getByRole('link', {
    name: 'Supplier insurance requirements · 2026.1',
  });
  await expect(policySource).toBeVisible();
  await expect(policySource).toHaveAttribute('href', '/policies/policy-registry-fixture');

  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});

test('field proposal queue names an alias match and approving removes it from view', async ({
  page,
}) => {
  const failures = monitorRuntimeFailures(page);
  await page.route(
    (url) => url.pathname === '/api/policies/domain-pack',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(registryFixture),
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/policies/field-proposals',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fieldProposalsFixture),
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/policies/field-proposals/fp_alias/approve',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ semanticVersion: '1.1.0' }),
      });
    },
  );

  const response = await page.goto('/policies');
  expect(response?.ok()).toBe(true);

  const domainPack = page.getByTestId('domain-pack-configuration');
  const evidenceGates = domainPack.locator('.domain-evidence-gates');
  const factVocabulary = domainPack.locator('.domain-fact-vocabulary');
  await expect(evidenceGates).not.toHaveAttribute('open', '');
  await expect(factVocabulary).not.toHaveAttribute('open', '');

  await factVocabulary.locator('summary').click();
  await expect(factVocabulary).toHaveAttribute('open', '');

  // The plain new-field proposal renders with its own path and type.
  const newFieldCard = factVocabulary.locator('.field-proposal-card', {
    hasText: 'Deductible amount',
  });
  await expect(newFieldCard).toBeVisible();
  await expect(newFieldCard.locator('.field-proposal-path code')).toHaveText(
    'insurance.deductibleEur',
  );

  // The alias proposal must name the existing field it merges into and the similarity that
  // drove the dedup verdict — the single most important thing a reviewer judges.
  const aliasCard = factVocabulary.locator('.field-proposal-card', {
    hasText: 'New wording for Liability limit',
  });
  await expect(aliasCard).toBeVisible();
  const mergeNote = aliasCard.locator('.field-proposal-merge');
  await expect(mergeNote).toContainText('Merges into');
  await expect(mergeNote).toContainText('insurance.liabilityLimitEur');
  await expect(mergeNote).toContainText('82% similarity match');
  await expect(aliasCard.locator('.domain-origin-pending')).toHaveText('AWAITING GOVERNANCE');

  await aliasCard.getByRole('button', { name: 'Approve merge' }).click();
  await expect(aliasCard).toHaveCount(0);
  // The rest of the queue, and the approved catalog below it, are unaffected.
  await expect(newFieldCard).toBeVisible();

  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});

test('a single-workspace profile reads its workspace as a label, not a dropdown', async ({
  page,
}) => {
  const failures = monitorRuntimeFailures(page);
  await page.route(
    (url) => url.pathname === '/api/policies/domain-pack',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(registryFixture),
      });
    },
  );

  const response = await page.goto('/policies');
  expect(response?.ok()).toBe(true);

  // The workspace heads the panel every other section is scoped by, with the pack it resolves to
  // as the supporting line beside it.
  const identity = page.getByTestId('workspace-switcher');
  await expect(identity).toContainText('Workspace');
  await expect(identity).toContainText('Düsseldorf Health Operations');
  await expect(identity).toContainText('Pharmaceutical supplier qualification · v1.0.0');

  // The default profile owns exactly one workspace, so there is nothing to choose.
  await expect(identity.getByRole('combobox')).toHaveCount(0);

  // The upload form states where the upload lands instead of asking for the workspace again.
  const uploadCard = page.locator('.policy-upload-card');
  await expect(uploadCard.getByText(/Uploading into/)).toContainText(
    'Düsseldorf Health Operations',
  );
  await expect(uploadCard.getByLabel('Workspace')).toHaveCount(0);
  await expect(uploadCard.getByRole('button', { name: 'Upload and process' })).toBeEnabled();

  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});

test('a multi-workspace profile re-scopes the library from the panel switcher', async ({
  page,
}) => {
  const failures = monitorRuntimeFailures(page);
  const profileResponse = await page.request.post('/api/session/profile', {
    data: { profileId: 'profile_mara_stein' },
  });
  expect(profileResponse.ok()).toBe(true);

  await page.route(
    (url) => url.pathname === '/api/policies/domain-pack',
    async (route) => {
      const tenantId = new URL(route.request().url()).searchParams.get('tenantId');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(tenantId === 'tenant_legal' ? legalRegistryFixture : registryFixture),
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/policies/field-proposals',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    },
  );

  const response = await page.goto('/policies');
  expect(response?.ok()).toBe(true);

  const identity = page.getByTestId('workspace-switcher');
  const switcher = identity.getByRole('combobox', { name: /select the workspace/i });
  await expect(switcher).toBeVisible();
  await expect(switcher).toHaveValue('tenant_demo');
  await expect(identity).toContainText('Pharmaceutical supplier qualification · v1.0.0');

  const domainPack = page.getByTestId('domain-pack-configuration');
  await expect(
    domainPack.getByText('Liability coverage below policy', { exact: true }),
  ).toBeVisible();

  await switcher.selectOption('tenant_legal');

  // Selecting a workspace re-scopes the panel, not just the label above it.
  await expect(switcher).toHaveValue('tenant_legal');
  await expect(identity).toContainText('Commercial contract review · v2.4.0');
  await expect(
    domainPack.getByText('Termination notice period too short', { exact: true }),
  ).toBeVisible();
  await expect(
    domainPack.getByText('Liability coverage below policy', { exact: true }),
  ).toHaveCount(0);
  await expect(
    domainPack.getByRole('region', { name: 'Commercial contract policy rules' }),
  ).toBeVisible();

  // The upload form follows the page-level selection instead of keeping its own.
  await expect(page.locator('.policy-upload-card').getByText(/Uploading into/)).toContainText(
    'Rheinland Legal Services',
  );

  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});

test('the upload form offers the workspace collections and never the synthetic one', async ({
  page,
}) => {
  const failures = monitorRuntimeFailures(page);
  await page.route(
    (url) => url.pathname === '/api/policies/domain-pack',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(syntheticCollectionFixture),
      });
    },
  );

  const response = await page.goto('/policies');
  expect(response?.ok()).toBe(true);

  const uploadCard = page.locator('.policy-upload-card');
  const collection = uploadCard.getByLabel('Collection', { exact: true });
  await expect(collection).toBeEnabled();

  // Exactly the pack's own collections, in pack order, plus the one explicit create action.
  await expect(collection.locator('option')).toHaveText([
    'Insurance Requirements',
    'Data Protection Policy',
    'Pharmaceutical Distribution Policy',
    'Create a new collection…',
  ]);
  await expect(collection).toHaveValue('insurance');

  // `general-controls` heads a group in the registry above, and must still not be offered here.
  await expect(
    page.getByTestId('domain-pack-configuration').getByRole('region', {
      name: 'General controls rules',
    }),
  ).toBeVisible();
  await expect(collection.locator('option[value="general-controls"]')).toHaveCount(0);

  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});

test('naming a new collection is an explicit choice that reveals a labelled field', async ({
  page,
}) => {
  const failures = monitorRuntimeFailures(page);
  await page.route(
    (url) => url.pathname === '/api/policies/domain-pack',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(registryFixture),
      });
    },
  );

  const response = await page.goto('/policies');
  expect(response?.ok()).toBe(true);

  const uploadCard = page.locator('.policy-upload-card');
  const collection = uploadCard.getByLabel('Collection', { exact: true });
  await expect(collection).toBeEnabled();
  await expect(uploadCard.getByLabel('New collection name')).toHaveCount(0);

  await collection.selectOption('__create__');

  const name = uploadCard.getByLabel('New collection name');
  await expect(name).toBeVisible();
  await expect(name).toBeEditable();
  await name.fill('Product recall handling');
  await expect(name).toHaveValue('Product recall handling');

  // The reveal has to hold its own at this width, so the layout is checked while it is open.
  await expectHealthyLayout(page);

  // Choosing an existing collection again puts it away.
  await collection.selectOption('data-protection');
  await expect(uploadCard.getByLabel('New collection name')).toHaveCount(0);

  await expectHealthyLayout(page);
  expectNoRuntimeFailures(failures);
});
