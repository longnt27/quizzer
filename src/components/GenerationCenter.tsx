import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Empty, Input, List, Modal, Progress, Select, Slider, Space, Tag, Typography } from 'antd';
import { CloseOutlined, LoadingOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type StoredGenerationJob } from '../db/db';
import type { GenerationProvider } from '../types';
import {
  cancelGenerationJob, getGenerationConcurrency, removeGenerationJob, resumeGenerationJob,
  retryGenerationJob, setGenerationConcurrency,
} from '../utils/generationQueue';
import { getApiKey, getProviderDefinition, getProviderSettings, PROVIDERS } from '../utils/providerSettings';
import { getMessageApi } from '../utils/messageProvider';

const terminalStatuses = new Set(['completed', 'cancelled']);
const statusColor: Record<StoredGenerationJob['status'], string> = {
  queued: 'default', running: 'processing', waiting: 'warning', paused: 'warning', error: 'error', completed: 'success', cancelled: 'default',
};

const targetFor = (job: StoredGenerationJob) => job.options.questionCounts
  ? job.options.questionCounts.multipleChoice + job.options.questionCounts.fillBlank + job.options.questionCounts.reasoning
  : job.options.questionCount;

function JobItem({ job, onOpenTest, onManagePlugins }: { job: StoredGenerationJob; onOpenTest: (id: string) => void; onManagePlugins: () => void }) {
  const settings = getProviderSettings();
  const firstAlternative = PROVIDERS.find(provider => provider.id !== job.options.provider)?.id ?? job.options.provider;
  const [provider, setProvider] = useState<GenerationProvider>(firstAlternative);
  const [model, setModel] = useState(settings.models[firstAlternative]);
  const message = getMessageApi();
  const target = targetFor(job);
  const accepted = job.progress?.accepted ?? job.questions.length;
  const percent = target ? Math.min(100, Math.round(accepted / target * 100)) : 0;
  const providerDefinition = getProviderDefinition(provider);

  useEffect(() => {
    if (job.status !== 'paused') return;
    const next = PROVIDERS.find(item => item.id !== job.options.provider)?.id ?? job.options.provider;
    const latestSettings = getProviderSettings();
    setProvider(next);
    setModel(latestSettings.models[next]);
  }, [job.options.provider, job.status]);

  const resume = async () => {
    if (providerDefinition.kind === 'api' && !getApiKey(provider)) {
      message.error(`Configure your ${providerDefinition.keyLabel} first`);
      return;
    }
    await resumeGenerationJob(job.id, { ...job.options, provider, model: model.trim() || undefined });
  };

  return <List.Item className="generation-job">
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <div className="generation-job-heading">
        <div><Typography.Text strong>{job.name}</Typography.Text><br /><Typography.Text type="secondary">{getProviderDefinition(job.options.provider).label}</Typography.Text></div>
        <Tag color={job.status === 'completed' && accepted < target ? 'warning' : statusColor[job.status]}>
          {job.status === 'waiting' ? 'Waiting for connection' : job.status === 'completed' && accepted < target ? 'completed partial' : job.status}
        </Tag>
      </div>
      <Progress percent={percent} status={job.status === 'error' ? 'exception' : job.status === 'completed' ? 'success' : 'active'}
        format={() => `${accepted}/${target}`} />
      {job.progress && !terminalStatuses.has(job.status) && <Typography.Text type="secondary">
        {job.progress.phase === 'requesting' ? 'Requesting' : 'Checking'} {job.progress.currentType?.replaceAll('-', ' ')} · round {job.progress.round}/{job.progress.maxRounds} · {job.rejected} rejected
      </Typography.Text>}
      {job.error && <Alert type={job.status === 'error' ? 'error' : 'warning'} showIcon message={job.error} />}
      {job.status === 'paused' && <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary">Accepted questions are saved. Choose a provider for only the unfinished portion.</Typography.Text>
        <Space wrap>
          <Select value={provider} onChange={next => { setProvider(next); setModel(settings.models[next]); }} style={{ width: 190 }}
            options={PROVIDERS.map(item => ({ label: item.label, value: item.id }))} />
          <Input value={model} onChange={event => setModel(event.target.value)} addonBefore="Model" placeholder={providerDefinition.defaultModel || 'Provider default'} style={{ width: 260 }} />
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => void resume()}>Continue</Button>
          {providerDefinition.kind === 'api' && !getApiKey(provider) && <Button onClick={onManagePlugins}>Configure key</Button>}
        </Space>
      </Space>}
      <Space wrap>
        {(job.status === 'queued' || job.status === 'running' || job.status === 'waiting' || job.status === 'paused') &&
          <Button danger size="small" icon={<CloseOutlined />} onClick={() => void cancelGenerationJob(job.id)}>Cancel</Button>}
        {job.status === 'error' && <Button size="small" icon={<ReloadOutlined />} onClick={() => void retryGenerationJob(job.id)}>Retry from checkpoint</Button>}
        {job.status === 'completed' && <Button size="small" type="primary" onClick={() => onOpenTest(job.testId)}>Open test</Button>}
        {terminalStatuses.has(job.status) && <Button size="small" type="text" onClick={() => void removeGenerationJob(job.id)}>Dismiss</Button>}
      </Space>
    </Space>
  </List.Item>;
}

