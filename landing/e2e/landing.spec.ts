import { sign } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { releasePrivateKey } from './release-key';

const manifestUrl = 'https://github.com/Somethings1/quizzer/releases/latest/download/release-manifest.json';
const releasesUrl = 'https://github.com/Somethings1/quizzer/releases/latest';
const installers = {
  macos: 'curl -fsSL https://github.com/Somethings1/quizzer/releases/latest/download/install.sh | sh',
  linux: 'curl -fsSL https://github.com/Somethings1/quizzer/releases/latest/download/install.sh | sh',
  windows: 'irm https://github.com/Somethings1/quizzer/releases/latest/download/install.ps1 | iex',
};
const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'signature')
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const signedManifest = () => {
  const manifest = {
    version: '1.0.0-beta.1',
    publishedAt: '2026-09-06T00:00:00.000Z',
    signatureAlgorithm: 'ed25519',
    publicKeyId: 'playwright-test-key',
    artifacts: [
      { platform: 'windows', architecture: 'x64', url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0-beta.1/quizzer-windows-x64.exe', sha256: '1'.repeat(64) },
      { platform: 'macos', architecture: 'arm64', url: 'https://github.com/Somethings1/quizzer/releases/download/v1.0.0-beta.1/quizzer-macos-arm64.dmg', sha256: '2'.repeat(64) },
      { platform: 'linux', architecture: 'x64', url: 'https://downloads.example.test/quizzer-linux-x64.AppImage', sha256: '3'.repeat(64) },
    ],
  };
  return { ...manifest, signature: Buffer.from(sign(null, Buffer.from(canonicalize(manifest)), releasePrivateKey)).toString('base64') };
};

const failManifest = (page: Page) => page.route(manifestUrl, route => route.abort());
const stubClipboard = (page: Page) => page.addInitScript(() => {
  let value = '';
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (next: string) => { value = next; }, readText: async () => value },
  });
});

test('detects the platform, exposes every installer, and copies the selected command', async ({ page }) => {
  await stubClipboard(page);
  await failManifest(page);
  await page.goto('/');

  await expect(page.getByText('Verified release unavailable')).toBeVisible();
  const detectedPlatform = await page.evaluate(() => {
    const source = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
    if (source.includes('win')) return 'Windows';
    if (source.includes('mac')) return 'macOS';
    return 'Linux';
  });
  await expect(page.getByRole('link', { name: `Download for ${detectedPlatform}` })).toHaveAttribute('href', releasesUrl);
  await page.getByRole('button', { name: 'Windows', exact: true }).click();
  await expect(page.getByRole('link', { name: /Download for Windows/ })).toBeVisible();
  await expect(page.getByLabel('Windows installation command')).toContainText(installers.windows);
  await page.getByLabel('Copy installer command').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(installers.windows);

  await page.getByRole('button', { name: 'macOS', exact: true }).click();
  await expect(page.getByLabel('macOS installation command')).toContainText(installers.macos);
  await expect(page.getByText('Verified release unavailable')).toBeVisible();
});

test('uses only trusted artifacts from a valid signed release manifest', async ({ page }) => {
  await page.route(manifestUrl, route => route.fulfill({ json: signedManifest() }));
  await page.goto('/');

  await expect(page.getByText('Version 1.0.0-beta.1')).toBeVisible();
  await expect(page.getByText('Verified release manifest · 2 signed artifacts')).toBeVisible();
  await page.getByRole('button', { name: 'Windows', exact: true }).click();
  await expect(page.getByRole('link', { name: /Download for Windows/ })).toHaveAttribute('href', /quizzer-windows-x64\.exe$/);
  await page.getByRole('button', { name: 'Linux', exact: true }).click();
  await expect(page.getByRole('link', { name: /Download for Linux/ })).toHaveAttribute('href', releasesUrl);
  await expect(page.getByText(`SHA-256 ${'1'.repeat(64)}`)).toBeVisible();
});

