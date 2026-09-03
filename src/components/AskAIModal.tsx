import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Alert, Button, Input, Modal, Select, Space, Spin, Typography } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import type { AIConversationTurn, GenerationProvider } from '../types';
import { getProviderSettings, PROVIDERS } from '../utils/providerSettings';

interface Props {
  title: string;
  emptyMessage: string;
  loadingMessage: string;
  onClose: () => void;
  ask: (question: string, provider: GenerationProvider, model: string, history: AIConversationTurn[], signal: AbortSignal) => Promise<string>;
}

export default function AskAIModal({ title, emptyMessage, loadingMessage, onClose, ask }: Props) {
  const settings = getProviderSettings();
  const [provider, setProvider] = useState<GenerationProvider>(settings.defaultProvider);
  const [model, setModel] = useState(settings.models[settings.defaultProvider]);
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<AIConversationTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const questionRef = useRef<TextAreaRef>(null);

  useEffect(() => {
    const focusQuestion = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches('input, textarea, [contenteditable="true"]');
      if (!editing && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLocaleLowerCase() === 'i') {
        event.preventDefault();
        questionRef.current?.focus({ cursor: 'end' });
      }
    };
    window.addEventListener('keydown', focusQuestion);
    return () => window.removeEventListener('keydown', focusQuestion);
  }, []);

  useEffect(() => () => controller.current?.abort(), []);

  const containEditingKeys = (event: ReactKeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      (event.currentTarget as HTMLElement).blur();
    }
  };

  const submit = async () => {
    const prompt = question.trim();
    if (!prompt || loading) return;
    setLoading(true);
    setError('');
    controller.current = new AbortController();
    try {
      const answer = await ask(prompt, provider, model, history, controller.current.signal);
      setHistory(current => [...current, { question: prompt, answer }]);
      setQuestion('');
    } catch (requestError) {
      if ((requestError as Error).name !== 'AbortError') setError((requestError as Error).message);
    } finally {
      setLoading(false);
      controller.current = null;
    }
  };

  const close = () => { controller.current?.abort(); onClose(); };

  return <Modal open title={title} width={780} onCancel={close} footer={null} destroyOnHidden>
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space.Compact block>
        <Select value={provider} style={{ width: 220 }} options={PROVIDERS.map(item => ({ label: item.label, value: item.id }))}
          onChange={(value: GenerationProvider) => { setProvider(value); setModel(settings.models[value]); }} />
        <Input value={model} onChange={event => setModel(event.target.value)} onKeyDown={containEditingKeys} placeholder="Use provider default model" />
      </Space.Compact>
      <div className="document-chat-history">
        {!history.length && !loading && <Typography.Text type="secondary">{emptyMessage}</Typography.Text>}
        {history.map((turn, index) => <div className="document-chat-turn" key={`${index}-${turn.question}`}>
          <Typography.Text strong>You</Typography.Text>
          <Typography.Paragraph>{turn.question}</Typography.Paragraph>
          <Typography.Text strong>AI</Typography.Text>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{turn.answer}</Typography.Paragraph>
        </div>)}
        {loading && <div className="document-chat-loading"><Spin /><Typography.Text type="secondary">{loadingMessage}</Typography.Text></div>}
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      <Input.TextArea ref={questionRef} value={question} onChange={event => setQuestion(event.target.value)} autoFocus={false}
        autoSize={{ minRows: 3, maxRows: 8 }} placeholder="What would you like to know?" onKeyDown={event => {
          containEditingKeys(event);
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
        }} />
      <Button type="primary" icon={<SendOutlined />} loading={loading} disabled={!question.trim()} onClick={() => void submit()}>Ask AI</Button>
      <Typography.Text type="secondary">Press I to focus · Enter to ask · Shift+Enter for a new line · Escape to unfocus</Typography.Text>
    </Space>
  </Modal>;
}