interface CenterProps { open: boolean; onClose: () => void; onOpenTest: (id: string) => void; onManagePlugins: () => void; }

export function GenerationCenter({ open, onClose, onOpenTest, onManagePlugins }: CenterProps) {
  const jobs = useLiveQuery(() => db.generationJobs.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const [instances, setInstances] = useState(getGenerationConcurrency);
  const clearFinished = async () => db.generationJobs.bulkDelete(jobs.filter(job => terminalStatuses.has(job.status)).map(job => job.id));
  return <Modal open={open} width={780} title="Generation queue" footer={null} onCancel={onClose}>
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert type="info" showIcon message="Background generation survives reloads and connection interruptions"
        description="Verified batches are stored locally. Each instance works on a different test, so later batches can include all questions already accepted for that test." />
      <div className="generation-concurrency">
        <div><Typography.Text strong>Concurrent test instances</Typography.Text><br /><Typography.Text type="secondary">One provider request per test. Changes apply as running requests finish.</Typography.Text></div>
        <Slider min={1} max={10} value={instances} marks={{ 1: '1', 5: '5', 10: '10' }} tooltip={{ formatter: value => `${value} instance${value === 1 ? '' : 's'}` }}
          onChange={value => { setInstances(value); setGenerationConcurrency(value); }} />
      </div>
      {!!jobs.some(job => terminalStatuses.has(job.status)) && <Button size="small" onClick={() => void clearFinished()}>Clear finished</Button>}
      <List locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No generation jobs" /> }} dataSource={jobs}
        renderItem={job => <JobItem job={job} onOpenTest={id => { onOpenTest(id); onClose(); }} onManagePlugins={onManagePlugins} />} />
    </Space>
  </Modal>;
}

export function GenerationActivity({ onOpen }: { onOpen: () => void }) {
  const jobs = useLiveQuery(() => db.generationJobs.where('status').anyOf('queued', 'running', 'waiting', 'paused').toArray(), []) ?? [];
  if (!jobs.length) return null;
  const running = jobs.filter(job => job.status === 'running').length;
  const paused = jobs.filter(job => job.status === 'paused' || job.status === 'waiting').length;
  return <Button className="generation-activity" type="primary" onClick={onOpen} icon={running ? <LoadingOutlined spin /> : <PlayCircleOutlined />}>
    <Badge count={jobs.length} size="small" offset={[10, -5]}>{running ? `${running} test${running === 1 ? '' : 's'} active` : paused ? `${paused} need attention` : 'Generation queued'}</Badge>
  </Button>;
}
