import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, InputNumber, List, Modal, Radio, Select, Space, Spin, Tag, Typography } from 'antd';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db, type StoredAppProfile, type StoredGenerationJob } from '../db/db';
import { applyServiceRecord, syncNow } from '../db/serverSync';
import type { CoverageStrategy, GenerationOptions, GenerationProvider } from '../types';
import { getMessageApi } from '../utils/messageProvider';
import { pumpGenerationQueue } from '../utils/generationQueue';
import { getProviderDefinition, getProviderRoute, getProviderSettings } from '../utils/providerSettings';
import { useConfiguredProviders } from '../utils/useConfiguredProviders';
import { BUILT_IN_PROMPT_PROFILE, snapshotPromptProfile } from '../utils/promptProfiles';
import { serviceJson, serviceRequest } from '../utils/serviceApi';

interface Props {
  onClose: () => void;
  onManagePlugins: () => void;
  onOpenPromptStudio: () => void;
  onCreated?: (jobs: StoredGenerationJob[]) => void | Promise<void>;
  profile: StoredAppProfile;
}
type CreationMode = 'combined' | 'separate';
type QuizPreset = 'quick' | 'balanced' | 'deep';
type ResolvedSettings = { profile: string; values: Record<string, string | number | boolean> };

const presets: Record<QuizPreset, { label: string; description: string; counts: [number, number, number, number] }> = {
  quick: { label: 'Quick review · 10 questions', description: 'Fast recall with a small reasoning check.', counts: [8, 1, 1, 0] },
  balanced: { label: 'Balanced learning · 20 questions', description: 'A practical mix of recall and explanation.', counts: [15, 3, 2, 0] },
  deep: { label: 'Deep practice · 30 questions', description: 'More reasoning, fill-in, and coding practice.', counts: [18, 6, 4, 2] },
};

const uniqueTestName = (requestedName: string, usedNames: Set<string>) => {
  const base = requestedName.trim() || 'Untitled test';
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate.toLocaleLowerCase())) candidate = `${base} (${suffix++})`;
  usedNames.add(candidate.toLocaleLowerCase());
  return candidate;
};

