import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, InputNumber, List, Modal, Radio, Select, Space, Spin, Tag, Typography } from 'antd';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db, type StoredGenerationJob } from '../db/db';
import type { CoverageStrategy, GenerationOptions } from '../types';
import { getMessageApi } from '../utils/messageProvider';
import { pumpGenerationQueue } from '../utils/generationQueue';
import { getProviderDefinition, getProviderSettings } from '../utils/providerSettings';
import { useConfiguredProviders } from '../utils/useConfiguredProviders';

interface Props { onClose: () => void; onManagePlugins: () => void; }
type CreationMode = 'combined' | 'separate';

const uniqueTestName = (requestedName: string, usedNames: Set<string>) => {
  const base = requestedName.trim() || 'Untitled test';
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate.toLocaleLowerCase())) candidate = `${base} (${suffix++})`;
  usedNames.add(candidate.toLocaleLowerCase());
  return candidate;
};

export default function AddTestModal({ onClose, onManagePlugins }: Props) {
  const settings = useMemo(getProviderSettings, []);
  const configured = useConfiguredProviders();
  const documents = useLiveQuery(() => db.documents.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<CreationMode>('combined');
  const [name, setName] = useState('Combined quiz');
  const [provider, setProvider] = useState<GenerationOptions['provider']>(settings.defaultProvider);
  const [model, setModel] = useState(settings.models[settings.defaultProvider]);
  const [multipleChoiceCount, setMultipleChoiceCount] = useState(15);
  const [fillBlankCount, setFillBlankCount] = useState(3);
  const [reasoningCount, setReasoningCount] = useState(2);
  const [codingCount, setCodingCount] = useState(0);
  const [multipleChoiceMode, setMultipleChoiceMode] = useState<'single' | 'multiple'>('single');
  const [coverageStrategy, setCoverageStrategy] = useState<CoverageStrategy>('balanced');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const message = getMessageApi();
  const questionCount = multipleChoiceCount + fillBlankCount + reasoningCount + codingCount;
  const selectedProvider = getProviderDefinition(provider);
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

  const create = async () => {
    if (!selected.length) return;
    if (questionCount < 1 || questionCount > 200) return message.error('Choose between 1 and 200 questions in total');
    if (!configured.providers.some(item => item.id === provider)) return message.error('Connect an AI provider in Plugins & models first');
    setSaving(true);
    try {
      const options: GenerationOptions = {
        provider, model: model.trim() || undefined, questionCount,
        questionCounts: { multipleChoice: multipleChoiceCount, fillBlank: fillBlankCount, reasoning: reasoningCount, coding: codingCount },
        multipleChoiceMode,
        coverageStrategy: mode === 'combined' ? coverageStrategy : 'balanced',
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
      await db.generationJobs.bulkAdd(jobs);
      void pumpGenerationQueue();
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
          {!!configured.providers.length && <Space wrap>
            <Typography.Text>Provider</Typography.Text>
            <Select value={provider} onChange={next => { setProvider(next); setModel(settings.models[next]); }} style={{ width: 190 }}
              options={configured.providers.map(item => ({ label: item.label, value: item.id }))} />
            <Input value={model} onChange={event => setModel(event.target.value)} addonBefore="Model" placeholder={selectedProvider.defaultModel || 'Provider default'} style={{ width: 280 }} />
          </Space>}
          <div className="question-count-grid">
            <label><Typography.Text strong>Multiple choice</Typography.Text><InputNumber min={0} max={200} value={multipleChoiceCount} onChange={value => setMultipleChoiceCount(value ?? 0)} /></label>
            <label><Typography.Text strong>Fill in the blank</Typography.Text><InputNumber min={0} max={200} value={fillBlankCount} onChange={value => setFillBlankCount(value ?? 0)} /></label>
            <label><Typography.Text strong>Reasoning</Typography.Text><InputNumber min={0} max={200} value={reasoningCount} onChange={value => setReasoningCount(value ?? 0)} /></label>
            <label><Typography.Text strong>Coding</Typography.Text><InputNumber min={0} max={200} value={codingCount} onChange={value => setCodingCount(value ?? 0)} /></label>
            <div className="question-count-total"><Typography.Text type="secondary">Total</Typography.Text><Typography.Text strong>{questionCount}</Typography.Text></div>
          </div>
          {multipleChoiceCount > 0 && <div>
            <Typography.Text strong>Multiple-choice answer style</Typography.Text><br />
            <Radio.Group value={multipleChoiceMode} onChange={event => setMultipleChoiceMode(event.target.value)}
              className="answer-mode-selector" optionType="button" buttonStyle="solid" style={{ marginTop: 8 }} options={[
                { label: 'Exactly one correct answer', value: 'single' },
                { label: 'Multiple correct answers', value: 'multiple' },
              ]} />
          </div>}
          {mode === 'combined' && selected.length > 1 && <div>
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
