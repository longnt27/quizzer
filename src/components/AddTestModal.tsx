import { useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, InputNumber, List, Modal, Progress, Radio, Select, Space, Tag, Typography } from 'antd';
import { StopOutlined } from '@ant-design/icons';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db, type StoredDocument } from '../db/db';
import { generateQuiz, type GenerationProgress, type ProviderFailure } from '../utils/api';
import type { GenerationOptions } from '../types';
import { getMessageApi } from '../utils/messageProvider';
import { PROVIDERS, getApiKey, getProviderDefinition, getProviderSettings } from '../utils/providerSettings';

interface Props { onClose: () => void; onCreated: (id: string) => void; onManagePlugins: () => void; }
type CreationMode = 'combined' | 'separate';

export default function AddTestModal({ onClose, onCreated, onManagePlugins }: Props) {
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
  const [working, setWorking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [activeTest, setActiveTest] = useState({ number: 1, total: 1, name: '' });
  const [providerFailure, setProviderFailure] = useState<ProviderFailure | null>(null);
  const [fallbackProvider, setFallbackProvider] = useState<GenerationOptions['provider']>(() => PROVIDERS.find(item => item.id !== configuredProviders.defaultProvider)?.id ?? 'gemini');
  const [fallbackModel, setFallbackModel] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const resumeRef = useRef<((options: GenerationOptions | null) => void) | null>(null);
  const activeOptionsRef = useRef<GenerationOptions | null>(null);
  const message = getMessageApi();
  const questionCount = multipleChoiceCount + fillBlankCount + reasoningCount;
  const selectedProvider = getProviderDefinition(provider);
  const fallbackDefinition = getProviderDefinition(fallbackProvider);

  const selected = documents.filter(document => selectedIds.includes(document.id));
  const visible = (() => {
    const needle = query.trim().toLowerCase();
    return documents.filter(document => !needle || document.name.toLowerCase().includes(needle)
      || document.tags.some(tag => tag.toLowerCase().includes(needle)));
  })();

  const toggle = (id: string) => setSelectedIds(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);

  const generateOne = async (sourceDocuments: StoredDocument[], testName: string, testNumber: number, testTotal: number) => {
    setActiveTest({ number: testNumber, total: testTotal, name: testName });
    setProgress(null);
    const content = sourceDocuments.map(document => `# Document: ${document.name}\n\n${document.content}`).join('\n\n---\n\n');
    const options: GenerationOptions = activeOptionsRef.current ?? {
      provider, model: model.trim() || undefined,
      questionCount,
      questionCounts: { multipleChoice: multipleChoiceCount, fillBlank: fillBlankCount, reasoning: reasoningCount },
    };
    const images = sourceDocuments.flatMap(document => document.images?.map(image => `data:${image.mimeType};base64,${image.data}`) ?? []);
    const questions = await generateQuiz(content, options, abortRef.current?.signal, setProgress, images, undefined, async failure => {
      const next = PROVIDERS.find(item => item.id !== failure.provider)?.id ?? 'gemini';
      setProviderFailure(failure);
      setFallbackProvider(next);
      setFallbackModel(configuredProviders.models[next]);
      const replacement = await new Promise<GenerationOptions | null>(resolve => { resumeRef.current = resolve; });
      resumeRef.current = null;
      if (replacement) activeOptionsRef.current = replacement;
      setProviderFailure(null);
      return replacement;
    });
    const id = uuidv4();
    await db.tests.add({
      id,
      name: testName,
      createdAt: Date.now(),
      questions,
      attempts: [],
      documentIds: sourceDocuments.map(document => document.id),
      fileContent: content,
      generationOptions: activeOptionsRef.current ?? options,
    });
    if (questions.length < questionCount) {
      message.warning(`${testName}: saved ${questions.length}/${questionCount} verified questions after bounded retries.`);
    }
    return id;
  };

  const create = async () => {
    if (!selected.length) return;
    if (questionCount < 1 || questionCount > 200) {
      message.error('Choose between 1 and 200 questions in total');
      return;
    }
    if (selectedProvider.kind === 'api' && !getApiKey(provider).trim()) {
      message.error(`Enter your ${selectedProvider.keyLabel ?? 'API key'}`);
      return;
    }
    setWorking(true);
    setCancelling(false);
    setCancelled(false);
    setProgress(null);
    abortRef.current = new AbortController();
    activeOptionsRef.current = {
      provider, model: model.trim() || undefined, questionCount,
      questionCounts: { multipleChoice: multipleChoiceCount, fillBlank: fillBlankCount, reasoning: reasoningCount },
    };
    let completed = 0;
    try {
      let firstId = '';
      if (mode === 'combined') {
        firstId = await generateOne(selected, name.trim() || 'Combined quiz', 1, 1);
        completed = 1;
      } else {
        for (const [index, document] of selected.entries()) {
          const id = await generateOne([document], document.name, index + 1, selected.length);
          if (!firstId) firstId = id;
          completed++;
        }
      }
      message.success(mode === 'combined' ? 'Quiz created' : `${selected.length} quizzes created`);
      onCreated(firstId);
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        setCancelled(true);
        message.info(completed ? `Generation cancelled. ${completed} completed test${completed === 1 ? ' was' : 's were'} kept.` : 'Generation cancelled');
      } else message.error((error as Error).message);
    } finally {
      abortRef.current = null;
      activeOptionsRef.current = null;
      resumeRef.current = null;
      setWorking(false);
      setCancelling(false);
    }
  };

  const close = () => {
    onClose();
  };

  const cancelGeneration = () => {
    if (!abortRef.current || cancelling) return;
    setCancelling(true);
    abortRef.current.abort();
    resumeRef.current?.(null);
  };

  const continueWithFallback = () => {
    if (!resumeRef.current) return;
    if (fallbackDefinition.kind === 'api' && !getApiKey(fallbackProvider).trim()) {
      message.error(`Configure the ${fallbackDefinition.label} key first`);
      return;
    }
    const replacement: GenerationOptions = {
      provider: fallbackProvider,
      model: fallbackModel.trim() || undefined,
      questionCount,
      questionCounts: { multipleChoice: multipleChoiceCount, fillBlank: fillBlankCount, reasoning: reasoningCount },
    };
    setProvider(fallbackProvider);
    setModel(fallbackModel);
    resumeRef.current(replacement);
  };

  const overallPercent = progress
    ? Math.round((((activeTest.number - 1) * progress.target + progress.accepted) / (activeTest.total * progress.target)) * 100)
    : 0;

  return (
    <Modal open width={760} title="Create a test from documents" onCancel={working ? cancelGeneration : close} onOk={create}
      closable={!working} maskClosable={!working} cancelText={working ? (cancelling ? 'Stopping…' : 'Cancel generation') : 'Cancel'}
      cancelButtonProps={{ danger: working, loading: cancelling }}
      okText={mode === 'combined' ? 'Create combined test' : `Create ${selected.length} separate test(s)`}
      confirmLoading={working} okButtonProps={{ disabled: !selected.length || working || questionCount < 1 || questionCount > 200 }}>
      {!documents.length ? (
        <Empty description="Add documents to your library before creating a test" />
      ) : <>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Radio.Group value={mode} disabled={working} onChange={event => setMode(event.target.value)} optionType="button" buttonStyle="solid"
            options={[{ label: 'One combined test', value: 'combined' }, { label: 'Separate test per document', value: 'separate' }]} />
          {mode === 'combined' && <Input disabled={working} value={name} onChange={event => setName(event.target.value)} addonBefore="Test name" />}
          <Space wrap>
            <Typography.Text>Provider</Typography.Text>
            <Select value={provider} disabled={working} onChange={next => {
              setProvider(next);
              setModel(configuredProviders.models[next]);
            }} style={{ width: 190 }} options={PROVIDERS.map(item => ({ label: item.label, value: item.id }))} />
            <Input disabled={working} value={model} onChange={event => setModel(event.target.value)} addonBefore="Model" placeholder={selectedProvider.defaultModel || 'Provider default'} style={{ width: 280 }} />
          </Space>
          <div className="question-count-grid">
            <label><Typography.Text strong>Multiple choice</Typography.Text><InputNumber disabled={working} min={0} max={200} value={multipleChoiceCount} onChange={value => setMultipleChoiceCount(value ?? 0)} /></label>
            <label><Typography.Text strong>Fill in the blank</Typography.Text><InputNumber disabled={working} min={0} max={200} value={fillBlankCount} onChange={value => setFillBlankCount(value ?? 0)} /></label>
            <label><Typography.Text strong>Reasoning</Typography.Text><InputNumber disabled={working} min={0} max={200} value={reasoningCount} onChange={value => setReasoningCount(value ?? 0)} /></label>
            <div className="question-count-total"><Typography.Text type="secondary">Total</Typography.Text><Typography.Text strong>{questionCount}</Typography.Text></div>
          </div>
          {questionCount < 1 && <Alert type="error" showIcon message="Choose at least one question." />}
          {questionCount > 200 && <Alert type="error" showIcon message="A test can contain at most 200 questions." />}
          {selectedProvider.kind === 'api' && !getApiKey(provider).trim() && <Alert type="warning" showIcon message={`${selectedProvider.label} is not connected`}
            description="Add your API key in Plugins & models before creating this test."
            action={<Button disabled={working} size="small" onClick={onManagePlugins}>Configure</Button>} />}
          <Typography.Text type="secondary">Provider defaults are saved in <Button disabled={working} type="link" size="small" onClick={onManagePlugins}>Plugins & models</Button>. You can override the model for this test.</Typography.Text>
          <Input.Search value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter documents by name or tag" />
          <List bordered size="small" style={{ maxHeight: 290, overflowY: 'auto' }} dataSource={visible}
            renderItem={document => (
              <List.Item onClick={() => !working && toggle(document.id)} style={{ cursor: working ? 'default' : 'pointer' }}>
                <Checkbox checked={selectedIds.includes(document.id)} disabled={working} style={{ marginRight: 12 }} />
                <List.Item.Meta title={document.name} description={document.tags.map(tag => <Tag key={tag}>{tag}</Tag>)} />
              </List.Item>
            )} />
          <Typography.Text type="secondary">{selected.length} document(s) selected</Typography.Text>
          {cancelled && !working && <Alert closable type="warning" showIcon message="Generation was cancelled" description="You can change the settings and start again." onClose={() => setCancelled(false)} />}
          {providerFailure && <Alert type="warning" showIcon message={`${getProviderDefinition(providerFailure.provider).label} cannot continue`}
            description={<Space direction="vertical" style={{ width: '100%' }}>
              <Typography.Text>{providerFailure.message}</Typography.Text>
              <Typography.Text type="secondary">{providerFailure.accepted}/{providerFailure.target} accepted questions are preserved. Choose another provider to generate only what is missing.</Typography.Text>
              <Space wrap>
                <Select value={fallbackProvider} onChange={next => { setFallbackProvider(next); setFallbackModel(configuredProviders.models[next]); }} style={{ width: 190 }}
                  options={PROVIDERS.filter(item => item.id !== providerFailure.provider).map(item => ({ label: item.label, value: item.id }))} />
                <Input value={fallbackModel} onChange={event => setFallbackModel(event.target.value)} addonBefore="Model" placeholder={fallbackDefinition.defaultModel || 'Provider default'} style={{ width: 280 }} />
                <Button type="primary" onClick={continueWithFallback}>Continue</Button>
              </Space>
              {fallbackDefinition.kind === 'api' && !getApiKey(fallbackProvider).trim() && <Space><Typography.Text type="danger">Configure this API key before continuing.</Typography.Text><Button size="small" onClick={onManagePlugins}>Plugins & models</Button></Space>}
            </Space>} />}
          {working && <div className="generation-progress">
            <div className="generation-progress-heading">
              <div>
                <Typography.Text strong>{activeTest.total > 1 ? `Test ${activeTest.number} of ${activeTest.total}: ` : ''}{activeTest.name || 'Preparing test'}</Typography.Text><br />
                <Typography.Text type="secondary">
                  {progress ? `${getProviderDefinition(progress.provider).label} · ${progress.phase === 'requesting' ? 'Requesting' : 'Checking'} ${progress.currentType?.replaceAll('-', ' ')} · round ${progress.round}/${progress.maxRounds}` : 'Preparing generation request…'}
                </Typography.Text>
              </div>
              <Button danger icon={<StopOutlined />} loading={cancelling} onClick={cancelGeneration}>{cancelling ? 'Stopping' : 'Cancel'}</Button>
            </div>
            <Progress percent={overallPercent} status={cancelling ? 'exception' : 'active'}
              format={() => progress ? `${progress.accepted}/${progress.target}` : '0%'} />
            <Space wrap>
              <Tag color="success">Accepted: {progress?.accepted ?? 0}</Tag>
              <Tag color={progress?.rejected ? 'error' : 'default'}>Rejected: {progress?.rejected ?? 0}</Tag>
              {progress && <Tag color="blue">Current type: {progress.typeAccepted}/{progress.typeTarget}</Tag>}
            </Space>
            <Typography.Text type="secondary">Valid questions are kept. Only missing or rejected slots are requested again, with a fixed retry limit.</Typography.Text>
          </div>}
        </Space>
      </>}
    </Modal>
  );
}
