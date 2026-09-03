import { useRef, useState } from 'react';
import { Alert, Checkbox, Empty, Input, InputNumber, List, Modal, Progress, Radio, Select, Space, Tag, Typography } from 'antd';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db, type StoredDocument } from '../db/db';
import { generateQuiz, type GenerationProgress } from '../utils/api';
import type { GenerationOptions } from '../types';
import { getMessageApi } from '../utils/messageProvider';

interface Props { onClose: () => void; onCreated: (id: string) => void; }
type CreationMode = 'combined' | 'separate';

export default function AddTestModal({ onClose, onCreated }: Props) {
  const documents = useLiveQuery(() => db.documents.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<CreationMode>('combined');
  const [name, setName] = useState('Combined quiz');
  const [provider, setProvider] = useState<GenerationOptions['provider']>('codex');
  const [model, setModel] = useState('');
  const [questionCount, setQuestionCount] = useState(20);
  const [query, setQuery] = useState('');
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const message = getMessageApi();

  const selected = documents.filter(document => selectedIds.includes(document.id));
  const visible = (() => {
    const needle = query.trim().toLowerCase();
    return documents.filter(document => !needle || document.name.toLowerCase().includes(needle)
      || document.tags.some(tag => tag.toLowerCase().includes(needle)));
  })();

  const toggle = (id: string) => setSelectedIds(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);

  const generateOne = async (sourceDocuments: StoredDocument[], testName: string) => {
    const content = sourceDocuments.map(document => `# Document: ${document.name}\n\n${document.content}`).join('\n\n---\n\n');
    const options: GenerationOptions = {
      provider,
      model: model.trim() || undefined,
      questionCount,
    };
    const images = sourceDocuments.flatMap(document => document.images?.map(image => `data:${image.mimeType};base64,${image.data}`) ?? []);
    const questions = await generateQuiz(content, options, abortRef.current?.signal, setProgress, images);
    const id = uuidv4();
    await db.tests.add({
      id,
      name: testName,
      createdAt: Date.now(),
      questions,
      attempts: [],
      documentIds: sourceDocuments.map(document => document.id),
      fileContent: content,
      generationOptions: options,
    });
    if (questions.length < questionCount) {
      message.warning(`${testName}: saved ${questions.length}/${questionCount} verified questions after bounded retries.`);
    }
    return id;
  };

  const create = async () => {
    if (!selected.length) return;
    setWorking(true);
    setProgress(null);
    abortRef.current = new AbortController();
    try {
      let firstId = '';
      if (mode === 'combined') {
        firstId = await generateOne(selected, name.trim() || 'Combined quiz');
      } else {
        for (const document of selected) {
          const id = await generateOne([document], document.name);
          if (!firstId) firstId = id;
        }
      }
      message.success(mode === 'combined' ? 'Quiz created' : `${selected.length} quizzes created`);
      onCreated(firstId);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') message.error((error as Error).message);
    } finally {
      abortRef.current = null;
      setWorking(false);
    }
  };

  const close = () => {
    abortRef.current?.abort();
    onClose();
  };

  return (
    <Modal open width={760} title="Create a test from documents" onCancel={close} onOk={create}
      okText={mode === 'combined' ? 'Create combined test' : `Create ${selected.length} separate test(s)`}
      confirmLoading={working} okButtonProps={{ disabled: !selected.length || working }}>
      {!documents.length ? (
        <Empty description="Add documents to your library before creating a test" />
      ) : <>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Radio.Group value={mode} onChange={event => setMode(event.target.value)} optionType="button" buttonStyle="solid"
            options={[{ label: 'One combined test', value: 'combined' }, { label: 'Separate test per document', value: 'separate' }]} />
          {mode === 'combined' && <Input value={name} onChange={event => setName(event.target.value)} addonBefore="Test name" />}
          <Space wrap>
            <Select value={provider} onChange={setProvider} style={{ width: 180 }} options={[
              { label: 'Codex – Agent', value: 'codex' },
              { label: 'Gemini – API', value: 'gemini' },
            ]} />
            <Input value={model} onChange={event => setModel(event.target.value)} placeholder="Default model" style={{ width: 180 }} />
            <Typography.Text>Questions</Typography.Text>
            <InputNumber min={1} max={200} value={questionCount} onChange={value => setQuestionCount(value ?? 20)} />
          </Space>
          <Input.Search value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter documents by name or tag" />
          <List bordered size="small" style={{ maxHeight: 290, overflowY: 'auto' }} dataSource={visible}
            renderItem={document => (
              <List.Item onClick={() => !working && toggle(document.id)} style={{ cursor: working ? 'default' : 'pointer' }}>
                <Checkbox checked={selectedIds.includes(document.id)} disabled={working} style={{ marginRight: 12 }} />
                <List.Item.Meta title={document.name} description={document.tags.map(tag => <Tag key={tag}>{tag}</Tag>)} />
              </List.Item>
            )} />
          <Typography.Text type="secondary">{selected.length} document(s) selected</Typography.Text>
          {working && progress && <Progress percent={Math.round(progress.accepted / progress.target * 100)}
            format={() => `${progress.accepted}/${progress.target}`} status="active" />}
          {working && <Alert type="info" showIcon message={`Generating with ${provider === 'codex' ? 'Codex Agent' : 'Gemini API'}`}
            description="Valid questions are kept. Only missing or rejected slots are requested again, with a fixed retry limit." />}
        </Space>
      </>}
    </Modal>
  );
}
