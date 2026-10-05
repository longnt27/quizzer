import { expect, test } from '@playwright/test';

test('production daemon serves the built PWA and establishes browser API auth', async ({ page }) => {
  const unauthenticated = await page.goto('/api/v1/health');
  expect(unauthenticated?.status()).toBe(401);

  const root = await page.goto('/');
  expect(root?.status()).toBe(200);
  expect(await root?.headerValue('content-type')).toContain('text/html');
  const setCookie = await root?.headerValue('set-cookie');
  expect(setCookie).toContain('quizzer_session=');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Strict');

  await expect(page).toHaveTitle('Quizzer');
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 15_000 });

  const authenticatedHealth = await page.evaluate(async () => {
    const response = await fetch('/api/v1/health');
    return {
      status: response.status,
      body: await response.json(),
      visibleCookies: document.cookie,
    };
  });
  expect(authenticatedHealth.status).toBe(200);
  expect(authenticatedHealth.body).toMatchObject({ ok: true, version: 1 });
  expect(authenticatedHealth.visibleCookies).not.toContain('quizzer_session=');

  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()['content-type']).toContain('application/manifest+json');

  const serviceWorker = await page.request.get('/sw.js');
  expect(serviceWorker.status()).toBe(200);
  expect(serviceWorker.headers()['service-worker-allowed']).toBe('/');
});
