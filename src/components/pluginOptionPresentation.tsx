import { isValidElement, type ReactNode } from 'react';
import { Collapse, Space, Spin, Typography } from 'antd';
import {
  ApiOutlined, CodeOutlined, DatabaseOutlined, DesktopOutlined, FileSearchOutlined, GlobalOutlined,
  GoogleOutlined, MessageOutlined, OpenAIOutlined, RocketOutlined, RobotOutlined, ScanOutlined,
  SearchOutlined, SortAscendingOutlined, ApartmentOutlined,
} from '@ant-design/icons';

const normalized = (value: string) => value.toLowerCase();
const syntheticStatusMessages = new Set(['Antigravity is connected.']);
const completedJobMessage = /(installed|installation complete|download complete|downloaded|ready|connected|succeeded|successfully)/i;

const nodeText = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
};

export function PluginGlyph({ title, fallback }: { title: string; fallback: ReactNode }) {
  const name = normalized(title);
  if (name.includes('openai')) return <OpenAIOutlined />;
  if (name.includes('gemini')) return <GoogleOutlined />;
  if (name.includes('ollama')) return <DesktopOutlined />;
  if (name.includes('llama.cpp')) return <CodeOutlined />;
  if (name.includes('codex')) return <CodeOutlined />;
  if (name.includes('antigravity')) return <RocketOutlined />;
  if (name.includes('claude') || name.includes('anthropic')) return <MessageOutlined />;
  if (name.includes('openrouter')) return <GlobalOutlined />;
  if (name.includes('deepseek')) return <SearchOutlined />;
  if (name.includes('rapidocr') || name.includes('ocr')) return <ScanOutlined />;
  if (name.includes('document extraction') || name.includes('marker')) return <FileSearchOutlined />;
  if (name.includes('embedding')) return <ApartmentOutlined />;
  if (name.includes('vector index') || name.includes('lancedb')) return <DatabaseOutlined />;
  if (name.includes('reranker') || name.includes('reranking')) return <SortAscendingOutlined />;
  if (name.includes('generator')) return <RobotOutlined />;
  if (name.includes('compatible') || name.includes('plugin')) return <ApiOutlined />;
  return <>{fallback}</>;
}

export function PluginJobDetails({ children, working }: { children: ReactNode; working: boolean }) {
  const message = nodeText(children).trim();
  if (!working && (syntheticStatusMessages.has(message) || completedJobMessage.test(message))) return null;
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {working ? <Space size="small"><Spin size="small" /><Typography.Text type="secondary">Working…</Typography.Text></Space> : null}
      <Collapse ghost size="small" items={[{ key: 'logs', label: 'View logs', children }]} />
    </Space>
  );
}

export function IntegrationStatusGate({ loading, children }: { loading: boolean; children: ReactNode }) {
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {loading ? <Space size="small" className="plugin-detection-status"><Spin size="small" /><Typography.Text type="secondary">Detecting installed tools and models…</Typography.Text></Space> : null}
      {children}
    </Space>
  );
}
