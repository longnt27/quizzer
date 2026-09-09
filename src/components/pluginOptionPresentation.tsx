import type { ReactNode } from 'react';
import { Spin } from 'antd';
import {
  ApiOutlined, CodeOutlined, DatabaseOutlined, DesktopOutlined, FileSearchOutlined, GlobalOutlined,
  GoogleOutlined, MessageOutlined, OpenAIOutlined, RocketOutlined, RobotOutlined, ScanOutlined,
  SearchOutlined, SortAscendingOutlined, ApartmentOutlined,
} from '@ant-design/icons';

const normalized = (value: string) => value.toLowerCase();

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

export function PluginJobDetails({ children }: { children: ReactNode; working: boolean }) {
  return <>{children}</>;
}

export function IntegrationStatusGate({ loading, children }: { loading: boolean; children: ReactNode }) {
  return loading ? <div className="plugin-loading"><Spin /></div> : <>{children}</>;
}
