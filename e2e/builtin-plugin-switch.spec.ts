import { expect, test } from '@playwright/test';
import { dismissOnboarding, setInterfaceMode } from './helpers';

test('built-in plugin switches that cannot be disabled are disabled controls', async ({ page }) => {
  await dismissOnboarding(page);
  await setInterfaceMode(page, 'advanced');
  await page.getByRole('button', { name: 'Configure AI' }).click();

  const plugins = page.getByRole('dialog', { name: 'Plugins & models' });
  await expect(plugins.getByRole('switch', { name: 'Use Quizzer document extraction' })).toBeDisabled();

  await plugins.getByRole('tab', { name: 'Embeddings' }).click();
  await expect(plugins.getByRole('switch', { name: 'Use LanceDB vector index' })).toBeDisabled();
  await expect(plugins.getByRole('switch', { name: 'Use Quizzer result reranker' })).toBeDisabled();
});