export default function AddTestModal({ onClose, onManagePlugins, onOpenPromptStudio, onCreated, profile }: Props) {
  const settings = useMemo(getProviderSettings, []);
  const configured = useConfiguredProviders();
  const documents = useLiveQuery(() => db.documents.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const customPromptProfiles = useLiveQuery(() => db.promptProfiles.orderBy('updatedAt').reverse().toArray(), []) ?? [];
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<CreationMode>('combined');
  const [name, setName] = useState('Combined quiz');
  const [provider, setProvider] = useState<GenerationOptions['provider']>(settings.defaultProvider);
  const [model, setModel] = useState(settings.models[settings.defaultProvider]);
  const [failoverProviders, setFailoverProviders] = useState<GenerationProvider[]>([]);
  const [multipleChoiceCount, setMultipleChoiceCount] = useState(15);
  const [fillBlankCount, setFillBlankCount] = useState(3);
  const [reasoningCount, setReasoningCount] = useState(2);
  const [codingCount, setCodingCount] = useState(0);
  const [multipleChoiceMode, setMultipleChoiceMode] = useState<'single' | 'multiple'>('single');
  const [coverageStrategy, setCoverageStrategy] = useState<CoverageStrategy>('balanced');
  const [customInstruction, setCustomInstruction] = useState(profile.defaultLearningInstruction ?? '');
  const [preset, setPreset] = useState<QuizPreset>('balanced');
  const [promptProfileId, setPromptProfileId] = useState(BUILT_IN_PROMPT_PROFILE.id);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const message = getMessageApi();
  const questionCount = multipleChoiceCount + fillBlankCount + reasoningCount + codingCount;
  const selectedProvider = getProviderDefinition(provider);
  const promptProfiles = [BUILT_IN_PROMPT_PROFILE, ...customPromptProfiles];
  const promptProfile = promptProfiles.find(item => item.id === promptProfileId) ?? BUILT_IN_PROMPT_PROFILE;
  const selected = documents.filter(document => selectedIds.includes(document.id));
  const visible = (() => {
    const needle = query.trim().toLowerCase();
    return documents.filter(document => !needle || document.name.toLowerCase().includes(needle)
      || document.tags.some(tag => tag.toLowerCase().includes(needle)));
  })();

  useEffect(() => {
    if (!configured.providers.length || configured.providers.some(item => item.id === provider)) return;
    const next = configured.providers[0].id;
    setProvider(next);
    setModel(settings.models[next]);
  }, [configured.providers, provider, settings.models]);

  const toggle = (id: string) => setSelectedIds(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);

  const applyPreset = (next: QuizPreset) => {
    setPreset(next);
    const [multipleChoice, fillBlank, reasoning, coding] = presets[next].counts;
    setMultipleChoiceCount(multipleChoice);
    setFillBlankCount(fillBlank);
    setReasoningCount(reasoning);
    setCodingCount(coding);
  };

  const create = async () => {
    if (!selected.length) return;
    if (questionCount < 1 || questionCount > 200) return message.error('Choose between 1 and 200 questions in total');
    if (!configured.providers.some(item => item.id === provider)) return message.error('Connect an AI provider in Plugins & models first');
    setSaving(true);
    try {
      await syncNow();
      const resolved = await serviceRequest<ResolvedSettings>('/api/v1/settings');
      const hardwareProfile = resolved.values['hardware.profile'];
      const retrievalMode = resolved.values['retrieval.mode'];
      const contextBudget = resolved.values['retrieval.contextBudget'];
      const rerank = resolved.values['retrieval.rerank'];
      if (typeof hardwareProfile !== 'string' || !['lite', 'balanced', 'max'].includes(hardwareProfile)
        || (retrievalMode !== 'sparse' && retrievalMode !== 'hybrid')
        || typeof contextBudget !== 'number' || typeof rerank !== 'boolean') {
        throw new Error('The resolved retrieval settings are invalid. Review Settings and try again.');
      }
      const options: GenerationOptions = {
        provider, model: model.trim() || undefined, questionCount,
        questionCounts: { multipleChoice: multipleChoiceCount, fillBlank: fillBlankCount, reasoning: reasoningCount, coding: codingCount },
        multipleChoiceMode,
        coverageStrategy: mode === 'combined' ? coverageStrategy : 'balanced',
        customInstruction: customInstruction.trim() || undefined,
        promptProfileSnapshot: snapshotPromptProfile(promptProfile),
        ragProfile: { id: hardwareProfile, retrieval: retrievalMode, contextBudget, rerank },
        routeChain: [
          getProviderRoute(provider, model, true),
          ...failoverProviders.filter(item => item !== provider).map(item => getProviderRoute(item, settings.models[item], true)),
        ],
        resolvedSettings: resolved.values,
      };
      const requestedSources = mode === 'combined'
        ? [{ name: name.trim() || 'Combined quiz', documentIds: selected.map(document => document.id) }]
        : selected.map(document => ({ name: document.name, documentIds: [document.id] }));
      const [savedTests, existingJobs] = await Promise.all([db.tests.toArray(), db.generationJobs.toArray()]);
      const usedNames = new Set([
        ...savedTests.map(test => test.name.toLocaleLowerCase()),
        ...existingJobs.filter(job => job.status !== 'cancelled').map(job => job.name.toLocaleLowerCase()),
      ]);
      const sources = requestedSources.map(source => ({ ...source, name: uniqueTestName(source.name, usedNames) }));
      const now = Date.now();
      const jobs: StoredGenerationJob[] = sources.map((source, index) => ({
        id: uuidv4(), testId: uuidv4(), name: source.name, documentIds: source.documentIds,
        createdAt: now + index, updatedAt: now, status: 'queued', options,
        questions: [], rejected: 0, rounds: {},
      }));
      const created = await serviceJson<{ jobs: StoredGenerationJob[] }>('/api/v1/jobs', 'POST', { jobs });
      await Promise.all(created.jobs.map(job => applyServiceRecord('generationJobs', job.id, job)));
      void pumpGenerationQueue();
      await onCreated?.(created.jobs);
      message.success(`${jobs.length} test${jobs.length === 1 ? '' : 's'} queued. You can keep using Quizzer while generation runs.`);
      onClose();
    } catch (error) {
      message.error((error as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal open width={760} title="Create tests from documents" onCancel={onClose} footer={(_, { CancelBtn }) => <>
      {!saving && <CancelBtn />}
      {saving ? <Space><Spin size="small" /> Queueing tests…</Space>
        : selected.length > 0 && questionCount >= 1 && questionCount <= 200 && configured.providers.length > 0
          ? <Button type="primary" onClick={() => void create()}>{mode === 'combined' ? 'Queue combined test' : `Queue ${selected.length} separate test(s)`}</Button>
          : null}
    </>}>
      {!documents.length ? <Empty description="Add documents to your library before creating a test" /> : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert type="info" showIcon message="Generation runs in the background"
            description="Completed tests appear immediately. Each configured instance works on a different test, while batches within a test run sequentially to reduce duplicates." />
          <Radio.Group value={mode} onChange={event => setMode(event.target.value)} optionType="button" buttonStyle="solid"
            options={[{ label: 'One combined test', value: 'combined' }, { label: 'Separate test per document', value: 'separate' }]} />
          {mode === 'combined' && <Input value={name} onChange={event => setName(event.target.value)} addonBefore="Test name" />}
          {configured.loading && !configured.providers.length && <Space><Spin size="small" /><Typography.Text type="secondary">Checking connected providers…</Typography.Text></Space>}
          {!configured.loading && !configured.providers.length && <Alert type="warning" showIcon message="No AI provider is configured"
            description="Connect a CLI agent or add an API key before creating a test."
            action={<Button size="small" onClick={onManagePlugins}>Open plugins</Button>} />}
          {!!configured.providers.length && profile.interfaceMode === 'advanced' && <Space wrap>
            <Typography.Text>Provider</Typography.Text>
            <Select value={provider} onChange={next => { setProvider(next); setModel(settings.models[next]); }} style={{ width: 190 }}
              options={configured.providers.map(item => ({ label: item.label, value: item.id }))} />
            <Input value={model} onChange={event => setModel(event.target.value)} addonBefore="Model" placeholder={selectedProvider.defaultModel || 'Provider default'} style={{ width: 280 }} />
          </Space>}
          {!!configured.providers.length && profile.interfaceMode === 'advanced' && <div>
            <Typography.Text strong>Automatic failover routes</Typography.Text>
            <Select mode="multiple" value={failoverProviders.filter(item => item !== provider)}
              onChange={values => setFailoverProviders(values as GenerationProvider[])} style={{ width: '100%', marginTop: 8 }}
              placeholder="Pause for approval when the primary route fails"
              options={configured.providers.filter(item => item.id !== provider).map(item => ({
                value: item.id,
                label: `${item.label} · ${item.kind === 'api' ? 'remote API / may incur cost' : 'signed-in agent'}`,
              }))} />
            <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
              Selecting a route pre-approves sending only unfinished source batches to it. Routes run in the order shown; unselected routes always require approval.
            </Typography.Paragraph>
          </div>}
          {profile.interfaceMode === 'advanced' && <div>
            <Typography.Text strong>Prompt profile</Typography.Text>
            <Select value={promptProfile.id} onChange={setPromptProfileId} style={{ width: '100%', marginTop: 8 }}
              options={promptProfiles.map(item => ({ value: item.id, label: `${item.name} · v${item.version}${item.builtIn ? ' · built in' : ''}` }))} />
            <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>{promptProfile.description || 'Custom generation, grading, and retrieval instructions.'}</Typography.Paragraph>
            <Button type="link" size="small" onClick={onOpenPromptStudio}>Open Prompt Studio</Button>
          </div>}
          {profile.interfaceMode === 'simple' && <div>
            <Typography.Text strong>Recommended preset</Typography.Text>
            <Select value={preset} onChange={applyPreset} style={{ width: '100%', marginTop: 8 }} options={Object.entries(presets).map(([value, item]) => ({ value, label: item.label }))} />
            <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>{presets[preset].description}</Typography.Paragraph>
          </div>}
          {profile.interfaceMode === 'advanced' && <div className="question-count-grid">
            <label><Typography.Text strong>Multiple choice</Typography.Text><InputNumber min={0} max={200} value={multipleChoiceCount} onChange={value => setMultipleChoiceCount(value ?? 0)} /></label>
            <label><Typography.Text strong>Fill in the blank</Typography.Text><InputNumber min={0} max={200} value={fillBlankCount} onChange={value => setFillBlankCount(value ?? 0)} /></label>
            <label><Typography.Text strong>Reasoning</Typography.Text><InputNumber min={0} max={200} value={reasoningCount} onChange={value => setReasoningCount(value ?? 0)} /></label>
            <label><Typography.Text strong>Coding</Typography.Text><InputNumber min={0} max={200} value={codingCount} onChange={value => setCodingCount(value ?? 0)} /></label>
            <div className="question-count-total"><Typography.Text type="secondary">Total</Typography.Text><Typography.Text strong>{questionCount}</Typography.Text></div>
          </div>}
          {profile.interfaceMode === 'advanced' && multipleChoiceCount > 0 && <div>
            <Typography.Text strong>Multiple-choice answer style</Typography.Text><br />
            <Radio.Group value={multipleChoiceMode} onChange={event => setMultipleChoiceMode(event.target.value)}
              className="answer-mode-selector" optionType="button" buttonStyle="solid" style={{ marginTop: 8 }} options={[
                { label: 'Exactly one correct answer', value: 'single' },
                { label: 'Multiple correct answers', value: 'multiple' },
              ]} />
          </div>}
          {profile.interfaceMode === 'advanced' && mode === 'combined' && selected.length > 1 && <div>
            <Typography.Text strong>Document coverage</Typography.Text><br />
            <Select value={coverageStrategy} onChange={setCoverageStrategy} style={{ width: '100%', marginTop: 8 }} options={[
              { value: 'balanced', label: 'Balanced — spread questions evenly across documents' },
              { value: 'proportional', label: 'Proportional — give larger documents more questions' },
              { value: 'ai-selected', label: 'AI-selected — prioritize semantically central material' },
              { value: 'cross-document', label: 'Cross-document — compare material from 2–3 documents' },
            ]} />
            <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
              Quizzer sends only the assigned page-aware chunks for each batch, keeping large combined tests within a fixed prompt budget.
            </Typography.Paragraph>
          </div>}
          {mode === 'combined' && selected.length > questionCount && questionCount > 0 && <Alert type="warning" showIcon
            message={`${questionCount} questions cannot represent all ${selected.length} documents`}
            description={coverageStrategy === 'ai-selected'
              ? 'AI-selected coverage will prioritize the most central material. Increase the question count if every document must appear.'
              : 'Quizzer will sample across the selection. Increase the question count to guarantee at least one question per document.'} />}
          {questionCount < 1 && <Alert type="error" showIcon message="Choose at least one question." />}
          {questionCount > 200 && <Alert type="error" showIcon message="A test can contain at most 200 questions." />}
          <div>
            <Typography.Text strong>Custom learning instruction <Typography.Text type="secondary">(optional)</Typography.Text></Typography.Text>
            <Input.TextArea rows={3} maxLength={2000} showCount value={customInstruction} onChange={event => setCustomInstruction(event.target.value)}
              placeholder="For example: coding questions about Terraform only" style={{ marginTop: 8 }} />
          </div>
          {!!configured.providers.length && profile.interfaceMode === 'simple' && <Alert type="info" showIcon
            message={`Privacy & cost review · ${selectedProvider.label}`}
            description={<span>Quizzer sends only selected source excerpts and, when supported, relevant images to this route. Provider charges and data handling may apply. <Button type="link" size="small" onClick={onManagePlugins}>Change AI</Button></span>} />}
          {!saving && <Typography.Text type="secondary">Provider defaults are saved in <Button type="link" size="small" onClick={onManagePlugins}>Plugins & models</Button>. You can override the model for this job.</Typography.Text>}
          <Input.Search value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter documents by name or tag" />
          <List bordered size="small" style={{ maxHeight: 290, overflowY: 'auto' }} dataSource={visible}
            renderItem={document => <List.Item onClick={() => toggle(document.id)} style={{ cursor: 'pointer' }}>
              <Checkbox checked={selectedIds.includes(document.id)} style={{ marginRight: 12 }} />
              <List.Item.Meta title={document.name} description={document.tags.map(tag => <Tag key={tag}>{tag}</Tag>)} />
            </List.Item>} />
          <Typography.Text type="secondary">{selected.length} document(s) selected</Typography.Text>
        </Space>
      )}
    </Modal>
  );
}
