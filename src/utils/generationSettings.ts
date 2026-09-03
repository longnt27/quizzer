const concurrencyKey = 'quizzer.generationConcurrency';
const batchSizeKey = 'quizzer.generationBatchSize';

const readClampedInteger = (key: string, fallback: number, min: number, max: number) => {
  const stored = Number(localStorage.getItem(key) ?? fallback);
  return Number.isFinite(stored) ? Math.max(min, Math.min(max, Math.round(stored))) : fallback;
};

export const getGenerationConcurrency = () => readClampedInteger(concurrencyKey, 5, 1, 10);
export const getGenerationBatchSize = () => readClampedInteger(batchSizeKey, 20, 5, 25);

export const setGenerationConcurrency = (value: number) => {
  localStorage.setItem(concurrencyKey, String(Math.max(1, Math.min(10, Math.round(value)))));
};

export const setGenerationBatchSize = (value: number) => {
  localStorage.setItem(batchSizeKey, String(Math.max(5, Math.min(25, Math.round(value)))));
};
