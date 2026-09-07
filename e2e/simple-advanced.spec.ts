import { test, expect } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('immediate reversible Simple/Advanced disclosure with stored data retained', async ({ page }) => {
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'simple');

  const advancedToggle = page.getByRole('button', { name: 'Switch to Advanced mode' });
  await expect(advancedToggle).toBeVisible();
  await advancedToggle.click();

  const simpleToggle = page.getByRole('button', { name: 'Switch to Simple mode' });
  const studioButton = page.getByRole('button', { name: 'Prompt Studio' });
  await expect(simpleToggle).toBeVisible();
  await expect(studioButton).toBeVisible();

  await studioButton.click();
  await page.getByRole('button', { name: 'Clone selected' }).click();
  await page.getByLabel('Prompt profile name').fill('Mode-safe profile');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText('Mode-safe profile saved as version 2')).toBeVisible();
  await page.locator('.ant-modal-content').filter({ hasText: 'Prompt Studio' })
    .getByRole('button', { name: 'Close', exact: true }).last().click();

  await simpleToggle.click();
  await expect(advancedToggle).toBeVisible();
  await expect(studioButton).toBeHidden();

  await page.reload();
  await dismissOnboarding(page, false);
  await expect(advancedToggle).toBeVisible();
  await expect(studioButton).toBeHidden();

  await advancedToggle.click();
  await studioButton.click();
  await expect(page.getByRole('button', { name: 'Mode-safe profile' })).toBeVisible();
});

test('Advanced creation submits explicit per-test generation and RAG overrides', async ({ page }) => {
  let createdJobs: { options: Record<string, unknown> }[] = [];
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      codex: { installed: true, connected: true },
      marker: { installed: false, job: { state: 'idle', message: '' } },
    }),
  }));
  await page.route('**/api/v1/jobs', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { jobs?: { options: Record<string, unknown> }[] };
      createdJobs = body.jobs ?? [];
    }
    await route.continue();
  });

  await dismissOnboarding(page);
  await setInterfaceMode(page, 'simple');
  await page.getByRole('button', { name: 'Add documents' }).last().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'advanced-controls.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Lease safety\n\nA lease grants one writer exclusive access and must be released in a finally block.'),
  });
  await expect(page.getByText('ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add to library' }).click();

  await page.getByRole('button', { name: 'Create test' }).last().click();
  const simpleDialog = page.locator('.ant-modal-content').filter({ hasText: 'Create tests from documents' });
  await expect(simpleDialog.getByText('Advanced generation controls')).toHaveCount(0);
  await simpleDialog.getByRole('button', { name: 'Cancel' }).click();

  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Create test' }).last().click();
  const advancedDialog = page.locator('.ant-modal-content').filter({ hasText: 'Create tests from documents' });
  await expect(advancedDialog.getByText('Advanced generation controls')).toBeVisible();
  await advancedDialog.getByText('advanced-controls', { exact: true }).click();
  const difficulty = advancedDialog.getByRole('combobox', { name: 'Target difficulty' });
  await difficulty.focus();
  await difficulty.press('ArrowDown');
  const difficultyMenu = page.locator('.ant-select-dropdown:visible');
  await expect(difficultyMenu).toBeVisible();
  await difficultyMenu.getByText('Advanced', { exact: true }).click();
  await advancedDialog.getByRole('spinbutton', { name: 'Per-test context budget' }).fill('12288');
  await advancedDialog.getByRole('spinbutton', { name: 'Per-test batch size' }).fill('7');
  await advancedDialog.getByRole('spinbutton', { name: 'Validation round limit' }).fill('2');
  await advancedDialog.getByRole('spinbutton', { name: 'Minimum grounding score' }).fill('0.55');
  await advancedDialog.getByRole('spinbutton', { name: 'Minimum instruction matches' }).fill('1');
  await advancedDialog.getByRole('checkbox', { name: 'Rerank retrieved evidence' }).check();
  await expect(advancedDialog.getByText('Estimated retrieval budget: up to 12,288 tokens per request')).toBeVisible();
  await advancedDialog.getByRole('checkbox', { name: /I approve sending selected excerpts/ }).check();
  await advancedDialog.getByRole('button', { name: 'Queue combined test' }).click();

  await expect.poll(() => createdJobs.length).toBe(1);
  const options = createdJobs[0].options as {
    generationProfile?: unknown;
    ragProfile?: Record<string, unknown>;
    resolvedSettings?: Record<string, unknown>;
  };
  expect(options.generationProfile).toEqual({
    difficulty: 'advanced',
    validation: { maxRounds: 2, minGroundingScore: 0.55, minInstructionMatches: 1 },
    batchSize: 7,
  });
  expect(options.ragProfile).toMatchObject({ contextBudget: 12_288, rerank: true, override: true });
  expect(options.ragProfile?.contextBudget).not.toBe(options.resolvedSettings?.['retrieval.contextBudget']);
});
