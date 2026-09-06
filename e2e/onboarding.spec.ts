import { expect, test, type Route } from '@playwright/test';

const candidateQuestions = (type: string, count: number) => Array.from({ length: count }, (_, index) => {
  const number = index + 1;
  if (type === 'fill-blank') return {
    type,
    statement: `A safe coordination pattern ${number} uses _____ to control concurrent access.`,
    acceptedAnswers: [`lease ${number}`, `mutex ${number}`, `lock token ${number}`],
    explanation: 'Each accepted form names a valid coordination mechanism for the scenario.',
  };
  if (type === 'reasoning') return {
    type,
    statement: `Why does coordination pattern ${number} prevent conflicting updates?`,
    referenceAnswer: 'It gives one writer exclusive ownership while other writers wait or retry safely.',
    explanation: 'A strong response connects exclusive ownership with serialized state changes.',
  };
  if (type === 'coding') return {
    type,
    statement: `Implement coordination pattern ${number} with explicit acquisition and release behavior.`,
    referenceAnswer: 'async function update(lock, task) { await lock.acquire(); try { return await task(); } finally { lock.release(); } }',
    explanation: 'The finally block releases ownership even when the protected operation fails.',
  };
  return {
    type: 'multiple-choice',
    statement: `Which coordination behavior ${number} best prevents conflicting state updates?`,
    answer: [
      { correct: true, content: `Acquire lock ${number} before writing`, explanation: 'This serializes writers before any shared state is changed.' },
      { correct: false, content: `Retry write ${number} without checking`, explanation: 'Blind retries can repeat the same conflict without coordination.' },
      { correct: false, content: `Delete state ${number} before reading`, explanation: 'Deleting shared state removes evidence and does not serialize writers.' },
    ],
  };
});

const fulfillGeneration = async (route: Route) => {
  const body = route.request().postDataJSON() as { prompt?: string; schema?: { properties?: { questions?: { items?: { properties?: { type?: { enum?: string[] } } } } } } };
  const type = body.schema?.properties?.questions?.items?.properties?.type?.enum?.[0] ?? 'multiple-choice';
  const count = Number(/Create exactly (\d+) new/.exec(body.prompt ?? '')?.[1] ?? 1);
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ output: JSON.stringify({ questions: candidateQuestions(type, count) }) }),
  });
};

test('resumes real onboarding and finishes through durable quiz practice', async ({ page }) => {
  await page.route('**/api/integrations', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ codex: { installed: true, connected: true }, marker: { installed: false, job: { state: 'idle', message: '' } } }),
  }));
  await page.route('**/api/generate', fulfillGeneration);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Learn from your own material' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a hardware profile' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Configure your AI' })).toBeVisible();
  await expect(page.getByText('AI is ready')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Import a real document' })).toBeVisible();
  await page.locator('.onboarding-drawer').getByRole('button').filter({ hasText: 'Add document' }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'coordination.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Safe coordination\n\nA lease grants one writer exclusive access. Other writers wait and retry after the lease is released.\n\nAlways release ownership in a finally block.'),
  });
  await expect(page.getByText('ready', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add to library' }).click();
  await expect(page.getByText('coordination is readable and saved')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'What do you want to learn?' })).toBeVisible();
  await page.getByPlaceholder('For example: coding questions about Terraform only').fill('Focus on safe concurrent updates.');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Create your first quiz' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Create your first quiz' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.locator('.onboarding-drawer').getByRole('button').filter({ hasText: 'Create test' }).click();
  await page.getByText('coordination', { exact: true }).click();
  await page.getByText('Balanced learning · 20 questions').click();
  await page.getByText('Quick review · 10 questions').click();
  await page.getByRole('button', { name: 'Queue combined test' }).click();

  await expect(page.getByText('Your quiz is being generated')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Combined quiz is ready')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('10 validated questions')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Try one question' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Combined quiz' }).click();
  await page.locator('.ant-radio-button-wrapper').filter({ hasText: 'Practice mode' }).click();
  await page.getByRole('button', { name: 'Start Practice' }).click();
  await expect(page.getByRole('heading', { name: 'Question 1' })).toBeVisible();

  const multipleChoice = page.locator('.quiz-body .ant-radio-wrapper').first();
  const fillBlank = page.getByPlaceholder('Type the missing word or phrase');
  const writtenAnswer = page.locator('.written-answer-block textarea');
  if (await multipleChoice.isVisible()) await multipleChoice.click();
  else if (await fillBlank.isVisible()) await fillBlank.fill('lease');
  else await writtenAnswer.fill('Exclusive ownership serializes writers and prevents conflicting updates.');

  await page.getByRole('button', { name: /Check answer/ }).click();
  await expect(page.getByRole('button', { name: /Ask AI about this answer/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();

  await page.getByRole('button', { name: 'Resume setup' }).click();
  await expect(page.getByRole('heading', { name: 'Try one question' })).toBeVisible();
  await expect(page.getByText('First question answered')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'You’re ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Finish' }).click();

  await expect(page.getByRole('heading', { name: 'Welcome to Quizzer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume setup' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Question 1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Learn from your own material' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Quizzer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume setup' })).toHaveCount(0);
});
