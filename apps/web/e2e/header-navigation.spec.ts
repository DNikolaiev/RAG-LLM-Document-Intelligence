import { expect, test } from '@playwright/test';

import { expectHealthyLayout, monitorRuntimeFailures } from './support/ui-assertions';

const COLLAPSE_BREAKPOINT = 1180;

test.describe('header navigation', () => {
  test('keeps the links clear of the workspace context when they are inline', async ({
    page,
    viewport,
  }) => {
    test.skip(
      (viewport?.width ?? 0) <= COLLAPSE_BREAKPOINT,
      'The inline layout starts above 1180px',
    );
    await page.goto('/');

    // The navigation used to be positioned absolutely and centred on the header, so nothing
    // separated it from the workspace context - adding a third link simply grew into it.
    const clearance = await page.evaluate(() => {
      const nav = document.querySelector('.primary-navigation');
      const context = document.querySelector('.header-context');
      if (!nav || !context) return -1;
      return context.getBoundingClientRect().left - nav.getBoundingClientRect().right;
    });
    expect(clearance).toBeGreaterThanOrEqual(24);
  });

  test('collapses behind a toggle on narrow viewports', async ({ page, viewport }) => {
    test.skip(
      (viewport?.width ?? 0) > COLLAPSE_BREAKPOINT,
      'The collapsed layout starts at 1180px',
    );
    const failures = monitorRuntimeFailures(page);
    await page.goto('/');

    const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    await expect(navigation).toBeHidden();
    await expect(toggle).toBeVisible();

    await toggle.click();
    await expect(navigation).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close navigation' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    for (const label of ['Review queue', 'Policy library', 'Analytics']) {
      await expect(navigation.getByRole('link', { name: label })).toBeVisible();
    }

    // Escape closes it, because a panel covering the page with no visible way out is a trap.
    await page.keyboard.press('Escape');
    await expect(navigation).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Selecting a destination closes it too: on a phone the panel would otherwise sit over the page
    // it just navigated to, and nothing else would dismiss it.
    await toggle.click();
    await navigation.getByRole('link', { name: 'Policy library' }).click();
    await expect(page).toHaveURL(/\/policies$/);
    await expect(navigation).toBeHidden();

    await expectHealthyLayout(page);
    expect(failures).toEqual([]);
  });
});
