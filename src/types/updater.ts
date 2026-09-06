export type UpdateChannel = 'stable' | 'beta';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'applying'
  | 'applied'
  | 'rolled-back'
  | 'error'
  | 'unsupported';

export interface UpdateTarget {
  platform: string;
  architecture: string;
}

export interface ReleaseArtifact {
  name: string;
  platform: string;
  architecture: string;
  format: string;
  url: string;
  size: number;
  sha256: string;
  minimumOs?: string;
  cli?: boolean;
}

export interface UpdateInfo {
  version: string;
  channel: UpdateChannel;
  publishedAt: string;
  publicKeyId: string;
  artifact: ReleaseArtifact;
}

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
}

export interface RollbackInfo {
  available: boolean;
  version?: string;
  targetVersion?: string;
  timestamp?: string;
  status?: string;
  artifactName?: string;
}

export interface KeyStatus {
  configured: boolean;
  id?: string;
  algorithm?: string;
  trusted: boolean;
  message?: string;
}

export interface UpdaterStatus {
  state: UpdateState;
  currentVersion: string;
  channel: UpdateChannel;
  target: UpdateTarget;
  keyStatus: KeyStatus;
  mechanism: string;
  supported: boolean;
  updateInfo?: UpdateInfo;
  downloadProgress?: DownloadProgress;
  rollbackInfo?: RollbackInfo;
  stagedPath?: string;
  error?: string;
}

export interface CheckUpdateOptions {
  channel?: UpdateChannel;
  preferredFormat?: string;
  force?: boolean;
}

export interface ApplyUpdateOptions {
  restart?: boolean;
}

export interface ApplyUpdateResult {
  applied: boolean;
  restartRequested: boolean;
  mechanism: string;
  message: string;
  stagedPath?: string;
  status: UpdaterStatus;
}

export interface RollbackResult {
  rolledBack: boolean;
  restoredVersion: string;
  status: UpdaterStatus;
}

export interface QuizzerDesktopUpdaterApi {
  getStatus: () => Promise<UpdaterStatus>;
  checkForUpdates: (options?: CheckUpdateOptions) => Promise<UpdaterStatus>;
  downloadUpdate: () => Promise<UpdaterStatus>;
  applyUpdate: (options?: ApplyUpdateOptions) => Promise<ApplyUpdateResult>;
  rollbackUpdate: () => Promise<RollbackResult>;
}
