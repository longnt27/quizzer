import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Empty, Input, InputNumber, List, Modal, Radio, Select, Space, Spin, Tag, Typography } from 'antd';
import { formatErrorMessage } from '../utils/errorFormatting';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db, type StoredAppProfile, type StoredGenerationJob } from '../db/db';
import { applyServiceRecord, syncNow } from '../db/serverSync';
import type { CoverageStrategy, GenerationDifficulty, GenerationOptions, GenerationProvider, QuestionType } from '../types';
import { getMessageApi } from '../utils/messageProvider';
import { pumpGenerationQueue } from '../utils/generationQueue';
import { getProviderDefinition, getProviderRoute, getProviderSettings } from '../utils/providerSettings';
import { getProviderPricing } from '../utils/providerPricing';
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
  quick: { label: 'Quick · 10 questions', description: 'A short review of the most important ideas.', counts: [8, 1, 1, 0] },
  balanced: { label: 'Standard · 20 questions', description: 'A balanced quiz for learning and recall.', counts: [15, 3, 2, 0] },
  deep: { label: 'Thorough · 30 questions', description: 'Broader practice with more written and coding questions.', counts: [18, 6, 4, 2] },
};

const hardwareDefaults: Record<StoredAppProfile['hardwareProfile'], { contextBudget: number; rerank: boolean; batchSize: number }> = {
  lite: { contextBudget: 4096, rerank: false, batchSize: 10 },
  balanced: { contextBudget: 8192, rerank: true, batchSize: 15 },
  max: { contextBudget: 16384, rerank: true, batchSize: 20 },
};

