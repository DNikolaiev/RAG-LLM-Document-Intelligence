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
