import { useEffect } from 'react';
import { pumpGenerationQueue } from '../utils/generationQueue';

export default function GenerationWorker() {
  useEffect(() => {
    if (import.meta.env.VITE_QUIZZER_RENDERER_WORKER !== '1') return undefined;
    const pump = () => void pumpGenerationQueue();
    pump();
    const timer = window.setInterval(pump, 2_000);
    window.addEventListener('online', pump);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', pump);
    };
  }, []);
  return null;
}
