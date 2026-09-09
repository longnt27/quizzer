export type ErrorContext =
  | 'generic'
  | 'service'
  | 'storage'
  | 'settings'
  | 'document'
  | 'indexing'
  | 'retrieval'
  | 'embedding'
  | 'generation'
  | 'provider'
  | 'plugin'
  | 'updater'
  | 'ai';

export interface HumanReadableProblem {
  problem: string;
  nextStep: string;
}

const readableText = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return '';
};

const fallbackByContext: Record<ErrorContext, HumanReadableProblem> = {
  generic: { problem: 'Quizzer could not complete that action.', nextStep: 'Try again. If it keeps failing, restart Quizzer.' },
  service: { problem: "Quizzer's local service is unavailable.", nextStep: 'Restart Quizzer, then try again.' },
  storage: { problem: 'Quizzer could not save the latest changes.', nextStep: 'Keep Quizzer open; it will retry automatically.' },
  settings: { problem: 'Quizzer could not load or save settings.', nextStep: 'Try again. Restart Quizzer if settings remain unavailable.' },
  document: { problem: 'Quizzer could not process this document.', nextStep: 'Check the file, then try importing it again.' },
  indexing: { problem: 'Quizzer could not finish indexing this document.', nextStep: 'Keyword search may still work. Open Activity to retry indexing.' },
  retrieval: { problem: 'Quizzer could not retrieve source passages.', nextStep: 'Try the search again or review retrieval settings.' },
  embedding: { problem: 'Semantic search is unavailable.', nextStep: 'Keyword search remains available. Check the embedding service and model in Plugins & models.' },
  generation: { problem: 'Quizzer could not finish generating this test.', nextStep: 'Open Activity to retry unfinished questions or choose another provider.' },
  provider: { problem: 'The selected AI provider is unavailable.', nextStep: 'Check its connection in Plugins & models or choose another provider.' },
  plugin: { problem: 'Quizzer could not complete the plugin action.', nextStep: 'Check the plugin status in Plugins & models, then try again.' },
  updater: { problem: 'Quizzer could not complete the update action.', nextStep: 'Check your connection and try again later.' },
  ai: { problem: 'Quizzer could not get an AI response.', nextStep: 'Check the selected provider in Plugins & models, then try again.' },
};

export function formatError(error: unknown, context: ErrorContext = 'generic'): HumanReadableProblem {
  const message = readableText(error);
  const normalized = message.toLowerCase();

  // Preserve technical details in diagnostics, never in product copy.
  console.error(`[Quizzer:${context}]`, error);

  if (normalized.includes('sparse indexing completed, but dense indexing')
    || normalized.includes('dense indexing')
    || normalized.includes('bge-m3 is unavailable')
    || (context === 'embedding' && (normalized.includes('fetch failed') || normalized.includes('unavailable')))) {
    return fallbackByContext.embedding;
  }

  if (normalized.includes('quota') || normalized.includes('rate limit') || normalized.includes('provider_limit') || normalized.includes('429')) {
    return {
      problem: 'The AI provider limit was reached.',
      nextStep: 'Wait for the provider limit to reset or continue with another provider from Activity.',
    };
  }

  if (normalized.includes('unauthorized') || normalized.includes('forbidden') || normalized.includes('invalid api key')
    || normalized.includes('provider_auth') || normalized.includes('authentication')) {
    return {
      problem: 'The AI provider could not authenticate.',
      nextStep: 'Review its credentials in Plugins & models, then try again.',
    };
  }

  if (normalized.includes('no original file') || normalized.includes('source document is unavailable')
    || normalized.includes('extract document') || normalized.includes('could not be opened')
    || normalized.includes('unsupported file')) {
    return fallbackByContext.document;
  }

  if (normalized.includes('release manifest') || normalized.includes('github release url') || normalized.includes('checksum')
    || normalized.includes('signature') || normalized.includes('download')) {
    return {
      problem: 'Quizzer could not verify the available update.',
      nextStep: 'Try again later or download the release manually from the Quizzer GitHub Releases page.',
    };
  }

  if (normalized.includes('fetch failed') || normalized.includes('failed to fetch') || normalized.includes('network error')
    || normalized.includes('connection lost') || normalized.includes('timed out') || normalized.includes('cannot reach')) {
    return fallbackByContext[context === 'generic' ? 'service' : context];
  }

  return fallbackByContext[context];
}

export function formatErrorMessage(error: unknown, context: ErrorContext = 'generic'): string {
  const formatted = formatError(error, context);
  return `${formatted.problem} ${formatted.nextStep}`;
}
