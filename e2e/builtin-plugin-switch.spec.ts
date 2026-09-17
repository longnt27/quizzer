import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('built-in plugin controls reflect immutable components', async ({ page }) => {
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Configure AI' }).click();

  const plugins = page.getByRole('dialog', { name: 'Plugins & models' });
  const basic = plugins.locator('.plugin-option').filter({ hasText: 'Quizzer Basic extraction' });
  await expect(basic.getByText('Quizzer Basic extraction', { exact: true })).toBeVisible();
  await expect(basic.getByRole('switch')).toHaveCount(0);

  await plugins.getByRole('tab', { name: 'Embeddings' }).click();
  await expect(plugins.getByRole('switch', { name: 'Use LanceDB vector index' })).toBeDisabled();
  await expect(plugins.getByRole('switch', { name: 'Use Quizzer result reranker' })).toBeDisabled();
});
