import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Alert, Button, Input, Modal, Select, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { FileTextOutlined, RobotOutlined, SendOutlined, StopOutlined, UserOutlined } from '@ant-design/icons';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AIAnswer, AIConversationTurn, GenerationProvider } from '../types';
import { getProviderSettings } from '../utils/providerSettings';
import { useConfiguredProviders } from '../utils/useConfiguredProviders';

interface Props {
  title: string;
  emptyMessage: string;
  loadingMessage: string;
  onClose: () => void;
  scope?: { id: string; label: string }[];
  ask: (question: string, provider: GenerationProvider, model: string, history: AIConversationTurn[], signal: AbortSignal) => Promise<AIAnswer>;
}

export default function AskAIModal({ title, emptyMessage, loadingMessage, onClose, scope = [], ask }: Props) {
  const settings = useMemo(getProviderSettings, []);
  const configured = useConfiguredProviders();
  const [provider, setProvider] = useState<GenerationProvider>(settings.defaultProvider);
  const [model, setModel] = useState(settings.models[settings.defaultProvider]);
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<AIConversationTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const questionRef = useRef<TextAreaRef>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!configured.providers.length || configured.providers.some(item => item.id === provider)) return;
    const next = configured.providers[0].id;
    setProvider(next);
    setModel(settings.models[next]);
  }, [configured.providers, provider, settings.models]);

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

  useEffect(() => {
    historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight, behavior: 'smooth' });
  }, [history, loading]);

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
    setQuestion('');
    setLoading(true);
    setError('');
    controller.current = new AbortController();
    try {
      const result = await ask(prompt, provider, model, history, controller.current.signal);
      setHistory(current => [...current, { question: prompt, answer: result.answer, sources: result.sources }]);
    } catch (requestError) {
      setQuestion(prompt);
      if ((requestError as Error).name !== 'AbortError') setError((requestError as Error).message);
    } finally {
      setLoading(false);
      controller.current = null;
    }
  };

  const close = () => { controller.current?.abort(); onClose(); };

  return <Modal className="ask-ai-modal" open title={title} width={860} onCancel={close} footer={null} destroyOnHidden>
    <div className="ai-chat-shell">
      <div className="ai-chat-toolbar">
        <div className="ai-chat-scope">
          <FileTextOutlined />
          <div><Typography.Text strong>Knowledge scope</Typography.Text><br />
            <Typography.Text type="secondary">Retrieval is limited to {scope.length || 'no'} attached document{scope.length === 1 ? '' : 's'}.</Typography.Text>
          </div>
          <div className="ai-chat-scope-tags">{scope.map(item => <Tag key={item.id}>{item.label}</Tag>)}</div>
        </div>
        {!!configured.providers.length && <Space.Compact block>
          <Select value={provider} style={{ width: 220 }} options={configured.providers.map(item => ({ label: item.label, value: item.id }))}
            onChange={(value: GenerationProvider) => { setProvider(value); setModel(settings.models[value]); }} />
          <Input value={model} onChange={event => setModel(event.target.value)} onKeyDown={containEditingKeys} placeholder="Use provider default model" />
        </Space.Compact>}
      </div>
      {!configured.loading && !configured.providers.length && <Alert type="warning" showIcon message="No AI provider is configured" description="Connect an agent or add an API key in Plugins & models first." />}
      <div className="ai-chat-history" ref={historyRef}>
        {!history.length && !loading && <div className="ai-chat-empty"><RobotOutlined /><Typography.Text type="secondary">{emptyMessage}</Typography.Text></div>}
        {history.map((turn, index) => <div className="ai-chat-exchange" key={`${index}-${turn.question}`}>
          <div className="ai-chat-message ai-chat-message-user">
            <div className="ai-chat-avatar"><UserOutlined /></div><div className="ai-chat-bubble">{turn.question}</div>
          </div>
          <div className="ai-chat-message ai-chat-message-assistant">
            <div className="ai-chat-avatar"><RobotOutlined /></div>
            <div className="ai-chat-answer">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.answer}</ReactMarkdown>
              {!!turn.sources?.length && <div className="ai-chat-sources">
                <Typography.Text type="secondary">Retrieved sources</Typography.Text>
                <div>{turn.sources.map(source => <Tooltip key={source.id} title={source.excerpt}>
                  <Tag icon={<FileTextOutlined />}>[{source.index}] {source.name}{source.page ? ` · p. ${source.page}` : ''}</Tag>
                </Tooltip>)}</div>
              </div>}
            </div>
          </div>
        </div>)}
        {loading && <div className="ai-chat-message ai-chat-message-assistant">
          <div className="ai-chat-avatar"><RobotOutlined /></div>
          <div className="ai-chat-thinking"><Spin size="small" /><Typography.Text type="secondary">{loadingMessage}</Typography.Text></div>
        </div>}
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      <div className="ai-chat-composer">
        <Input.TextArea ref={questionRef} value={question} onChange={event => setQuestion(event.target.value)} autoFocus={false}
          autoSize={{ minRows: 2, maxRows: 7 }} placeholder="Ask about the attached material…" onKeyDown={event => {
            containEditingKeys(event);
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
          }} />
        <div className="ai-chat-composer-footer">
          <Typography.Text type="secondary">I focus · Enter send · Shift+Enter new line · Esc unfocus</Typography.Text>
          {loading ? <Button danger icon={<StopOutlined />} onClick={() => controller.current?.abort()}>Stop</Button>
            : question.trim() && configured.providers.length > 0 ? <Button type="primary" icon={<SendOutlined />} onClick={() => void submit()}>Send</Button> : null}
        </div>
      </div>
    </div>
  </Modal>;
}