const questionTypeLabels: Record<QuestionType, string> = {
  'multiple-choice': 'Multiple choice',
  'fill-blank': 'Fill in the blank',
  reasoning: 'Reasoning',
  coding: 'Coding',
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
  const queriedDocuments = useLiveQuery(() => db.documents.orderBy('createdAt').reverse().toArray(), []);
  const documents = useMemo(() => queriedDocuments ?? [], [queriedDocuments]);
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
  const [questionInstructions, setQuestionInstructions] = useState<Partial<Record<QuestionType, string>>>({});
  const [difficulty, setDifficulty] = useState<GenerationDifficulty>('intermediate');
  const [contextBudget, setContextBudget] = useState(hardwareDefaults[profile.hardwareProfile].contextBudget);
  const [rerank, setRerank] = useState(hardwareDefaults[profile.hardwareProfile].rerank);
  const [validationMaxRounds, setValidationMaxRounds] = useState(5);
  const [minGroundingScore, setMinGroundingScore] = useState(0);
  const [minInstructionMatches, setMinInstructionMatches] = useState(0);
  const [jobBatchSize, setJobBatchSize] = useState(hardwareDefaults[profile.hardwareProfile].batchSize);
  const [preset, setPreset] = useState<QuizPreset>('balanced');
  const [promptProfileId, setPromptProfileId] = useState(BUILT_IN_PROMPT_PROFILE.id);
  const [approvedRouteSignature, setApprovedRouteSignature] = useState('');
  const [costCeilingDollars, setCostCeilingDollars] = useState<number | null>(null);
  const [customInputPrice, setCustomInputPrice] = useState<number | null>(null);
  const [customOutputPrice, setCustomOutputPrice] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [documentTag, setDocumentTag] = useState('all');
  const [documentSort, setDocumentSort] = useState<'newest' | 'oldest' | 'name'>('newest');
  const [saving, setSaving] = useState(false);
  const message = getMessageApi();
  const simple = profile.interfaceMode === 'simple';
  const [presetMultipleChoice, presetFillBlank, presetReasoning, presetCoding] = presets[preset].counts;
  const effectiveCounts = simple
    ? { multipleChoice: presetMultipleChoice, fillBlank: presetFillBlank, reasoning: presetReasoning, coding: presetCoding }
    : { multipleChoice: multipleChoiceCount, fillBlank: fillBlankCount, reasoning: reasoningCount, coding: codingCount };
  const questionCount = effectiveCounts.multipleChoice + effectiveCounts.fillBlank + effectiveCounts.reasoning + effectiveCounts.coding;
  const selectedProvider = getProviderDefinition(provider);
  const promptProfiles = [BUILT_IN_PROMPT_PROFILE, ...customPromptProfiles];
  const promptProfile = promptProfiles.find(item => item.id === promptProfileId) ?? BUILT_IN_PROMPT_PROFILE;
  const selected = documents.filter(document => selectedIds.includes(document.id));
  const primaryKnownPricing = getProviderPricing(provider, model.trim() || undefined);
  const primaryPricing = primaryKnownPricing ?? (customInputPrice !== null && customOutputPrice !== null
    ? { inputMicroUsdPerMillionTokens: Math.round(customInputPrice * 1_000_000), outputMicroUsdPerMillionTokens: Math.round(customOutputPrice * 1_000_000) } : undefined);
  const proposedRoutes = [
    { ...getProviderRoute(provider, model, false), ...(primaryPricing ? { pricing: primaryPricing } : {}) },
    ...failoverProviders.filter(item => item !== provider).map(item => getProviderRoute(item, settings.models[item], false)),
  ];
  const routeSignature = JSON.stringify(proposedRoutes.map(route => ({
    provider: route.provider, model: route.model, privacy: route.privacy, paid: route.paid,
    pricing: route.pricing, usage: route.usage,
  })));
  const finiteCeilingPricingMessage = 'A finite cost ceiling requires explicit input and output pricing for every approved failover route; add prices in Advanced mode or leave the ceiling unlimited';
  const requiresRouteApproval = proposedRoutes.some(route => route.privacy !== 'local');
  const routesApproved = !requiresRouteApproval || approvedRouteSignature === routeSignature;
  const documentTags = useMemo(() => [...new Set(documents.flatMap(document => document.tags))]
    .sort((left, right) => left.localeCompare(right)), [documents]);
  const visible = (() => {
    const needle = query.trim().toLowerCase();
    return documents.filter(document => (!needle || document.name.toLowerCase().includes(needle)
      || document.tags.some(tag => tag.toLowerCase().includes(needle)))
      && (documentTag === 'all' || document.tags.includes(documentTag)))
      .sort((left, right) => documentSort === 'name'
        ? left.name.localeCompare(right.name)
        : documentSort === 'oldest' ? left.createdAt - right.createdAt : right.createdAt - left.createdAt);
  })();

  useEffect(() => {
    if (!configured.providers.length || configured.providers.some(item => item.id === provider)) return;
    const next = configured.providers[0].id;
    setProvider(next);
    setModel(settings.models[next]);
  }, [configured.providers, provider, settings.models]);

  const toggle = (id: string) => setSelectedIds(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);

  const documentPicker = <>
    <Space.Compact block>
      <Input.Search aria-label="Find documents" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find by name or tag" />
      <Select aria-label="Filter documents by tag" value={documentTag} onChange={setDocumentTag} style={{ width: 170 }}
        options={[{ value: 'all', label: 'All tags' }, ...documentTags.map(tag => ({ value: tag, label: tag }))]} />
      <Select aria-label="Sort documents" value={documentSort} onChange={setDocumentSort} style={{ width: 150 }} options={[
        { value: 'newest', label: 'Newest' }, { value: 'oldest', label: 'Oldest' }, { value: 'name', label: 'Name' },
      ]} />
    </Space.Compact>
    <List bordered size="small" style={{ maxHeight: 290, overflowY: 'auto' }} dataSource={visible}
      pagination={visible.length > 50 ? { pageSize: 50, size: 'small', showSizeChanger: false } : false}
      renderItem={document => <List.Item onClick={() => toggle(document.id)} style={{ cursor: 'pointer' }}>
        <Checkbox aria-label={`Select ${document.name}`} checked={selectedIds.includes(document.id)} style={{ marginRight: 12 }} />
        <List.Item.Meta title={document.name} description={document.tags.map(tag => <Tag key={tag}>{tag}</Tag>)} />
      </List.Item>} />
    <Typography.Text type="secondary">{selected.length} document{selected.length === 1 ? '' : 's'} selected</Typography.Text>
  </>;

  const resetAdvancedControls = () => {
    const defaults = hardwareDefaults[profile.hardwareProfile];
    setDifficulty('intermediate');
    setContextBudget(defaults.contextBudget);
    setRerank(defaults.rerank);
    setValidationMaxRounds(5);
    setMinGroundingScore(0);
    setMinInstructionMatches(0);
    setJobBatchSize(defaults.batchSize);
  };

  const create = async () => {
    if (!selected.length) return;
    if (questionCount < 1 || questionCount > 200) return message.error('Choose between 1 and 200 questions in total.');
    if (!configured.providers.some(item => item.id === provider)) return message.error('Connect an AI provider in Plugins & models first.');
    if (!routesApproved) return message.error('Approve the selected AI routes before queueing this test.');
    if (costCeilingDollars !== null && proposedRoutes.some(route => !route.pricing)) return message.error(finiteCeilingPricingMessage);
    setSaving(true);
    try {
      await syncNow();
      const resolved = await serviceRequest<ResolvedSettings>('/api/v1/settings');
      const hardwareProfile = resolved.values['hardware.profile'];
      const retrievalMode = resolved.values['retrieval.mode'];
      const resolvedContextBudget = resolved.values['retrieval.contextBudget'];
      const resolvedRerank = resolved.values['retrieval.rerank'];
      if (typeof hardwareProfile !== 'string' || !['lite', 'balanced', 'max'].includes(hardwareProfile)
        || (retrievalMode !== 'sparse' && retrievalMode !== 'hybrid')
        || typeof resolvedContextBudget !== 'number' || typeof resolvedRerank !== 'boolean') {
        throw new Error('The resolved retrieval settings are invalid. Review Settings and try again.');
      }
      const ragOverride = profile.interfaceMode === 'advanced'
        && (contextBudget !== resolvedContextBudget || rerank !== resolvedRerank);
      const normalizedQuestionInstructions = Object.fromEntries(Object.entries(questionInstructions)
        .map(([type, instruction]) => [type, instruction?.trim()])
        .filter((entry): entry is [string, string] => Boolean(entry[1]))) as Partial<Record<QuestionType, string>>;
      const options: GenerationOptions = {
        provider, model: model.trim() || undefined, questionCount,
        questionCounts: effectiveCounts,
        multipleChoiceMode,
        coverageStrategy: mode === 'combined' ? coverageStrategy : 'balanced',
        customInstruction: customInstruction.trim() || undefined,
        ...(Object.keys(normalizedQuestionInstructions).length ? { questionInstructions: normalizedQuestionInstructions } : {}),
        promptProfileSnapshot: snapshotPromptProfile(promptProfile),
        ragProfile: { id: hardwareProfile, retrieval: retrievalMode, contextBudget, rerank, ...(ragOverride ? { override: true } : {}) },
        ...(profile.interfaceMode === 'advanced' ? {
          generationProfile: {
            difficulty,
            validation: { maxRounds: validationMaxRounds, minGroundingScore, minInstructionMatches },
            batchSize: jobBatchSize,
          },
        } : {}),
        routeChain: proposedRoutes.map(route => ({ ...route, approved: true })),
        resolvedSettings: resolved.values,
        ...(profile.interfaceMode === 'advanced' && costCeilingDollars !== null
          ? { costCeilingMicroUsd: Math.round(costCeilingDollars * 1_000_000) }
          : {}),
      };
      const requestedSources = simple
        ? [{
          name: selected.length === 1 ? `${selected[0].name} quiz` : `Quiz from ${selected.length} documents`,
          documentIds: selected.map(document => document.id),
        }]
        : mode === 'combined'
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
      message.error(formatErrorMessage(error, 'generation'));
      setSaving(false);
    }
  };

  return (
    <Modal open width={760} title="Create tests from documents" onCancel={onClose}
      styles={{ body: { maxHeight: 'calc(100vh - 190px)', overflowY: 'auto' } }} footer={(_, { CancelBtn }) => <>
      {!saving && <CancelBtn />}
      {saving ? <Space><Spin size="small" /> Queueing tests…</Space>
        : selected.length > 0 && questionCount >= 1 && questionCount <= 200 && configured.providers.length > 0
          ? <Button type="primary" disabled={!routesApproved} onClick={() => void create()}>{simple ? 'Create test' : mode === 'combined' ? 'Queue combined test' : `Queue ${selected.length} separate test(s)`}</Button>
          : null}
    </>}>
      {!documents.length ? <Empty description="Add documents to your library before creating a test" /> : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {configured.loading && !configured.providers.length && <Space><Spin size="small" /><Typography.Text type="secondary">Checking connected providers…</Typography.Text></Space>}
          {!configured.loading && !configured.providers.length && <Alert type="warning" showIcon message="No AI provider is configured"
            description="Connect a CLI agent or add an API key before creating a test."
            action={<Button size="small" onClick={onManagePlugins}>Open plugins</Button>} />}
          
          {simple && <div className="simple-test-flow">
            <section>
              <Typography.Title level={5}>1. Choose your documents</Typography.Title>
              {documentPicker}
            </section>
            <section>
              <Typography.Title level={5}>2. Choose a quiz length</Typography.Title>
              <Select aria-label="Quiz length" value={preset} onChange={setPreset} style={{ width: '100%' }} options={Object.entries(presets).map(([value, item]) => ({ value, label: item.label }))} />
              <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>{presets[preset].description}</Typography.Paragraph>
            </section>
            <section>
              <Typography.Title level={5}>3. Add a learning goal <Typography.Text type="secondary">(optional)</Typography.Text></Typography.Title>
              <Input.TextArea aria-label="Learning goal" rows={3} maxLength={2000} value={customInstruction} onChange={event => setCustomInstruction(event.target.value)}
                placeholder="For example: Focus on the ideas I am most likely to forget" />
            </section>
          </div>}

          {!simple && <>
            <Radio.Group value={mode} onChange={event => setMode(event.target.value)} optionType="button" buttonStyle="solid"
              options={[{ label: 'One combined test', value: 'combined' }, { label: 'Separate test per document', value: 'separate' }]} />
            
            {mode === 'combined' && <Input value={name} onChange={event => setName(event.target.value)} addonBefore="Test name" />}
            
            {documentPicker}

            <Collapse items={[
              {
                key: 'test-content',
                label: 'Custom test content',
                children: <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  {profile.interfaceMode === 'advanced' && <div className="question-count-grid">
                    <label><Typography.Text strong>Multiple choice</Typography.Text><InputNumber min={0} max={200} value={multipleChoiceCount} onChange={value => setMultipleChoiceCount(value ?? 0)} /></label>
                    <label><Typography.Text strong>Fill in the blank</Typography.Text><InputNumber min={0} max={200} value={fillBlankCount} onChange={value => setFillBlankCount(value ?? 0)} /></label>
                    <label><Typography.Text strong>Reasoning</Typography.Text><InputNumber min={0} max={200} value={reasoningCount} onChange={value => setReasoningCount(value ?? 0)} /></label>
                    <label><Typography.Text strong>Coding</Typography.Text><InputNumber min={0} max={200} value={codingCount} onChange={value => setCodingCount(value ?? 0)} /></label>
                    <div className="question-count-total"><Typography.Text type="secondary">Total</Typography.Text><Typography.Text strong>{questionCount}</Typography.Text></div>
                  </div>}

                  {profile.interfaceMode === 'advanced' && <div>
                    <Typography.Text strong>Prompt profile</Typography.Text>
                    <Select value={promptProfile.id} onChange={setPromptProfileId} style={{ width: '100%', marginTop: 8 }}
                      options={promptProfiles.map(item => ({ value: item.id, label: `${item.name} · v${item.version}${item.builtIn ? ' · built in' : ''}` }))} />
                    <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>{promptProfile.description || 'Custom generation, grading, and retrieval instructions.'}</Typography.Paragraph>
                    <Button type="link" size="small" onClick={onOpenPromptStudio}>Open Prompt Studio</Button>
                  </div>}

                  {profile.interfaceMode === 'advanced' && <div>
                    <Typography.Text strong>Target difficulty</Typography.Text>
                    <div style={{ marginTop: 8 }}>
                      <Select aria-label="Target difficulty" value={difficulty} onChange={setDifficulty} style={{ width: 170 }} options={[
                        { value: 'introductory', label: 'Introductory' },
                        { value: 'intermediate', label: 'Intermediate' },
                        { value: 'advanced', label: 'Advanced' },
                      ]} />
                    </div>
                  </div>}

                  {profile.interfaceMode === 'advanced' && multipleChoiceCount > 0 && <div>
                    <Typography.Text strong>Multiple-choice answer style</Typography.Text><br />
                    <Radio.Group value={multipleChoiceMode} onChange={event => setMultipleChoiceMode(event.target.value)}
                      className="answer-mode-selector" optionType="button" buttonStyle="solid" style={{ marginTop: 8 }} options={[
                        { label: 'Exactly one correct answer', value: 'single' },
                        { label: 'Multiple correct answers', value: 'multiple' },
                      ]} />
                  </div>}

                  <div>
                    <Typography.Text strong>Instructions for every question <Typography.Text type="secondary">(optional)</Typography.Text></Typography.Text>
                    <Input.TextArea data-onboarding-target="learning-instruction" rows={3} maxLength={2000} showCount value={customInstruction} onChange={event => setCustomInstruction(event.target.value)}
                      placeholder="For example: emphasize operational tradeoffs" style={{ marginTop: 8 }} />
                  </div>

                  <Collapse ghost items={[{
                    key: 'question-instructions',
                    label: 'Instructions by question type',
                    children: <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                      {(Object.keys(questionTypeLabels) as QuestionType[]).filter(type => ({
                        'multiple-choice': effectiveCounts.multipleChoice,
                        'fill-blank': effectiveCounts.fillBlank,
                        reasoning: effectiveCounts.reasoning,
                        coding: effectiveCounts.coding,
                      })[type] > 0).map(type => <label key={type}>
                        <Typography.Text>{questionTypeLabels[type]}</Typography.Text>
                        <Input.TextArea aria-label={`${questionTypeLabels[type]} instruction`} rows={2} maxLength={2000} showCount
                          value={questionInstructions[type] ?? ''}
                          onChange={event => setQuestionInstructions(current => ({ ...current, [type]: event.target.value }))}
                          placeholder={`Optional guidance only for ${questionTypeLabels[type].toLowerCase()} questions`} />
                      </label>)}
                    </Space>,
                  }]} />

                  {profile.interfaceMode === 'advanced' && mode === 'combined' && selected.length > 1 && <div>
                    <Typography.Text strong>Document coverage strategy</Typography.Text><br />
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
                </Space>
              },
              {
                key: 'provider-settings',
                label: 'Custom provider settings',
                children: <Space direction="vertical" size="middle" style={{ width: '100%' }}>
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
                        label: `${item.label} · ${item.kind === 'api' ? 'remote API / may incur cost' : item.kind === 'plugin' ? 'local plugin' : 'signed-in agent'}`,
                      }))} />
                    <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
                      Selecting a route pre-approves sending only unfinished source batches to it. Routes run in the order shown; unselected routes always require approval.
                    </Typography.Paragraph>
                  </div>}

                  {profile.interfaceMode === 'advanced' && provider && !primaryKnownPricing && getProviderDefinition(provider).kind === 'api' && <div>
                    <Typography.Text strong>Custom model pricing <Typography.Text type="secondary">(USD per 1M tokens)</Typography.Text></Typography.Text>
                    <Space wrap style={{ width: '100%', marginTop: 8 }}>
                      <InputNumber aria-label="Input price per million tokens" min={0} max={100000} precision={6} step={0.01} value={customInputPrice}
                        onChange={setCustomInputPrice} addonBefore="Input $" />
                      <InputNumber aria-label="Output price per million tokens" min={0} max={100000} precision={6} step={0.01} value={customOutputPrice}
                        onChange={setCustomOutputPrice} addonBefore="Output $" />
                    </Space>
                    <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
                      Quizzer does not guess prices for unknown models. Enter the provider’s current input and output rates before using a finite ceiling; the values are snapshotted into this test.
                    </Typography.Paragraph>
                  </div>}

                  {profile.interfaceMode === 'advanced' && <div>
                    <Typography.Text strong>Advanced generation controls</Typography.Text>
                    <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 8 }}>
                      <Space wrap>
                        <label>Context budget <InputNumber aria-label="Per-test context budget" min={1024} max={65536} step={512} value={contextBudget} onChange={value => setContextBudget(value ?? 4096)} /></label>
                        <label>Questions per request <InputNumber aria-label="Per-test batch size" min={5} max={25} value={jobBatchSize} onChange={value => setJobBatchSize(value ?? 10)} /></label>
                      </Space>
                      <Space wrap>
                        <Checkbox checked={rerank} onChange={event => setRerank(event.target.checked)}>Rerank retrieved evidence</Checkbox>
                        <label>Validation rounds <InputNumber aria-label="Validation round limit" min={1} max={5} value={validationMaxRounds} onChange={value => setValidationMaxRounds(value ?? 5)} /></label>
                        <label>Minimum grounding score <InputNumber aria-label="Minimum grounding score" min={0} max={1} step={0.05} value={minGroundingScore} onChange={value => setMinGroundingScore(value ?? 0)} /></label>
                        <label>Minimum instruction matches <InputNumber aria-label="Minimum instruction matches" min={0} max={10} value={minInstructionMatches} onChange={value => setMinInstructionMatches(value ?? 0)} /></label>
                      </Space>
                      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                        Larger context budgets and reranking use more local memory. Higher validation thresholds may reject more candidates and refill fewer slots before the round limit. Requests within one test remain sequential and idempotent; shared Settings concurrency only controls separate tests.
                      </Typography.Paragraph>
                      <Typography.Text type="secondary">Estimated retrieval budget: up to {contextBudget.toLocaleString()} tokens per request · selected route receives only retrieved excerpts and relevant images.</Typography.Text>
                      <Button type="link" size="small" onClick={resetAdvancedControls} style={{ padding: 0, alignSelf: 'flex-start' }}>Reset controls to {profile.hardwareProfile} profile defaults</Button>
                    </Space>
                  </div>}

                  {profile.interfaceMode === 'advanced' && <div>
                    <Typography.Text strong>Generation cost ceiling <Typography.Text type="secondary">(optional)</Typography.Text></Typography.Text>
                    <InputNumber aria-label="Generation cost ceiling in US dollars" min={0} max={9_000_000_000} precision={2} step={1} value={costCeilingDollars}
                      onChange={value => setCostCeilingDollars(value)} addonBefore="$" addonAfter="USD" style={{ width: '100%', marginTop: 8 }} />
                    <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0' }}>
                      Leave blank for unlimited. This is an approximate maximum for provider-priced generation; Quizzer stores it internally as micro-USD (1 USD = 1,000,000 micro-USD) and pauses before an approved ceiling would be exceeded.
                    </Typography.Paragraph>
                  </div>}

                  {profile.interfaceMode === 'advanced' && costCeilingDollars !== null && proposedRoutes.some(route => !route.pricing) && <Alert type="error" showIcon
                    message="Finite ceiling needs pricing for every approved route"
                    description={finiteCeilingPricingMessage} />}
                </Space>
              }
            ]} />
            {!!configured.providers.length && !simple && !requiresRouteApproval && <Alert type="success" showIcon
              message="Local generation"
              description="Selected excerpts stay on this device, and no remote-provider charge is expected." />}
            {!!configured.providers.length && !simple && requiresRouteApproval && <Alert type={proposedRoutes.some(route => route.paid) ? 'warning' : 'info'} showIcon
              message={proposedRoutes.some(route => route.paid) ? 'Remote generation may incur provider charges' : 'Remote generation shares selected excerpts'}
              description={<Checkbox checked={routesApproved} onChange={event => setApprovedRouteSignature(event.target.checked ? routeSignature : '')}>
                Approve sending selected excerpts and relevant images to the listed AI routes{proposedRoutes.some(route => route.paid) ? ' and any resulting provider charges' : ''}.
              </Checkbox>} />}
            
            {!saving && !simple && <Typography.Text type="secondary">Provider defaults are saved in <Button type="link" size="small" onClick={onManagePlugins}>Plugins & models</Button>. You can override the model for this job.</Typography.Text>}
          </>}
          {!!configured.providers.length && simple && requiresRouteApproval && <Alert type={proposedRoutes.some(route => route.paid) ? 'warning' : 'info'} showIcon
            message={`Use ${selectedProvider.label} for this test?`}
            description={<Space direction="vertical" size="small">
              <Typography.Text>
                Quizzer will send only the relevant excerpts from your selected documents to {selectedProvider.label}{proposedRoutes.some(route => route.paid) ? '. Provider charges may apply.' : '.'}
              </Typography.Text>
              <Checkbox checked={routesApproved} onChange={event => setApprovedRouteSignature(event.target.checked ? routeSignature : '')}>
                Allow Quizzer to send these excerpts for this test.
              </Checkbox>
              <Button type="link" size="small" onClick={onManagePlugins} style={{ padding: 0, alignSelf: 'flex-start' }}>Change AI</Button>
            </Space>} />}

        </Space>
      )}
    </Modal>
  );
}
