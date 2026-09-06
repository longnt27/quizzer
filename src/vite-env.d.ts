/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_QUIZZER_API_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  readonly quizzerDesktop?: {
    readonly platform: string;
    readonly architecture: string;
    readonly versions: Readonly<{ electron: string; chrome: string }>;
    readonly selectPluginDirectory: () => Promise<string | undefined>;
    readonly credentials: {
      readonly status: () => Promise<{ available: boolean; backend: string; message: string }>;
      readonly list: () => Promise<Partial<Record<import('./types').GenerationProvider, string>>>;
      readonly set: (provider: import('./types').GenerationProvider, value: string) => Promise<{ ok: true }>;
      readonly delete: (provider: import('./types').GenerationProvider) => Promise<{ ok: true }>;
    };
    readonly updater: import('./types/updater').QuizzerDesktopUpdaterApi;
  };
}
