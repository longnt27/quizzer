export interface QuizAnswer {
  correct: boolean;
  content: string;
  explanation: string;
}

export interface MultipleChoiceQuestion {
  type?: 'multiple-choice';
  statement: string;
  answer: QuizAnswer[];
  provenance?: QuestionProvenance;
}

export interface FillBlankQuestion {
  type: 'fill-blank';
  statement: string;
  acceptedAnswers: string[];
  explanation: string;
  provenance?: QuestionProvenance;
}

export interface ReasoningQuestion {
  type: 'reasoning';
  statement: string;
  referenceAnswer: string;
  explanation: string;
  provenance?: QuestionProvenance;
}

export interface CodingQuestion {
  type: 'coding';
  statement: string;
  referenceAnswer: string;
  explanation: string;
  provenance?: QuestionProvenance;
}

export type QuizQuestion = MultipleChoiceQuestion | FillBlankQuestion | ReasoningQuestion | CodingQuestion;
export type QuestionType = 'multiple-choice' | 'fill-blank' | 'reasoning' | 'coding';

export interface AIConversationTurn {
  question: string;
  answer: string;
  sources?: AISourceReference[];
}

export interface AISourceReference {
  id: string;
  documentId: string;
  name: string;
  page?: number;
  excerpt?: string;
  index?: number;
}

export interface AIAnswer {
  answer: string;
  sources?: AISourceReference[];
}

export interface QuestionCounts {
  multipleChoice: number;
  fillBlank: number;
  reasoning: number;
  coding: number;
}

export type CoverageStrategy = 'balanced' | 'proportional' | 'ai-selected' | 'cross-document';
export type InterfaceMode = 'simple' | 'advanced';
export type HardwareProfileId = 'lite' | 'balanced' | 'max';

export interface QuestionProvenance {
  sourceSpanIds: string[];
  documentIds: string[];
  coverageSlot?: number;
  provider?: string;
  model?: string;
}

export type GenerationProvider =
  | 'plugin'
  | 'ollama'
  | 'codex'
  | 'claude-agent'
  | 'antigravity-agent'
  | 'gemini'
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'openai-compatible';

/** Immutable per-million-token prices captured when a generation job is created. */
export interface ProviderPricing {
  inputMicroUsdPerMillionTokens: number;
  outputMicroUsdPerMillionTokens: number;
}

export type ProviderUsageCapability = 'provider-reported' | 'unavailable';

export interface ProviderRoute {
  provider: GenerationProvider;
  model?: string;
  privacy: 'local' | 'signed-in-agent' | 'remote-api';
  paid: boolean;
  approved: boolean;
  pricing?: ProviderPricing;
  usage?: ProviderUsageCapability;
}

export interface ProviderAttempt {
  provider: GenerationProvider;
  model?: string;
  routeIndex: number;
  at: number;
  accepted: number;
  outcome: 'failed' | 'completed' | 'manually-selected';
  errorCode?: string;
  message?: string;
}

/** Durable, service-owned usage accounting for a generation job. Values are
 * integer micro-USD (one millionth of a US dollar). Older jobs may omit it. */
export interface GenerationUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  finalizedCostMicroUsd: number;
  reservedCostMicroUsd: number;
}

export interface GenerationUsageAuditEntry {
  event: 'reserved' | 'finalized' | 'ceiling-raised' | 'ceiling-resumed';
  attemptId?: string;
  at: number;
  provider?: GenerationProvider;
  model?: string;
  overCeiling?: boolean;
  reservationRetained?: boolean;
  reason?: string;
  previousCeilingMicroUsd?: number;
  newCeilingMicroUsd?: number;
  /** Append-only reference consumed when a cost-ceiling pause is resumed. */
  currentCeilingMicroUsd?: number;
  ceilingRaiseIndex?: number;
  ceilingRaiseAt?: number;
}

export interface PromptProfileSnapshot {
  id: string;
  version: number;
  name: string;
  template: string;
  templates?: PromptTemplates;
}

export type PromptTemplateKind = 'generation' | 'grading' | 'rag';

export interface PromptTemplates {
  generation: string;
  grading: string;
  rag: string;
}

export interface PromptProfile {
  id: string;
  version: number;
  name: string;
  description?: string;
  templates: PromptTemplates;
  createdAt: number;
  updatedAt: number;
  builtIn?: boolean;
}

export interface RAGProfile {
  id: string;
  retrieval: 'sparse' | 'hybrid';
  contextBudget: number;
  rerank: boolean;
}

export type OnboardingStep = 'welcome' | 'hardware' | 'provider' | 'document' | 'instruction' | 'generate' | 'practice' | 'complete';

export interface OnboardingState {
  onboardingVersion: number;
  completedSteps: OnboardingStep[];
  currentStep: OnboardingStep;
  skipped: boolean;
  completedAt?: number;
  documentId?: string;
  generationJobId?: string;
  generationTestId?: string;
}

export interface HardwareCapabilities {
  platform: string;
  architecture: string;
  cpuCores: number;
  memoryGB: number;
  freeDiskGB: number;
  acceleration: string[];
  recommendedProfile: HardwareProfileId;
  reasons: string[];
}

export interface GenerationOptions {
  provider: GenerationProvider;
  model?: string;
  questionCount: number;
  questionCounts?: QuestionCounts;
  multipleChoiceMode?: 'single' | 'multiple' | 'mixed';
  coverageStrategy?: CoverageStrategy;
  customInstruction?: string;
  promptProfileSnapshot?: PromptProfileSnapshot;
  ragProfile?: RAGProfile;
  routeChain?: ProviderRoute[];
  resolvedSettings?: Record<string, unknown>;
  /** Omit for an unlimited job. Stored as integer micro-USD. */
  costCeilingMicroUsd?: number;
}

export interface TestSession {
  mode: 'taking' | 'reviewing';
  testId: string;
  timeLimit?: number;
  startedAt?: number;
  options?: {
    instantFeedback: boolean;
  };
}
