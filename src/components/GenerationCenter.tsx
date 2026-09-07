import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Empty, Input, InputNumber, List, Modal, Progress, Select, Slider, Space, Tag, Typography } from 'antd';
import { CloseOutlined, DatabaseOutlined, LoadingOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type StoredGenerationJob, type StoredIndexJob } from '../db/db';
import type { GenerationProvider } from '../types';
import {
  cancelGenerationJob, pumpGenerationQueue, removeGenerationJob, resumeGenerationJob, retryGenerationJob,
} from '../utils/generationQueue';
import {
  getGenerationBatchSize, getGenerationConcurrency, setGenerationBatchSize, setGenerationConcurrency,
} from '../utils/generationSettings';
import { getProviderDefinition, getProviderRoute, getProviderSettings } from '../utils/providerSettings';
import { getMessageApi } from '../utils/messageProvider';
import { useConfiguredProviders } from '../utils/useConfiguredProviders';
import { serviceJson } from '../utils/serviceApi';
import { applyServiceRecord } from '../db/serverSync';

const terminalStatuses = new Set(['completed', 'cancelled']);
const statusColor: Record<StoredGenerationJob['status'], string> = {
  queued: 'default', running: 'processing', waiting: 'warning', paused: 'warning', error: 'error', completed: 'success', cancelled: 'default',
};

const targetFor = (job: StoredGenerationJob) => job.options.questionCounts
  ? job.options.questionCounts.multipleChoice + job.options.questionCounts.fillBlank + job.options.questionCounts.reasoning + (job.options.questionCounts.coding ?? 0)
  : job.options.questionCount;

const formatUsd = (microUsd: number | undefined) => microUsd === undefined
  ? '—'
  : `$${(microUsd / 1_000_000).toFixed(2)}`;

const accountingState = (job: StoredGenerationJob) => {
  const summary = job.usageSummary;
  const pausedForCost = job.errorCode === 'cost_ceiling' || job.errorCode === 'cost_recovery';
  const overCeiling = Boolean(job.usageAudit?.some(event => event.overCeiling));
  return { summary, pausedForCost, overCeiling };
};

const routeMatches = (route: ReturnType<typeof getProviderRoute>, provider: GenerationProvider, model: string) =>
  route.provider === provider && (route.model ?? undefined) === (model.trim() || undefined);

/** Resolve an existing immutable route before deriving a new route snapshot. */
const resolveJobRoute = (job: StoredGenerationJob, provider: GenerationProvider, model: string) => {
  const existing = (job.options.routeChain ?? []).find(route => routeMatches(route, provider, model));
  return existing ? { ...existing, approved: true } : getProviderRoute(provider, model, true);
};

const hasPendingCeilingAuthorization = (job: StoredGenerationJob) => {
  if (job.errorCode !== 'cost_ceiling' || job.options.costCeilingMicroUsd === undefined) return false;
  const audit = job.usageAudit ?? [];
  let raiseIndex = -1;
  for (let index = 0; index < audit.length; index += 1) {
    const event = audit[index];
    if (event.event === 'ceiling-raised' && event.newCeilingMicroUsd === job.options.costCeilingMicroUsd) raiseIndex = index;
  }
  if (raiseIndex < 0) return false;
  // A later accounting event means this authorization was already consumed by
  // a retry. A lost resume has no event after the raise and can be resumed.
  return !audit.slice(raiseIndex + 1).some(event => event.event === 'reserved' || event.event === 'finalized');
};

const hasRecoveryAuthorization = (job: StoredGenerationJob) => Boolean(
  job.errorCode === 'cost_recovery' && job.recoveryAttemptId
    && job.usageAudit?.some(event => event.event === 'recovery-approved' && event.recoveryAttemptId === job.recoveryAttemptId),
);

const formatRoutePrice = (route: ReturnType<typeof getProviderRoute>) => route.pricing
  ? `$${(route.pricing.inputMicroUsdPerMillionTokens / 1_000_000).toFixed(2)} input / $${(route.pricing.outputMicroUsdPerMillionTokens / 1_000_000).toFixed(2)} output per 1M tokens`
  : 'No verified price snapshot';

