import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Alert, Button, Input, Modal, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { ArrowUpOutlined, FileTextOutlined, RobotOutlined, StopOutlined, UserOutlined } from '@ant-design/icons';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AIAnswer, AIConversationTurn, AISourceReference, GenerationProvider } from '../types';
import { getProviderSettings } from '../utils/providerSettings';
import { useConfiguredProviders } from '../utils/useConfiguredProviders';

interface Props {
  title: string;
  emptyMessage: string;
  loadingMessage: string;
  onClose: () => void;
  scope?: { id: string; label: string }[];
  initialHistory?: AIConversationTurn[];
  onHistoryChange?: (history: AIConversationTurn[]) => void;
  ask: (question: string, provider: GenerationProvider, model: string, history: AIConversationTurn[], signal: AbortSignal) => Promise<AIAnswer>;
}

function CitationPopover({ index, source }: { index: number; source?: AISourceReference }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number }>();
  const closeTimer = useRef<number | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pointerInsideCitation = useRef(false);
  const pointerInsidePreview = useRef(false);
  const show = () => {
    window.clearTimeout(closeTimer.current);
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (bounds) {
      const width = Math.min(360, window.innerWidth - 24);
      const left = Math.min(Math.max(12, bounds.left + bounds.width / 2 - width / 2), window.innerWidth - width - 12);
      setPosition(bounds.top > 290
        ? { left, bottom: window.innerHeight - bounds.top + 8, width }
        : { left, top: bounds.bottom + 8, width });
    }
    setOpen(true);
  };
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      if (pointerInsideCitation.current || pointerInsidePreview.current || document.activeElement === triggerRef.current) return;
      setOpen(false);
    }, 400);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  return <>
    <button ref={triggerRef} type="button" className="ai-inline-citation" aria-label={`Preview source ${index}`}
      onPointerEnter={() => { pointerInsideCitation.current = true; show(); }}
      onPointerLeave={() => { pointerInsideCitation.current = false; scheduleClose(); }}
      onFocus={show} onBlur={scheduleClose}>[{index}]</button>
    {open && position && createPortal(<div className="ai-citation-floating" style={position}
      onPointerEnter={() => { pointerInsidePreview.current = true; window.clearTimeout(closeTimer.current); }}
      onPointerLeave={() => { pointerInsidePreview.current = false; scheduleClose(); }} role="note">
      {source ? <div className="ai-citation-preview">
        <strong>{source.name}{source.page ? ` · page ${source.page}` : ''}</strong>
        {source.excerpt && <span>{source.excerpt}</span>}
      </div> : 'Source reference unavailable'}
    </div>, document.body)}
  </>;
}

export default function AskAIModal({ title, emptyMessage, loadingMessage, onClose, scope = [], initialHistory = [], onHistoryChange, ask }: Props) {
  const settings = useMemo(getProviderSettings, []);
  const configured = useConfiguredProviders();
  const [provider, setProvider] = useState<GenerationProvider>(settings.defaultProvider);
  const [model, setModel] = useState(settings.models[settings.defaultProvider]);
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<AIConversationTurn[]>(initialHistory);
  const [pendingQuestion, setPendingQuestion] = useState('');
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
  }, [history, loading, pendingQuestion]);

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
    setPendingQuestion(prompt);
    setLoading(true);
    setError('');
    controller.current = new AbortController();
    try {
      const result = await ask(prompt, provider, model, history, controller.current.signal);
      const nextHistory = [...history, { question: prompt, answer: result.answer, sources: result.sources }];
      setHistory(nextHistory);
      onHistoryChange?.(nextHistory);
    } catch (requestError) {
      setQuestion(prompt);
      if ((requestError as Error).name !== 'AbortError') setError((requestError as Error).message);
    } finally {
      setPendingQuestion('');
      setLoading(false);
      controller.current = null;
    }
  };

  const close = () => { controller.current?.abort(); onClose(); };

  useEffect(() => {
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', closeFromKeyboard);
    return () => window.removeEventListener('keydown', closeFromKeyboard);
  });

  return <Modal className="ask-ai-modal" open title={title} width={860} onCancel={close} footer={null} destroyOnHidden keyboard={false}
    afterOpenChange={open => { if (open) questionRef.current?.focus({ cursor: 'end' }); }}>
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
      <div className="ai-chat-panel">
        <div className="ai-chat-history" ref={historyRef}>
        {!history.length && !loading && <div className="ai-chat-empty"><RobotOutlined /><Typography.Text type="secondary">{emptyMessage}</Typography.Text></div>}
        {history.map((turn, index) => <div className="ai-chat-exchange" key={`${index}-${turn.question}`}>
          <div className="ai-chat-message ai-chat-message-user">
            <div className="ai-chat-avatar"><UserOutlined /></div><div className="ai-chat-bubble">{turn.question}</div>
          </div>
          <div className="ai-chat-message ai-chat-message-assistant">
            <div className="ai-chat-avatar"><RobotOutlined /></div>
            <div className="ai-chat-answer">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                a: ({ href, children }) => {
                  const citation = /^#quizzer-source-(\d+)$/.exec(href ?? '');
                  if (!citation) return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
                  const index = Number(citation[1]);
                  return <CitationPopover index={index} source={turn.sources?.find(item => item.index === index)} />;
                },
              }}>{turn.answer.replace(/\[(?:Source\s*)?(\d+)\](?!\()/gi, ' [$1](#quizzer-source-$1) ')}</ReactMarkdown>
            </div>
          </div>
        </div>)}
        {loading && <div className="ai-chat-exchange ai-chat-pending">
          <div className="ai-chat-message ai-chat-message-user">
            <div className="ai-chat-avatar"><UserOutlined /></div><div className="ai-chat-bubble">{pendingQuestion}</div>
          </div>
          <div className="ai-chat-message ai-chat-message-assistant">
            <div className="ai-chat-avatar ai-chat-avatar-thinking"><RobotOutlined /></div>
            <div className="ai-chat-thinking"><span className="ai-thinking-dots"><i /><i /><i /></span><Typography.Text type="secondary">{loadingMessage}</Typography.Text></div>
          </div>
        </div>}
        </div>
        {error && <Alert className="ai-chat-error" type="error" showIcon message={error} />}
        <div className="ai-chat-composer">
          <Input.TextArea ref={questionRef} value={question} onChange={event => setQuestion(event.target.value)} autoFocus={false}
            autoSize={{ minRows: 1, maxRows: 7 }} placeholder="Ask about the attached material…" onKeyDown={event => {
              containEditingKeys(event);
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
            }} />
          {loading ? <Tooltip title="Cancel response"><Button className="ai-chat-composer-action" danger shape="circle" icon={<StopOutlined />}
            aria-label="Cancel response" onClick={() => controller.current?.abort()} /></Tooltip>
            : <Tooltip title={question.trim() ? configured.providers.length ? 'Send message' : 'Connect an AI provider to send' : 'Type a message'}>
              <Button className="ai-chat-composer-action" type={question.trim() && configured.providers.length ? 'primary' : 'default'} shape="circle"
                icon={<ArrowUpOutlined />} aria-label="Send message" disabled={!question.trim() || !configured.providers.length}
                onClick={() => void submit()} />
            </Tooltip>}
        </div>
      </div>
    </div>
  </Modal>;
}
