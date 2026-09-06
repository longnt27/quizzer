const generationActive = new Set(['queued', 'running', 'waiting', 'paused', 'error']);
const indexActive = new Set(['queued', 'running', 'failed']);

export const summarizeBackgroundState = ({ settings = {}, generationJobs = [], indexJobs = [] } = {}) => {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Background settings must be an object');
  if (!Array.isArray(generationJobs) || !Array.isArray(indexJobs)) throw new Error('Background jobs must be arrays');
  const activeGenerationJobs = generationJobs.filter(job => generationActive.has(job?.status)).length;
  const activeIndexJobs = indexJobs.filter(job => indexActive.has(job?.status)).length;
  const runningJobs = [...generationJobs, ...indexJobs].filter(job => job?.status === 'running').length;
  return {
    continueInBackground: settings['jobs.continueInBackground'] !== false,
    activeGenerationJobs,
    activeIndexJobs,
    activeJobCount: activeGenerationJobs + activeIndexJobs,
    runningJobs,
  };
};

export const protectedBackgroundFallback = Object.freeze({
  continueInBackground: true,
  activeGenerationJobs: 0,
  activeIndexJobs: 0,
  activeJobCount: 0,
  runningJobs: 0,
  serviceUnavailable: true,
});

