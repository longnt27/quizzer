import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './helpers';

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
  expect(await root?.headerValue('cache-control')).toContain('no-store');

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

test('production daemon rejects rebound hosts and cross-origin browser sessions', async ({ page }) => {
  for (const path of ['/', '/index.html', '/api/v1/health']) {
    const response = await page.request.get(path, { headers: { Host: 'untrusted.example:8787' } });
    expect(response.status()).toBe(403);
    expect(response.headers()['set-cookie']).toBeUndefined();
  }
  await page.goto('/');
  const response = await page.request.get('/api/v1/health', { headers: { Origin: 'http://127.0.0.1:1234' } });
  expect(response.status()).toBe(401);
});

const studyPdf = () => {
  const stream = 'BT /F1 18 Tf 50 700 Td (A local PDF study guide.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
};

test('production PDF import loads the emitted module worker and saves readable text', async ({ page }) => {
  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'Add documents' }).last().click();
  const dialog = page.getByRole('dialog', { name: 'Add documents' });
  const workerResponse = page.waitForResponse(response => /\/assets\/pdf\.worker.*\.mjs$/.test(new URL(response.url()).pathname));
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'production-study-guide.pdf', mimeType: 'application/pdf', buffer: studyPdf(),
  });
  const worker = await workerResponse;
  expect(worker.status()).toBe(200);
  expect(worker.headers()['content-type']).toContain('text/javascript');
  await expect(dialog.getByText('ready', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Add to library' }).click();
  await expect(page.locator('.document-view').getByText('A local PDF study guide.', { exact: false })).toBeVisible();
});