function JobItem({ job, onOpenTest, onManagePlugins }: { job: StoredGenerationJob; onOpenTest: (id: string) => void; onManagePlugins: () => void }) {
  const settings = getProviderSettings();
  const configured = useConfiguredProviders();
  const firstAlternative = settings.defaultProvider;
  const [provider, setProvider] = useState<GenerationProvider>(firstAlternative);
  const [model, setModel] = useState(settings.models[firstAlternative]);
  const [accountingModalOpen, setAccountingModalOpen] = useState(false);
  const [newCeilingDollars, setNewCeilingDollars] = useState<number | null>(null);
  const [accountingReason, setAccountingReason] = useState('');
  const [accountingConfirmed, setAccountingConfirmed] = useState(false);
  const [accountingWorking, setAccountingWorking] = useState(false);
  const [accountingValidation, setAccountingValidation] = useState('');
  const message = getMessageApi();
  const target = targetFor(job);
  const accepted = job.progress?.accepted ?? job.questions.length;
  const percent = target ? Math.min(100, Math.round(accepted / target * 100)) : 0;
  const providerDefinition = getProviderDefinition(provider);
  const { summary, pausedForCost, overCeiling } = accountingState(job);
  const alreadyAuthorized = job.errorCode === 'cost_ceiling'
    ? hasPendingCeilingAuthorization(job) : hasRecoveryAuthorization(job);
  const selectedRoute = resolveJobRoute(job, provider, model);
  const accountingIdentity = `${job.id}:${job.errorCode ?? ''}:${job.recoveryAttemptId ?? ''}:${job.options.costCeilingMicroUsd ?? ''}`;

  const resetAccountingForm = () => {
    setNewCeilingDollars(null);
    setAccountingReason('');
    setAccountingConfirmed(false);
    setAccountingValidation('');
  };

  useEffect(() => {
    resetAccountingForm();
    setAccountingModalOpen(false);
    // Reset only when the job or its durable authorization identity changes.
  }, [accountingIdentity]);

  useEffect(() => {
    if (job.status !== 'paused') return;
    const next = pausedForCost
      ? job.options.provider
      : configured.providers.find(item => item.id !== job.options.provider)?.id ?? configured.providers[0]?.id;
    if (!next) return;
    const latestSettings = getProviderSettings();
    setProvider(next);
    setModel(pausedForCost ? (job.options.model ?? latestSettings.models[next]) : latestSettings.models[next]);
  }, [configured.providers, job.options.model, job.options.provider, job.status, pausedForCost]);

  const resume = async (resumeJob = job) => {
    if (!configured.providers.some(item => item.id === provider)) return message.error('Connect the selected AI provider first');
    const route = resolveJobRoute(resumeJob, provider, model);
    if (resumeJob.options.costCeilingMicroUsd !== undefined && !route.pricing) {
      return message.error('The selected route has no verified pricing. Choose a priced model or configure explicit pricing in Advanced mode before continuing.');
    }
    const existingRoutes = resumeJob.options.routeChain ?? [];
    const existingIndex = existingRoutes.findIndex(existing => routeMatches(existing, provider, model));
    const routeChain = existingIndex >= 0
      ? existingRoutes.map((existing, index) => index === existingIndex ? { ...existing, approved: true } : existing)
      : [...existingRoutes, route];
    try {
      await resumeGenerationJob(resumeJob.id, { ...resumeJob.options, provider, model: model.trim() || undefined, routeChain });
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Could not queue generation resume');
    }
  };

  const continueAccounting = async () => {
    const isCeiling = job.errorCode === 'cost_ceiling';
    const reason = accountingReason.trim();
    const fail = (detail: string) => { setAccountingValidation(detail); return message.error(detail); };
    setAccountingValidation('');
    if (!configured.providers.some(item => item.id === provider)) return fail('Connect the selected AI provider before authorizing this continuation');
    if (!reason || reason.length > 500) return fail('Enter a reason between 1 and 500 characters');
    if (!accountingConfirmed) return fail('Confirm the spend and privacy impact before continuing');
    const current = job.options.costCeilingMicroUsd;
    const next = newCeilingDollars === null ? undefined : Math.round(newCeilingDollars * 1_000_000);
    if (isCeiling && (current === undefined || next === undefined || next <= current)) {
      return fail('Enter a new ceiling strictly higher than the current ceiling');
    }
    if (current !== undefined && !selectedRoute.pricing) {
      return fail('The selected route has no verified pricing. Choose a priced model or configure explicit pricing in Advanced mode before continuing.');
    }
    setAccountingWorking(true);
    let authorizationApplied = false;
    try {
      const path = `/api/v1/jobs/${encodeURIComponent(job.id)}/accounting/${isCeiling ? 'ceiling' : 'recovery'}`;
      const body = isCeiling
        ? { newCeilingMicroUsd: next, reason, confirmed: true }
        : { reason, confirmed: true };
      const result = await serviceJson<{ job: StoredGenerationJob }>(path, 'POST', body);
      authorizationApplied = true;
      await applyServiceRecord('generationJobs', result.job.id, result.job);
      const route = resolveJobRoute(result.job, provider, model);
      const existingRoutes = result.job.options.routeChain ?? [];
      const existingIndex = existingRoutes.findIndex(existing => routeMatches(existing, provider, model));
      const routeChain = existingIndex >= 0
        ? existingRoutes.map((existing, index) => index === existingIndex ? { ...existing, approved: true } : existing)
        : [...existingRoutes, route];
      try {
        await resumeGenerationJob(result.job.id, { ...result.job.options, provider, model: model.trim() || undefined, routeChain });
      } catch (error) {
        // The service-owned authorization is durable. Do not ask for a second
        // raise/approval when only the queue request failed.
        setAccountingModalOpen(false);
        resetAccountingForm();
        message.error(`Authorization recorded, but resume could not be queued: ${error instanceof Error ? error.message : 'service unavailable'}. Choose Resume to retry.`);
        return;
      }
      setAccountingModalOpen(false);
      resetAccountingForm();
    } catch (error) {
      if (authorizationApplied) {
        setAccountingModalOpen(false);
        resetAccountingForm();
        message.error(`Authorization recorded, but resume could not be queued: ${error instanceof Error ? error.message : 'service unavailable'}. Choose Resume to retry.`);
      } else message.error(error instanceof Error ? error.message : 'Could not confirm accounting recovery');
    } finally {
      setAccountingWorking(false);
    }
  };

  return <List.Item className="generation-job">
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <div className="generation-job-heading">
        <div><Typography.Text strong>{job.name}</Typography.Text><br /><Typography.Text type="secondary">{getProviderDefinition(job.options.provider).label}</Typography.Text></div>
        <Tag color={job.status === 'completed' && accepted < target ? 'warning' : statusColor[job.status]}>
          {job.status === 'waiting' ? 'Waiting for connection' : job.status === 'completed' && accepted < target ? 'completed partial' : job.status}
        </Tag>
      </div>
      {job.documentIds.length > 1 && <Typography.Text type="secondary">
        {job.documentIds.length} documents · {(job.options.coverageStrategy ?? 'balanced').replace('-', ' ')} coverage · bounded source chunks
      </Typography.Text>}
      <Progress percent={percent} status={job.status === 'error' ? 'exception' : job.status === 'completed' ? 'success' : 'active'}
        format={() => `${accepted}/${target}`} />
      {job.progress && !terminalStatuses.has(job.status) && <Typography.Text type="secondary">
        {job.progress.phase === 'requesting' ? 'Requesting' : 'Checking'} {job.progress.currentType?.replaceAll('-', ' ')} · round {job.progress.round}/{job.progress.maxRounds} · {job.rejected} rejected
      </Typography.Text>}
      {!!job.providerAttempts?.length && <div>
        <Typography.Text type="secondary">Route history</Typography.Text>
        <Space wrap style={{ marginLeft: 8 }}>{job.providerAttempts.map((attempt, index) => <Tag key={`${attempt.at}:${index}`}
          color={attempt.outcome === 'failed' ? 'error' : attempt.outcome === 'completed' ? 'success' : 'blue'}>
          {getProviderDefinition(attempt.provider).label} · {attempt.outcome.replace('-', ' ')} · {attempt.accepted} saved
        </Tag>)}</Space>
      </div>}
      {summary && <div className="generation-cost-summary" aria-label="Generation usage and cost">
        <Typography.Text type="secondary">Usage</Typography.Text>
        <Space wrap size={[8, 4]}>
          <Tag>{summary.totalTokens.toLocaleString()} tokens</Tag>
          <Tag color="blue">Committed {formatUsd(summary.finalizedCostMicroUsd)}</Tag>
          <Tag color={summary.reservedCostMicroUsd > 0 ? 'gold' : undefined}>Reserved {formatUsd(summary.reservedCostMicroUsd)}</Tag>
          <Tag>{job.options.costCeilingMicroUsd === undefined ? 'Unlimited ceiling' : `Ceiling ${formatUsd(job.options.costCeilingMicroUsd)}`}</Tag>
        </Space>
      </div>}
      {(pausedForCost || overCeiling) && <Alert type="warning" showIcon message={pausedForCost
        ? job.errorCode === 'cost_ceiling' ? 'Generation paused at its cost ceiling' : 'Generation paused for cost recovery'
        : 'Generation exceeded its recorded ceiling'}
        description={pausedForCost && job.errorCode === 'cost_ceiling'
          ? alreadyAuthorized
            ? 'A ceiling raise is already recorded for this pause. Quizzer will retry the saved resume without asking you to authorize the same spend again.'
            : 'Saved questions and usage totals are preserved. Raise the ceiling through the service after reviewing the estimated impact, then continue.'
          : pausedForCost ? 'Saved questions and usage totals are preserved. Review the accounting history and choose Continue after the service confirms a safe route.'
            : 'The provider reported usage above the historical ceiling. Review the accounting history before starting another generation.'} />}
      {job.error && <Alert type={job.status === 'error' ? 'error' : 'warning'} showIcon message={job.error} />}
      {job.status === 'paused' && <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary">Accepted questions are saved. Choose a provider for only the unfinished portion.</Typography.Text>
        {!configured.loading && !configured.providers.length && <Alert type="warning" showIcon message="No AI provider is configured"
          description="Connect an agent or add an API key to continue this job."
          action={<Button size="small" onClick={onManagePlugins}>Open plugins</Button>} />}
        {!!configured.providers.length && <Space wrap>
          <Select value={configured.providers.some(item => item.id === provider) ? provider : undefined} placeholder="Select provider"
            aria-label="Provider for continuing generation" onChange={next => { setProvider(next); setModel(settings.models[next]); resetAccountingForm(); }} style={{ width: 190 }}
            options={configured.providers.map(item => ({ label: item.label, value: item.id }))} />
          <Input value={model} onChange={event => { setModel(event.target.value); resetAccountingForm(); }} addonBefore="Model" aria-label="Model for continuing generation" placeholder={providerDefinition.defaultModel || 'Provider default'} style={{ width: 260 }} />
          {pausedForCost
            ? <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => alreadyAuthorized ? void resume() : setAccountingModalOpen(true)}>{alreadyAuthorized ? 'Resume' : 'Continue'}</Button>
            : <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => void resume()}>Continue</Button>}
        </Space>}
        {!!configured.providers.length && <Alert type={providerDefinition.kind === 'api' ? 'warning' : 'info'} showIcon
          message={providerDefinition.kind === 'api'
            ? 'Remote API route · charges and provider data handling may apply'
            : providerDefinition.kind === 'plugin' ? 'Local generator plugin route'
              : providerDefinition.kind === 'local' ? 'Local model route' : 'Signed-in agent route'}
          description={providerDefinition.kind === 'plugin'
            ? 'Continuing runs only unfinished source batches through the selected local, out-of-process plugin.'
            : 'Continuing explicitly approves this route for only the unfinished questions. Existing accepted questions are retained.'} />}
      </Space>}
      {pausedForCost && <Modal open={accountingModalOpen} title={job.errorCode === 'cost_ceiling' ? 'Raise ceiling and continue' : 'Confirm cost recovery'}
        okText="Confirm and continue" confirmLoading={accountingWorking} okButtonProps={{ disabled: !accountingConfirmed }}
        onOk={() => void continueAccounting()} onCancel={() => { if (!accountingWorking) { setAccountingModalOpen(false); resetAccountingForm(); } }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert type={selectedRoute.paid ? 'warning' : 'info'} showIcon message={`${providerDefinition.label} · ${selectedRoute.model ?? 'provider default'}`}
            description={`${selectedRoute.privacy === 'local' ? 'Local data processing' : selectedRoute.privacy === 'signed-in-agent' ? 'Signed-in agent data handling' : 'Remote API data handling'} · ${selectedRoute.paid ? 'Paid route may incur provider charges' : 'No provider charge expected'} · ${formatRoutePrice(selectedRoute)}`} />
          <Typography.Paragraph>
            {job.errorCode === 'cost_ceiling'
              ? `Committed ${formatUsd(summary?.finalizedCostMicroUsd)} · reserved ${formatUsd(summary?.reservedCostMicroUsd)} · current ceiling ${formatUsd(job.options.costCeilingMicroUsd)}.`
              : 'A previous attempt may have charged the provider before Quizzer committed its checkpoint. This action acknowledges that risk before advancing recovery.'}
          </Typography.Paragraph>
          {job.errorCode === 'cost_ceiling' && <div>
            <label htmlFor={`cost-ceiling-${job.id}`}>New generation cost ceiling (USD)</label>
            <InputNumber id={`cost-ceiling-${job.id}`} aria-invalid={Boolean(accountingValidation && (newCeilingDollars === null || newCeilingDollars === undefined))} min={0} max={9_000_000_000} precision={2}
              value={newCeilingDollars} onChange={value => { setNewCeilingDollars(value); setAccountingValidation(''); }} addonBefore="$" addonAfter="USD" style={{ width: '100%' }} />
          </div>}
          <div>
            <label htmlFor={`cost-reason-${job.id}`}>Reason for continuing</label>
            <Input.TextArea id={`cost-reason-${job.id}`} aria-label="Cost recovery reason" aria-invalid={Boolean(accountingValidation && !accountingReason.trim())}
              aria-describedby={accountingValidation ? `cost-validation-${job.id}` : undefined} rows={3} maxLength={500} showCount value={accountingReason}
            onChange={event => setAccountingReason(event.target.value)} placeholder="Why should Quizzer continue this generation?" />
          </div>
          <Checkbox id={`cost-confirm-${job.id}`} checked={accountingConfirmed} aria-describedby={accountingValidation ? `cost-validation-${job.id}` : undefined}
            onChange={event => { setAccountingConfirmed(event.target.checked); setAccountingValidation(''); }}>
            {job.errorCode === 'cost_recovery'
              ? 'I acknowledge that the provider may already have charged this attempt, consent to retrying recovery, and accept the selected route’s data handling.'
              : 'I confirm the higher spend and the selected provider’s data-sharing impact, and understand saved progress will be retained.'}
          </Checkbox>
          {accountingValidation && <Typography.Text type="danger" role="alert" id={`cost-validation-${job.id}`}>{accountingValidation}</Typography.Text>}
        </Space>
      </Modal>}
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

const indexStatusColor: Record<StoredIndexJob['status'], string> = {
  queued: 'default', running: 'processing', completed: 'success', failed: 'error', cancelled: 'default',
};

function IndexJobItem({ job }: { job: StoredIndexJob }) {
  const message = getMessageApi();
  const [working, setWorking] = useState(false);
  const documents = useLiveQuery(() => db.documents.bulkGet(job.documentIds), [job.documentIds.join('|')]) ?? [];
  const names = documents.map(document => document?.name).filter((name): name is string => Boolean(name));
  const completed = job.completedDocumentIds.length;
  const total = job.documentIds.length;
  const percent = total ? Math.round(completed / total * 100) : 0;
  const control = async (action: 'resume' | 'cancel') => {
    setWorking(true);
    try {
      const result = await serviceJson<{ job: StoredIndexJob }>(`/api/v1/index/jobs/${encodeURIComponent(job.id)}/${action}`, 'POST', {});
      await applyServiceRecord('indexJobs', result.job.id, result.job);
    } catch (error) {
      message.error(error instanceof Error ? error.message : `Could not ${action} indexing`);
    } finally {
      setWorking(false);
    }
  };

  return <List.Item className="generation-job">
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <div className="generation-job-heading">
        <div>
          <Typography.Text strong><DatabaseOutlined /> Index {total} document{total === 1 ? '' : 's'}</Typography.Text><br />
          <Typography.Text type="secondary">{names.length ? names.join(', ') : job.documentIds.join(', ')}</Typography.Text>
        </div>
        <Tag color={indexStatusColor[job.status]}>{job.status}</Tag>
      </div>
      <Progress percent={percent} status={job.status === 'failed' ? 'exception' : job.status === 'completed' ? 'success' : 'active'}
        format={() => `${completed}/${total}`} />
      <Typography.Text type="secondary">
        Checkpointed after every document · {job.remainingDocumentIds.length} remaining
        {job.results.some(result => result.reused) ? ' · unchanged documents reused' : ''}
      </Typography.Text>
      {job.recoveredAt && <Alert type="info" showIcon message="Recovered after an interruption" description="Only documents without a committed checkpoint were continued." />}
      {job.error && <Alert type="error" showIcon message={job.error} />}
      <Space wrap>
        {(job.status === 'queued' || job.status === 'running') && <Button danger size="small" loading={working} icon={<CloseOutlined />}
          onClick={() => void control('cancel')}>Cancel</Button>}
        {(job.status === 'failed' || job.status === 'cancelled') && <Button size="small" loading={working} icon={<ReloadOutlined />}
          onClick={() => void control('resume')}>Resume remaining</Button>}
        {(job.status === 'completed' || job.status === 'cancelled') && <Button size="small" type="text"
          onClick={() => void db.indexJobs.delete(job.id)}>Dismiss</Button>}
      </Space>
    </Space>
  </List.Item>;
}

interface CenterProps { open: boolean; onClose: () => void; onOpenTest: (id: string) => void; onManagePlugins: () => void; }

export function GenerationCenter({ open, onClose, onOpenTest, onManagePlugins }: CenterProps) {
  const jobs = useLiveQuery(() => db.generationJobs.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const indexJobs = useLiveQuery(() => db.indexJobs.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const [instances, setInstances] = useState(getGenerationConcurrency);
  const [batchSize, setBatchSize] = useState(getGenerationBatchSize);
  const message = getMessageApi();
  useEffect(() => {
    const refresh = () => {
      setInstances(getGenerationConcurrency());
      setBatchSize(getGenerationBatchSize());
    };
    window.addEventListener('quizzer:generation-settings', refresh);
    return () => window.removeEventListener('quizzer:generation-settings', refresh);
  }, []);
  const persistSetting = async (key: 'generation.concurrency' | 'generation.batchSize', value: number) => {
    try { await serviceJson('/api/v1/settings', 'PATCH', { values: { [key]: value } }); }
    catch (error) { message.warning(error instanceof Error ? error.message : 'The setting is saved locally until the service reconnects'); }
  };
  const clearFinished = async () => Promise.all([
    db.generationJobs.bulkDelete(jobs.filter(job => terminalStatuses.has(job.status)).map(job => job.id)),
    db.indexJobs.bulkDelete(indexJobs.filter(job => terminalStatuses.has(job.status)).map(job => job.id)),
  ]);
  const hasFinished = jobs.some(job => terminalStatuses.has(job.status)) || indexJobs.some(job => terminalStatuses.has(job.status));
  return <Modal open={open} width={780} title="Activity" footer={null} onCancel={onClose}>
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert type="info" showIcon message="Background work survives reloads and connection interruptions"
        description="Indexing checkpoints each document. Quiz generation stores every accepted question, so either workflow can continue from its last committed result." />
      <Typography.Title level={5} style={{ margin: 0 }}>Quiz generation</Typography.Title>
      <div className="generation-concurrency">
        <div><Typography.Text strong>Concurrent test instances</Typography.Text><br /><Typography.Text type="secondary">One provider request per test. Changes apply as running requests finish.</Typography.Text></div>
        <Slider min={1} max={10} value={instances} marks={{ 1: '1', 5: '5', 10: '10' }} tooltip={{ formatter: value => `${value} instance${value === 1 ? '' : 's'}` }}
          onChange={value => { setInstances(value); setGenerationConcurrency(value); void pumpGenerationQueue(); }}
          onChangeComplete={value => void persistSetting('generation.concurrency', value)} />
      </div>
      <div className="generation-concurrency">
        <div><Typography.Text strong>Questions per request</Typography.Text><br /><Typography.Text type="secondary">Larger batches are faster; smaller batches checkpoint more often.</Typography.Text></div>
        <Slider min={5} max={25} value={batchSize} marks={{ 5: '5', 10: '10', 20: '20', 25: '25' }} tooltip={{ formatter: value => `${value} questions` }}
          onChange={value => { setBatchSize(value); setGenerationBatchSize(value); }}
          onChangeComplete={value => void persistSetting('generation.batchSize', value)} />
      </div>
      {hasFinished && <Button size="small" onClick={() => void clearFinished()}>Clear finished</Button>}
      <List locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No generation jobs" /> }} dataSource={jobs}
        renderItem={job => <JobItem job={job} onOpenTest={id => { onOpenTest(id); onClose(); }} onManagePlugins={onManagePlugins} />} />
      <Typography.Title level={5} style={{ margin: 0 }}>Document indexing</Typography.Title>
      <List locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No indexing jobs" /> }} dataSource={indexJobs}
        renderItem={job => <IndexJobItem job={job} />} />
    </Space>
  </Modal>;
}

export function GenerationActivity({ onOpen }: { onOpen: () => void }) {
  const activity = useLiveQuery(async () => {
    const [generation, indexing] = await Promise.all([
      db.generationJobs.where('status').anyOf('queued', 'running', 'waiting', 'paused', 'error').toArray(),
      db.indexJobs.where('status').anyOf('queued', 'running', 'failed').toArray(),
    ]);
    return { generation, indexing };
  }, []);
  const count = (activity?.generation.length ?? 0) + (activity?.indexing.length ?? 0);
  if (!count) return null;
  const running = (activity?.generation.filter(job => job.status === 'running').length ?? 0)
    + (activity?.indexing.filter(job => job.status === 'running').length ?? 0);
  const attention = (activity?.generation.filter(job => job.status === 'paused' || job.status === 'waiting' || job.status === 'error').length ?? 0)
    + (activity?.indexing.filter(job => job.status === 'failed').length ?? 0);
  return <Button className="generation-activity" type="primary" onClick={onOpen} icon={running ? <LoadingOutlined spin /> : <PlayCircleOutlined />}>
    <Badge count={count} size="small" offset={[10, -5]}>{running ? `${running} job${running === 1 ? '' : 's'} active` : attention ? `${attention} need attention` : 'Work queued'}</Badge>
  </Button>;
}
