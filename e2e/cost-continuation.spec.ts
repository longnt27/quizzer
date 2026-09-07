import { expect, test, type Page, type Route } from '@playwright/test';
import { dismissOnboarding } from './helpers';

const generationResponse = async (route: Route) => {
  const body = route.request().postDataJSON() as { prompt?: string };
  const count = Number(/Create exactly (\d+) new/.exec(body.prompt ?? '')?.[1] ?? 1);
  const questions = Array.from({ length: count }, (_, index) => ({
    type: 'multiple-choice',
    statement: `Quizzer preserves accepted questions before retrying slot ${index + 1}.`,
    answer: [
      { correct: true, content: 'Retain accepted questions', explanation: 'The checkpoint remains durable.' },
      { correct: false, content: 'Discard the checkpoint', explanation: 'That would lose saved progress.' },
      { correct: false, content: 'Retry every slot', explanation: 'Only unfinished slots should be retried.' },
    ],
  }));
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ output: JSON.stringify({ questions }) }) });
};

const jobNamed = (page: Page, name: string) =>
  page.locator('.generation-job').filter({ hasText: name });

test('durable cost continuation requires ordered authorization, preserves checkpoints, and handles recovery safely', async ({ page }) => {
  let connected = true;
  let failFirstCeilingResume = true;
  let blockClaims = false;
  const events: Array<{ kind: 'ceiling-accounting' | 'recovery-accounting' | 'ceiling-resume' | 'recovery-resume'; body: unknown }> = [];

  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(connected ? {
      codex: { installed: true, connected: true },
      'claude-agent': { installed: false, connected: false },
      marker: { installed: false, job: { state: 'idle', message: '' } },
    } : {
      codex: { installed: true, connected: false },
      'claude-agent': { installed: false, connected: false },
      marker: { installed: false, job: { state: 'idle', message: '' } },
    }),
  }));
  await page.route('**/api/generate', generationResponse);
  await page.route('**/api/v1/jobs/e2e-cost-ceiling/resume', async route => {
    if (failFirstCeilingResume) {
      failFirstCeilingResume = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary queue failure' }) });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/v1/jobs/e2e-cost-recovery/resume', async route => {
    await route.continue();
  });
  await page.route('**/api/v1/jobs/claim', async route => {
    if (blockClaims) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
      return;
    }
    await route.continue();
  });
  page.on('request', request => {
    const url = new URL(request.url());
    let kind: typeof events[number]['kind'] | undefined;
    if (url.pathname === '/api/v1/jobs/e2e-cost-ceiling/accounting/ceiling') kind = 'ceiling-accounting';
    else if (url.pathname === '/api/v1/jobs/e2e-cost-recovery/accounting/recovery') kind = 'recovery-accounting';
    else if (url.pathname === '/api/v1/jobs/e2e-cost-ceiling/resume') kind = 'ceiling-resume';
    else if (url.pathname === '/api/v1/jobs/e2e-cost-recovery/resume') kind = 'recovery-resume';
    if (kind) events.push({ kind, body: request.postDataJSON() });
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('quizzer.disable-fixture-gemini') !== '1') {
      sessionStorage.setItem('quizzer.apiKey.gemini', 'e2e-no-network-key');
    }
  });

  await dismissOnboarding(page);
  await page.getByRole('button', { name: /need attention/ }).click();
  const ceiling = jobNamed(page, 'Cost ceiling continuation');
  await expect(ceiling.getByText('paused', { exact: true })).toBeVisible();
  await expect(ceiling.getByText('1/2', { exact: true })).toBeVisible();

  // The finite ceiling accepts its immutable stored price snapshot, while a
  // newly selected, unpriced model is blocked before any service mutation.
  const provider = ceiling.locator('.ant-select').first();
  await provider.click();
  await page.getByText('Gemini – API', { exact: true }).last().click();
  const model = ceiling.getByLabel('Model for continuing generation');
  await model.fill('unpriced-fixture-model');
  await ceiling.getByRole('button', { name: 'Continue' }).click();
  const unpricedModal = page.getByRole('dialog').filter({ hasText: 'Raise ceiling and continue' });
  await expect(unpricedModal.getByText(/no verified price snapshot/i)).toBeVisible();
  await page.locator('textarea#cost-reason-e2e-cost-ceiling').fill('Attempt an unpriced route.');
  await unpricedModal.locator('input#cost-ceiling-e2e-cost-ceiling').fill('2.00');
  await unpricedModal.getByRole('checkbox', { name: /higher spend/ }).check();
  await unpricedModal.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(page.locator('#cost-validation-e2e-cost-ceiling')).toContainText(/no verified pricing/i);
  expect(events).toEqual([]);
  await unpricedModal.getByRole('button', { name: 'Cancel' }).click();
  await provider.click();
  await page.getByText('Codex – Agent', { exact: true }).last().click();
  await model.fill('priced-fixture-model');

  await ceiling.getByRole('button', { name: 'Continue' }).click();
  const ceilingModal = page.getByRole('dialog').filter({ hasText: 'Raise ceiling and continue' });
  await expect(ceilingModal).toBeVisible();
  const confirm = ceilingModal.getByRole('button', { name: 'Confirm and continue' });
  await expect(confirm).toBeDisabled();
  await page.locator('textarea#cost-reason-e2e-cost-ceiling').fill('Resume only the unfinished checkpointed question.');
  await ceilingModal.locator('input#cost-ceiling-e2e-cost-ceiling').fill('0.50');
  await ceilingModal.getByRole('checkbox', { name: /higher spend/ }).check();
  await confirm.click();
  await expect(page.locator('#cost-validation-e2e-cost-ceiling')).toContainText(/strictly higher than the current ceiling/i);
  await ceilingModal.locator('input#cost-ceiling-e2e-cost-ceiling').fill('2.00');
  await confirm.click();

  await expect(page.getByText(/authorization recorded, but resume could not be queued/i)).toBeVisible();
  expect(events.map(event => event.kind)).toEqual(['ceiling-accounting', 'ceiling-resume']);
  expect(events[0]).toEqual({
    kind: 'ceiling-accounting',
    body: { newCeilingMicroUsd: 2_000_000, reason: 'Resume only the unfinished checkpointed question.', confirmed: true },
  });
  expect(events[1].kind).toBe('ceiling-resume');
  await expect(ceiling.getByText('1/2', { exact: true })).toBeVisible();

  // Reloading picks up the durable authorization. The retry sends only the
  // resume request and the previously accepted question remains visible.
  await page.reload();
  await dismissOnboarding(page, false);
  await page.getByRole('button', { name: /need attention/ }).click();
  const reloadedCeiling = jobNamed(page, 'Cost ceiling continuation');
  await expect(reloadedCeiling.getByRole('button', { name: 'Resume' })).toBeVisible();
  await expect(reloadedCeiling.getByText('1/2', { exact: true })).toBeVisible();
  blockClaims = true;
  await reloadedCeiling.getByRole('button', { name: 'Resume' }).click();
  await expect(reloadedCeiling.getByText(/queued|running/, { exact: false })).toBeVisible();
  await expect(reloadedCeiling.getByText('1/2', { exact: true })).toBeVisible();
  expect(events.map(event => event.kind)).toEqual(['ceiling-accounting', 'ceiling-resume', 'ceiling-resume']);
  expect(events.filter(event => event.kind === 'ceiling-accounting')).toHaveLength(1);

  // A disconnected provider prevents the accounting approval from being
  // attempted at all, while the paused job remains available for retry.
  connected = false;
  await page.evaluate(() => {
    sessionStorage.setItem('quizzer.disable-fixture-gemini', '1');
    sessionStorage.removeItem('quizzer.apiKey.gemini');
  });
  await page.reload();
  await dismissOnboarding(page, false);
  await page.getByRole('button', { name: /need attention/ }).click();
  const recoveryDisconnected = jobNamed(page, 'Cost recovery continuation');
  await expect(recoveryDisconnected.getByText('paused', { exact: true })).toBeVisible();
  await expect(recoveryDisconnected.getByText('No AI provider is configured')).toBeVisible();
  await expect(recoveryDisconnected.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  expect(events.filter(event => event.kind.endsWith('accounting'))).toHaveLength(1);

  connected = true;
  await page.reload();
  await dismissOnboarding(page, false);
  await page.getByRole('button', { name: /need attention/ }).click();
  const recovery = jobNamed(page, 'Cost recovery continuation');
  await expect(recovery.getByRole('button', { name: 'Continue' })).toBeVisible();
  await recovery.getByRole('button', { name: 'Continue' }).click();
  const recoveryModal = page.getByRole('dialog').filter({ hasText: 'Confirm cost recovery' });
  await expect(recoveryModal).toBeVisible();
  await expect(recoveryModal.getByRole('button', { name: 'Confirm and continue' })).toBeDisabled();
  await page.locator('textarea#cost-reason-e2e-cost-recovery').fill('Retry after reviewing possible duplicate provider billing.');
  await recoveryModal.getByRole('checkbox', { name: /may already have charged/ }).check();
  await recoveryModal.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(recovery.getByText(/queued|running/, { exact: false })).toBeVisible();
  await expect(recovery.getByText('1/2', { exact: true })).toBeVisible();
  const recoveryIndex = events.findIndex(event => event.kind === 'recovery-accounting');
  expect(recoveryIndex).toBeGreaterThanOrEqual(0);
  expect(events.slice(recoveryIndex, recoveryIndex + 2)).toEqual([
    { kind: 'recovery-accounting', body: { reason: 'Retry after reviewing possible duplicate provider billing.', confirmed: true } },
    expect.objectContaining({ kind: 'recovery-resume' }),
  ]);

  // A historical over-ceiling marker is informational only; it must not open
  // the accounting confirmation dialog or issue an accounting mutation.
  const historical = jobNamed(page, 'Historical over-ceiling warning');
  await expect(historical.getByText('Provider usage exceeded the historical ceiling; review before continuing.')).toBeVisible();
  await historical.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('dialog').filter({ hasText: 'Raise ceiling and continue' })).toHaveCount(0);
  await expect(page.getByRole('dialog').filter({ hasText: 'Confirm cost recovery' })).toHaveCount(0);
  expect(events.filter(event => event.kind.endsWith('accounting'))).toHaveLength(2);
});
