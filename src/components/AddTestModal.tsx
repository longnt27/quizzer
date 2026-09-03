import { useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, InputNumber, List, Modal, Radio, Select, Space, Tag, Typography } from 'antd';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db, type StoredGenerationJob } from '../db/db';
import type { GenerationOptions } from '../types';
import { getMessageApi } from '../utils/messageProvider';
import { pumpGenerationQueue } from '../utils/generationQueue';
import { PROVIDERS, getApiKey, getProviderDefinition, getProviderSettings } from '../utils/providerSettings';

interface Props { onClose: () => void; onManagePlugins: () => void; }
type CreationMode = 'combined' | 'separate';

export default function AddTestModal({ onClose, onManagePlugins }: Props) {
  const configuredProviders = getProviderSettings();
  const documents = useLiveQuery(() => db.documents.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<CreationMode>('combined');
  const [name, setName] = useState('Combined quiz');
  const [provider, setProvider] = useState<GenerationOptions['provider']>(configuredProviders.defaultProvider);
  const [model, setModel] = useState(configuredProviders.models[configuredProviders.defaultProvider]);
  const [multipleChoiceCount, setMultipleChoiceCount] = useState(15);
  const [fillBlankCount, setFillBlankCount] = useState(3);
  const [reasoningCount, setReasoningCount] = useState(2);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const message = getMessageApi();
  const questionCount = multipleChoiceCount + fillBlankCount + reasoningCount;
  const selectedProvider = getProviderDefinition(provider);
  const selected = documents.filter(document => selectedIds.includes(document.id));
  const visible = (() => {
    const needle = query.trim().toLowerCase();
    return documents.filter(document => !needle || document.name.toLowerCase().includes(needle)
      || document.tags.some(tag => tag.toLowerCase().includes(needle)));
  })();

  const toggle = (id: string) => setSelectedIds(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);

  const create = async () => {
    if (!selected.length) return;
    if (questionCount < 1 || questionCount > 200) return message.error('Choose between 1 and 200 questions in total');
    if (selectedProvider.kind === 'api' && !getApiKey(provider).trim()) return message.error(`Enter your ${selectedProvider.keyLabel ?? 'API key'}`);
    setSaving(true);
    try {
      const options: GenerationOptions = {
        provider, model: model.trim() || undefined, questionCount,
        questionCounts: { multipleChoice: multipleChoiceCount, fillBlank: fillBlankCount, reasoning: reasoningCount },
      };
      const sources = mode === 'combined'
        ? [{ name: name.trim() || 'Combined quiz', documentIds: selected.map(document => document.id) }]
        : selected.map(document => ({ name: document.name, documentIds: [document.id] }));
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
    <Modal open width={760} title="Create tests from documents" onCancel={onClose} onOk={() => void create()}
      okText={mode === 'combined' ? 'Queue combined test' : `Queue ${selected.length} separate test(s)`}
      confirmLoading={saving} okButtonProps={{ disabled: !selected.length || saving || questionCount < 1 || questionCount > 200 }}>
      {!documents.length ? <Empty description="Add documents to your library before creating a test" /> : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert type="info" showIcon message="Generation runs in the background"
            description="Completed tests appear in the sidebar immediately. Five provider-request slots are shared across every test, and interrupted work resumes from its latest verified batch." />
          <Radio.Group value={mode} disabled={saving} onChange={event => setMode(event.target.value)} optionType="button" buttonStyle="solid"
            options={[{ label: 'One combined test', value: 'combined' }, { label: 'Separate test per document', value: 'separate' }]} />
          {mode === 'combined' && <Input disabled={saving} value={name} onChange={event => setName(event.target.value)} addonBefore="Test name" />}
          <Space wrap>
            <Typography.Text>Provider</Typography.Text>
            <Select value={provider} disabled={saving} onChange={next => { setProvider(next); setModel(configuredProviders.models[next]); }} style={{ width: 190 }}
              options={PROVIDERS.map(item => ({ label: item.label, value: item.id }))} />
            <Input disabled={saving} value={model} onChange={event => setModel(event.target.value)} addonBefore="Model" placeholder={selectedProvider.defaultModel || 'Provider default'} style={{ width: 280 }} />
          </Space>
          <div className="question-count-grid">
            <label><Typography.Text strong>Multiple choice</Typography.Text><InputNumber disabled={saving} min={0} max={200} value={multipleChoiceCount} onChange={value => setMultipleChoiceCount(value ?? 0)} /></label>
            <label><Typography.Text strong>Fill in the blank</Typography.Text><InputNumber disabled={saving} min={0} max={200} value={fillBlankCount} onChange={value => setFillBlankCount(value ?? 0)} /></label>
            <label><Typography.Text strong>Reasoning</Typography.Text><InputNumber disabled={saving} min={0} max={200} value={reasoningCount} onChange={value => setReasoningCount(value ?? 0)} /></label>
            <div className="question-count-total"><Typography.Text type="secondary">Total</Typography.Text><Typography.Text strong>{questionCount}</Typography.Text></div>
          </div>
          {questionCount < 1 && <Alert type="error" showIcon message="Choose at least one question." />}
          {questionCount > 200 && <Alert type="error" showIcon message="A test can contain at most 200 questions." />}
          {selectedProvider.kind === 'api' && !getApiKey(provider).trim() && <Alert type="warning" showIcon message={`${selectedProvider.label} is not connected`}
            description="Add your API key in Plugins & models before creating this test."
            action={<Button disabled={saving} size="small" onClick={onManagePlugins}>Configure</Button>} />}
          <Typography.Text type="secondary">Provider defaults are saved in <Button disabled={saving} type="link" size="small" onClick={onManagePlugins}>Plugins & models</Button>. You can override the model for this job.</Typography.Text>
          <Input.Search value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter documents by name or tag" />
          <List bordered size="small" style={{ maxHeight: 290, overflowY: 'auto' }} dataSource={visible}
            renderItem={document => <List.Item onClick={() => !saving && toggle(document.id)} style={{ cursor: saving ? 'default' : 'pointer' }}>
              <Checkbox checked={selectedIds.includes(document.id)} disabled={saving} style={{ marginRight: 12 }} />
              <List.Item.Meta title={document.name} description={document.tags.map(tag => <Tag key={tag}>{tag}</Tag>)} />
            </List.Item>} />
          <Typography.Text type="secondary">{selected.length} document(s) selected</Typography.Text>
        </Space>
      )}
    </Modal>
  );
}
