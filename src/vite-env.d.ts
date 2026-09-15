/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_QUIZZER_API_TOKEN?: string;
}

declare module '*.mjs' {
  export const authorizationHeaderForToken: (token?: string) => string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

type QuizzerCredentialProvider = import('./types').GenerationProvider | 'mistral-ocr';

interface Window {
  readonly quizzerDesktop?: {
    readonly platform: string;
    readonly architecture: string;
    readonly versions: Readonly<{ electron: string; chrome: string }>;
    readonly selectPluginDirectory: () => Promise<string | undefined>;
    readonly credentials: {
      readonly status: () => Promise<{ available: boolean; backend: string; message: string }>;
      readonly list: () => Promise<Partial<Record<QuizzerCredentialProvider, string>>>;
      readonly set: (provider: QuizzerCredentialProvider, value: string) => Promise<{ ok: true }>;
      readonly delete: (provider: QuizzerCredentialProvider) => Promise<{ ok: true }>;
    };
    readonly updater: import('./types/updater').QuizzerDesktopUpdaterApi;
  };
}
