import { type Page } from '@playwright/test';

export async function bypassOnboarding(page: Page) {
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ codex: { installed: true, connected: true } })
  }));
  
  await page.route('**/api/v1/settings/schema', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      schema: {
        'test-setting': { label: 'Test Setting', type: 'boolean', default: false, category: 'General' },
        'another-setting': { label: 'Another Setting', type: 'number', default: 10, category: 'Advanced' }
      },
      profiles: {
        'local-cpu': { 'test-setting': false, 'another-setting': 10 }
      }
    })
  }));
  
  await page.route('**/api/v1/settings*', route => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ profile: 'local-cpu', values: { 'test-setting': false, 'another-setting': 10 } })
      });
    } else {
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ profile: 'local-cpu', values: JSON.parse(route.request().postData() || '{}').values })
      });
    }
  });

  await page.goto('/');

  const isSetup = await page.getByRole('button', { name: 'Skip', exact: true }).isVisible({ timeout: 3000 }).catch(() => false);
  if (isSetup) {
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.getByRole('button', { name: 'Skip for now' }).click();
  }
}