test('rejects a tampered release manifest instead of exposing its download', async ({ page }) => {
  await page.route(manifestUrl, route => route.fulfill({ json: { ...signedManifest(), version: '9.9.9' } }));
  await page.goto('/');

  await expect(page.getByText('Verified release unavailable')).toBeVisible();
  await page.getByRole('button', { name: 'Linux', exact: true }).click();
  await expect(page.getByRole('link', { name: /Download for Linux/ })).toHaveAttribute('href', releasesUrl);
  await expect(page.locator('a[href*="downloads.example.test"]')).toHaveCount(0);
});

test('updates the client-only quiz preview without contacting an AI provider', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(request.url());
  });
  await failManifest(page);
  await page.goto('/');
  await expect(page.getByText('Verified release unavailable')).toBeVisible();
  await page.getByRole('button', { name: 'Kubernetes operations' }).click();
  await page.getByLabel('Custom learning instruction').fill('Advanced coding questions about Networking only');

  const preview = page.locator('.demo-result');
  await expect(preview).toContainText('Kubernetes operations');
  await expect(preview).toContainText('Networking');
  await expect(preview).toContainText('Advanced');
  await expect(preview).toContainText('Strict topic filter + hybrid search');
  await expect(preview.locator('.question-mix').getByText('5', { exact: true })).toBeVisible();
  expect(externalRequests).toEqual([manifestUrl]);
});

test('keeps mobile content within the viewport and supports keyboard controls', async ({ page }) => {
  await stubClipboard(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await failManifest(page);
  await page.goto('/');

  await expect(page.getByText('Verified release unavailable')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const windows = page.getByRole('button', { name: 'Windows', exact: true });
  await windows.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: /Download for Windows/ })).toBeVisible();
  const copy = page.getByLabel('Copy Windows installer');
  await copy.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(installers.windows);
});

test('publishes accessible document and social metadata', async ({ page }) => {
  await failManifest(page);
  await page.goto('/');

  await expect(page).toHaveTitle('Quizzer — Local-first document quizzes');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /source-grounded quizzes/);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /\/og\.png$/);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
});

test('supports keyboard access to navigation, download controls, and demo with reduced motion', async ({ page }) => {
  await stubClipboard(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await failManifest(page);
  await page.goto('/');

  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Download for/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Windows', exact: true })).toHaveAttribute('type', 'button');
  await expect(page.getByRole('button', { name: 'Kubernetes operations' })).toHaveAttribute('type', 'button');

  const focusable = page.locator('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])');
  const count = await focusable.count();
  expect(count).toBeGreaterThan(5);
  for (let index = 0; index < Math.min(count, 24); index += 1) {
    const active = focusable.nth(index);
    await active.focus();
    await expect(active).toBeVisible();
    await expect.poll(() => active.evaluate(element => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
    })).toBe(true);
  }

  const windows = page.getByRole('button', { name: 'Windows', exact: true });
  await windows.focus();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Windows installation command')).toBeVisible();
  const copy = page.getByLabel('Copy Windows installer');
  await copy.focus();
  await page.keyboard.press('Enter');
  await expect(copy).toBeFocused();
  await expect(page.getByRole('button', { name: 'Kubernetes operations' })).toBeVisible();

  // Prove actual Tab reachability independently for representative controls;
  // this avoids assuming a particular DOM order while still detecting traps.
  const keyboardTargets = [
    windows,
    copy,
    page.getByRole('button', { name: 'Kubernetes operations' }),
  ];
  const tabUntil = async (target: ReturnType<typeof page.getByRole>, start = focusable.first()) => {
    await start.focus();
    for (let step = 0; step < 200; step += 1) {
      if (await target.evaluate(element => element === document.activeElement)) return;
      await page.keyboard.press('Tab');
    }
    throw new Error(`Target was not reachable by keyboard Tab traversal: ${await target.getAttribute('aria-label')} (${await target.textContent()})`);
  };
  for (const target of keyboardTargets) {
    await tabUntil(target, focusable.first());
    await expect(target).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
  }
});
