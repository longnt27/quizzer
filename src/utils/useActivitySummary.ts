import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';

export function useActivitySummary() {
  const activity = useLiveQuery(async () => {
    const [generation, indexing] = await Promise.all([
      db.generationJobs.where('status').anyOf('queued', 'running', 'waiting', 'paused', 'error').toArray(),
      db.indexJobs.where('status').anyOf('queued', 'running', 'failed').toArray(),
    ]);
    return { generation, indexing };
  }, []);
  const count = (activity?.generation.length ?? 0) + (activity?.indexing.length ?? 0);
  const running = (activity?.generation.filter(job => job.status === 'running').length ?? 0)
    + (activity?.indexing.filter(job => job.status === 'running').length ?? 0);
  const attention = (activity?.generation.filter(job => job.status === 'paused' || job.status === 'waiting' || job.status === 'error').length ?? 0)
    + (activity?.indexing.filter(job => job.status === 'failed').length ?? 0);

  return { count, running, attention };
}
