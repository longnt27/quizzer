import baseConfig from './playwright.config';

export default {
  ...baseConfig,
  testIgnore: undefined,
  testMatch: /cost-continuation\.spec\.ts/,
  projects: [{ ...baseConfig.projects?.[0], name: 'chromium', testMatch: /cost-continuation\.spec\.ts/ }],
  webServer: {
    ...baseConfig.webServer,
    env: { ...baseConfig.webServer?.env, QUIZZER_E2E_SEED_COST: '1' },
  },
};
