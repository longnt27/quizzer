import { resolve } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

const screenshot = async (page: Page, name: string) => {
  await page.locator('.ant-message, .ant-notification').evaluateAll(nodes => nodes.forEach(node => node.remove()));
  await page.screenshot({
    path: resolve('docs', 'screenshots', name),
    type: 'jpeg',
    quality: 90,
    animations: 'disabled',
  });
};

const candidateQuestions = (type: string, count: number) => Array.from({ length: count }, (_, index) => {
  const number = index + 1;
  if (type === 'fill-blank') return {
    type,
    statement: `A safe distributed update uses a _____ to grant one writer temporary ownership (${number}).`,
    acceptedAnswers: ['lease', 'lock'],
    explanation: 'A lease gives one writer bounded exclusive ownership while competing writers wait or retry.',
  };
  if (type === 'reasoning') return {
    type,
    statement: `Why must lease-protected update ${number} release ownership in a finally block?`,
    referenceAnswer: 'The finally block releases the lease even when the protected operation throws, preventing deadlock.',
    explanation: 'Cleanup belongs in finally so failures cannot strand exclusive ownership.',
  };
  return {
    type: 'multiple-choice',
    statement: `Which behavior makes distributed update ${number} safe when two writers race?`,
    answer: [
      { correct: true, content: `Acquire lease ${number} before writing`, explanation: 'Exclusive ownership serializes the conflicting writes.' },
      { correct: false, content: `Retry immediately without reading`, explanation: 'Blind retries can repeat the same conflict.' },
      { correct: false, content: `Delete the shared state first`, explanation: 'Deleting state loses evidence and does not coordinate writers.' },
    ],
  };
});

const fulfillGeneration = async (route: Route) => {
  const body = route.request().postDataJSON() as {
    prompt?: string;
    schema?: { properties?: { questions?: { items?: { properties?: { type?: { enum?: string[] } } } } } };
  };
  const type = body.schema?.properties?.questions?.items?.properties?.type?.enum?.[0] ?? 'multiple-choice';
  const count = Number(/Create exactly (\d+) new/.exec(body.prompt ?? '')?.[1] ?? 1);
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ output: JSON.stringify({ questions: candidateQuestions(type, count) }) }),
  });
};

test('capture current product states for the README', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('quizzer.theme', 'dark'));
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      codex: { installed: true, connected: true },
      'claude-agent': { installed: true, connected: true },
      marker: { installed: true, job: { state: 'ready', message: 'Ready' } },
    }),
  }));
  await page.route('**/api/generate', fulfillGeneration);

  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'Resume setup' }).last().click();
  await page.locator('.onboarding-drawer').getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('button', { name: 'Resume setup' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add documents' }).last().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'distributed-systems-field-guide.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from([
      '# Safe distributed coordination',
      '',
      'A lease grants one writer temporary exclusive ownership of shared state.',
      'Competing writers wait or retry after the lease expires or is released.',
      '',
      '## Failure safety',
      '',
      'Acquire ownership before reading, validate the version before writing,',
      'and always release the lease in a finally block.',
    ].join('\n')),
  });
  await expect(page.getByText('ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add to library' }).click();
  await expect(page.getByText('1 document(s) added')).toBeHidden({ timeout: 10_000 });

  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Create test' }).last().click();
  const advancedDialog = page.locator('.ant-modal-content').filter({ hasText: 'Create tests from documents' });
  await advancedDialog.locator('input.ant-input').first().fill('Distributed systems essentials');
  await advancedDialog.getByText('distributed-systems-field-guide', { exact: true }).click();
  await advancedDialog.getByPlaceholder('For example: coding questions about Terraform only')
    .fill('Focus on failure-safe leases and conflicting writers.');
  await advancedDialog.getByRole('spinbutton', { name: 'Multiple choice' }).fill('8');
  await advancedDialog.getByRole('spinbutton', { name: 'Fill in the blank' }).fill('1');
  await advancedDialog.getByRole('spinbutton', { name: 'Reasoning' }).fill('1');
  await expect(advancedDialog.getByText('Advanced generation controls')).toBeVisible();
  // Keep the seeded quiz small so the remaining screenshots stay fast and deterministic.
  await advancedDialog.getByRole('spinbutton', { name: 'Multiple choice' }).fill('1');
  await advancedDialog.getByRole('spinbutton', { name: 'Fill in the blank' }).fill('0');
  await advancedDialog.getByRole('checkbox', { name: /I approve sending selected excerpts/ }).check();
  await advancedDialog.getByRole('button', { name: 'Queue combined test' }).click();
  await expect(page.getByText('1 choice · 1 reasoning · 0 attempts')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Back to home' }).click();
  await page.getByRole('tab', { name: 'Documents' }).click();
  await page.getByRole('region', { name: 'Documents library' })
    .getByRole('heading', { name: 'distributed-systems-field-guide' }).click();
  await expect(page.getByText(/^Indexed ·/)).toBeVisible();
  await screenshot(page, 'document-current.jpg');

  await page.getByRole('button', { name: 'Back to home' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Quizzer' })).toBeVisible();
  await screenshot(page, 'home-current.jpg');

  await page.getByRole('tab', { name: 'Tests' }).click();
  await page.getByRole('heading', { name: 'Distributed systems essentials' }).click();
  await page.locator('.ant-radio-button-wrapper').filter({ hasText: 'Practice mode' }).click();
  await page.getByRole('button', { name: 'Start Practice' }).click();
  await expect(page.getByRole('heading', { name: 'Question 1' })).toBeVisible();
  await page.locator('.quiz-body .ant-radio-wrapper').first().click();
  await page.getByRole('button', { name: /Check answer/ }).click();
  await expect(page.getByRole('button', { name: /Ask AI about this answer/ })).toBeVisible();
  await expect(page.locator('[data-onboarding-target="citations"]')).toBeVisible();
  await screenshot(page, 'practice-citations-current.jpg');
});
