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
  };
}
