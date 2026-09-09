export interface HumanReadableProblem {
  problem: string;
  nextStep?: string;
  rawError?: string;
}

export function formatError(error: unknown, context: string = 'Error'): HumanReadableProblem {
  const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);

  console.error(`[${context}]`, error);

  const lowerMsg = msg.toLowerCase();

  // Dense Indexing / Network Failures
  if (lowerMsg.includes('sparse indexing completed, but dense indexing') || lowerMsg.includes('bge-m3 is unavailable')) {
    return {
      problem: 'Advanced semantic search is temporarily unavailable.',
      nextStep: 'Keyword search remains available. Verify your configured local embedding service/model in Plugins & models.',
      rawError: msg
    };
  }

  if (lowerMsg.includes('fetch failed') || lowerMsg.includes('network error') || lowerMsg.includes('failed to fetch')) {
    return {
      problem: 'Could not connect to the network.',
      nextStep: 'Please check your internet connection and try again.',
      rawError: msg
    };
  }

  if (lowerMsg.includes('could not index document')) {
    return {
      problem: 'Failed to process this document for searching.',
      nextStep: 'Try removing and adding the document again.',
      rawError: msg
    };
  }

  // File parsing / extraction
  if (lowerMsg.includes('no original file content found') || lowerMsg.includes('source document is unavailable')) {
    return {
      problem: 'The original document file is missing or inaccessible.',
      nextStep: 'Re-add the document to the library to restore access.',
      rawError: msg
    };
  }
  
  if (lowerMsg.includes('could not be opened') || lowerMsg.includes('extract document')) {
    return {
      problem: 'Could not read the document content.',
      nextStep: 'Ensure the file is not corrupted or try uploading a different format.',
      rawError: msg
    };
  }

  // Generation / Providers
  if (lowerMsg.includes('connect an ai provider')) {
    return {
      problem: 'No AI provider is connected.',
      nextStep: 'Go to Plugins & Models in settings to connect a provider.',
      rawError: msg
    };
  }
  
  if (lowerMsg.includes('rejected fill in the blank') || lowerMsg.includes('agy output')) {
    return {
      problem: 'The AI struggled to create a fill-in-the-blank question.',
      nextStep: 'Try simplifying your source text or choose a different question type.',
      rawError: msg
    };
  }
  if (lowerMsg.includes('structured output parsing failed') || lowerMsg.includes('json')) {
    return {
      problem: 'The AI returned an invalid response format.',
      nextStep: 'Try switching to a different model or provider.',
      rawError: msg
    };
  }

  // Known UI validations (Preserve these if they are already readable)
  if (lowerMsg.includes('between 1 and 200 questions') || lowerMsg.includes('choose at least one')) {
    return {
      problem: msg,
      rawError: msg
    };
  }

  // Updates
  if (lowerMsg.includes('update') || lowerMsg.includes('download') || lowerMsg.includes('rollback')) {
    return {
      problem: 'Encountered an issue with the application update.',
      nextStep: 'Please try checking for updates again later, or reinstall the app if the issue persists.',
      rawError: msg
    };
  }
  
  // Sync
  if (lowerMsg.includes('sync')) {
    return {
      problem: 'Could not sync your data to the cloud.',
      nextStep: 'Quizzer will keep retrying automatically. Your changes are saved locally.',
      rawError: msg
    };
  }

  // Default fallback
  return {
    problem: 'An unexpected issue occurred.',
    nextStep: 'Please try your action again.',
    rawError: msg
  };
}

export function formatErrorMessage(error: unknown, context?: string): string {
  const formatted = formatError(error, context);
  if (formatted.nextStep) {
    return `${formatted.problem} ${formatted.nextStep}`;
  }
  return formatted.problem;
}
