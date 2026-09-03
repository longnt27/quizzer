const GEMINI_KEY = 'quizzer.geminiApiKey';

export const getGeminiApiKey = () => sessionStorage.getItem(GEMINI_KEY) ?? '';

export const setGeminiApiKey = (value: string) => {
  if (value) sessionStorage.setItem(GEMINI_KEY, value);
  else sessionStorage.removeItem(GEMINI_KEY);
};
