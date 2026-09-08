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
  await expect(page.getByText('System health', { exact: true })).toBeVisible();

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
  await expect(page.getByText('System health', { exact: true })).toHaveCount(0);

  await page.reload();
  await dismissOnboarding(page, false);
  await expect(advancedToggle).toBeVisible();
  await expect(studioButton).toBeHidden();

  await advancedToggle.click();
  await studioButton.click();
  await expect(page.getByRole('button', { name: 'Mode-safe profile' }).first()).toBeVisible();
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

test('Simple creation is a plain source, length, and learning-goal flow', async ({ page }) => {
  let createdJobs: Array<{ name: string; options: Record<string, unknown> }> = [];
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      codex: { installed: true, connected: true },
      marker: { installed: false, job: { state: 'idle', message: '' } },
    }),
  }));
  await page.route('**/api/v1/jobs', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { jobs?: Array<{ name: string; options: Record<string, unknown> }> };
      createdJobs = body.jobs ?? [];
    }
    await route.continue();
  });

  await dismissOnboarding(page);
  await setInterfaceMode(page, 'simple');
  await expect(page.getByText('System health', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add documents' }).last().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'lease-basics.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Lease safety\n\nA lease grants one writer exclusive access and must be released in a finally block.'),
  });
  await expect(page.getByText('ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add to library' }).click();

  await page.getByRole('button', { name: 'Create test' }).last().click();
  const dialog = page.locator('.ant-modal-content').filter({ hasText: 'Create tests from documents' });
  await expect(dialog.getByRole('heading', { name: '1. Choose your documents' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '2. Choose a quiz length' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /3. Add a learning goal/ })).toBeVisible();
  await expect(dialog.getByText('Generation runs in the background')).toHaveCount(0);
  await expect(dialog.getByText('One combined test')).toHaveCount(0);
  await expect(dialog.getByText('Prompt profile')).toHaveCount(0);
  await expect(dialog.getByText('Rerank retrieved evidence')).toHaveCount(0);

  await dialog.getByRole('checkbox', { name: 'Select lease-basics' }).check();
  const quizLength = dialog.getByRole('combobox', { name: 'Quiz length' });
  await quizLength.focus();
  await quizLength.press('ArrowDown');
  await page.locator('.ant-select-dropdown:visible').getByText('Quick · 10 questions').click();
  await dialog.getByRole('textbox', { name: 'Learning goal' }).fill('Focus on safe cleanup.');
  await dialog.getByRole('checkbox', { name: 'Allow Quizzer to send these excerpts for this test.' }).check();
  await dialog.getByRole('button', { name: 'Create test' }).click();

  await expect.poll(() => createdJobs.length).toBe(1);
  expect(createdJobs[0].name).toBe('lease-basics quiz');
  expect(createdJobs[0].options).toMatchObject({
    questionCount: 10,
    questionCounts: { multipleChoice: 8, fillBlank: 1, reasoning: 1, coding: 0 },
    coverageStrategy: 'balanced',
    customInstruction: 'Focus on safe cleanup.',
  });
  expect(createdJobs[0].options.generationProfile).toBeUndefined();
});
