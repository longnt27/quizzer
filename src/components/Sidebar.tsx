import { useState, useSyncExternalStore } from 'react';
import { Alert, Badge, Button, Empty, Input, Layout, List, Modal, Popconfirm, Progress, Space, Tabs, Tag, Typography } from 'antd';
import { ApiOutlined, CloudSyncOutlined, DeleteOutlined, FileTextOutlined, FormOutlined, MoonOutlined, PlusOutlined, SearchOutlined, SyncOutlined, SunOutlined } from '@ant-design/icons';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { getMessageApi } from '../utils/messageProvider';
import { countQuestionTypes } from '../utils/questions';
import { serverSyncStatus, syncNow } from '../db/serverSync';

export type LibrarySelection = { kind: 'test' | 'document'; id: string } | null;

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};

interface Props {
  selection: LibrarySelection;
  onSelect: (selection: LibrarySelection) => void;
  onAddTest: () => void;
  onAddDocument: () => void;
  onOpenPlugins: () => void;
  onOpenGeneration: () => void;
  dark: boolean;
  onToggleTheme: () => void;
  embedded?: boolean;
}

export default function Sidebar({ selection, onSelect, onAddTest, onAddDocument, onOpenPlugins, onOpenGeneration, dark, onToggleTheme, embedded = false }: Props) {
  const tests = useLiveQuery(() => db.tests.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const documents = useLiveQuery(() => db.documents.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const [tab, setTab] = useState<'tests' | 'documents'>(selection?.kind === 'document' ? 'documents' : 'tests');
  const [query, setQuery] = useState('');
  const [syncDetailsOpen, setSyncDetailsOpen] = useState(false);
  const message = getMessageApi();
  const sync = useSyncExternalStore(serverSyncStatus.subscribe, serverSyncStatus.getSnapshot);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleTests = tests.filter(test => test.name.toLowerCase().includes(normalizedQuery));
  const visibleDocuments = documents.filter(document =>
    document.name.toLowerCase().includes(normalizedQuery) ||
    document.tags.some(tag => tag.toLowerCase().includes(normalizedQuery))
  );

  const remove = async (kind: 'test' | 'document', id: string) => {
    if (kind === 'test') await db.transaction('rw', db.tests, db.testDrafts, async () => {
      await db.tests.delete(id);
      await db.testDrafts.delete(id);
    });
    else await db.documents.delete(id);
    if (selection?.kind === kind && selection.id === id) onSelect(null);
    message.success(`${kind === 'test' ? 'Test' : 'Document'} deleted`);
  };

  const content = (
    <div className="sidebar-content">
      <Typography.Title level={4} style={{ textAlign: 'center', margin: '22px 0 10px' }}>Quizzer</Typography.Title>
      <Tabs activeKey={tab} onChange={key => { setTab(key as typeof tab); setQuery(''); }} centered
        items={[
          { key: 'tests', label: 'Tests', icon: <FormOutlined /> },
          { key: 'documents', label: 'Documents', icon: <FileTextOutlined /> },
        ]} />
      <div className="sidebar-controls">
        <Button block type="primary" icon={<PlusOutlined />} onClick={() => {
          if (tab === 'tests') onAddTest();
          else onAddDocument();
        }}>
          {tab === 'tests' ? 'Create test' : 'Add documents'}
        </Button>
        <Input allowClear prefix={<SearchOutlined />} value={query} onChange={event => setQuery(event.target.value)}
          placeholder={tab === 'tests' ? 'Find tests' : 'Find by name or tag'} style={{ marginTop: 10 }} />
      </div>
      <div className="sidebar-list">
        {tab === 'tests' ? (
          <List locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No tests yet" /> }} dataSource={visibleTests}
            renderItem={test => (
              <List.Item onClick={() => onSelect({ kind: 'test', id: test.id })}
                style={{ cursor: 'pointer', padding: 10, borderRadius: 8, background: selection?.kind === 'test' && selection.id === test.id ? 'var(--selected)' : undefined }}
                actions={[<Popconfirm title="Delete this test?" onConfirm={() => remove('test', test.id)}><Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={event => event.stopPropagation()} /></Popconfirm>]}>
                <List.Item.Meta title={test.name} description={(() => {
                  const counts = countQuestionTypes(test.questions);
                  const types = [counts.multipleChoice && `${counts.multipleChoice} choice`, counts.fillBlank && `${counts.fillBlank} blank`, counts.reasoning && `${counts.reasoning} reasoning`].filter(Boolean).join(' · ');
                  return `${types} · ${test.attempts.length} attempts`;
                })()} />
              </List.Item>
            )} />
        ) : (
          <List locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No documents yet" /> }} dataSource={visibleDocuments}
            renderItem={document => (
              <List.Item onClick={() => onSelect({ kind: 'document', id: document.id })}
                style={{ cursor: 'pointer', padding: 10, borderRadius: 8, background: selection?.kind === 'document' && selection.id === document.id ? 'var(--selected)' : undefined }}
                actions={[<Popconfirm title="Delete this document? Existing quizzes will remain available." onConfirm={() => remove('document', document.id)}><Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={event => event.stopPropagation()} /></Popconfirm>]}>
                <List.Item.Meta title={document.name} description={<Space size={[2, 2]} wrap>{document.tags.length ? document.tags.map(tag => <Tag key={tag}>{tag}</Tag>) : <Typography.Text type="secondary">No tags</Typography.Text>}</Space>} />
              </List.Item>
            )} />
        )}
      </div>
      <div className="sidebar-footer">
        <Button type="text" icon={<CloudSyncOutlined spin={sync.status === 'syncing'} />} onClick={() => { setSyncDetailsOpen(true); void syncNow(); }}>
          <Badge status={sync.status === 'synced' ? 'success' : sync.status === 'offline' ? 'warning' : 'processing'} />
          {sync.status === 'offline' ? 'Offline — saved locally' : sync.lastSyncedAt ? 'Saved on server' : 'Syncing library'}
        </Button>
        <Button type="text" icon={<SyncOutlined />} onClick={onOpenGeneration}>Generation queue</Button>
        <Button type="text" icon={<ApiOutlined />} onClick={onOpenPlugins}>Plugins & models</Button>
        <Button type="text" icon={dark ? <SunOutlined /> : <MoonOutlined />} onClick={onToggleTheme}>
          {dark ? 'Light mode' : 'Dark mode'}
        </Button>
      </div>
      <Modal title="Library sync" open={syncDetailsOpen} onCancel={() => setSyncDetailsOpen(false)} footer={[
        <Button key="sync" loading={sync.status === 'syncing'} onClick={() => void syncNow()}>Sync now</Button>,
        <Button key="close" type="primary" onClick={() => setSyncDetailsOpen(false)}>Close</Button>,
      ]}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Progress percent={sync.percent} status={sync.status === 'offline' ? 'exception' : sync.status === 'synced' ? 'success' : 'active'} />
          <div>
            <Typography.Text strong>{sync.detail}</Typography.Text><br />
            <Typography.Text type="secondary">
              {sync.total > 0 && (sync.phase === 'uploading' || sync.phase === 'receiving'
                ? `${formatBytes(sync.completed)} of ${formatBytes(sync.total)} · `
                : `${sync.completed.toLocaleString()} of ${sync.total.toLocaleString()} records · `)}
              {sync.pending} pending local {sync.pending === 1 ? 'change' : 'changes'}
              {sync.lastSyncedAt && ` · Last saved ${new Date(sync.lastSyncedAt).toLocaleTimeString()}`}
            </Typography.Text>
          </div>
          {sync.error && <Alert type="warning" showIcon message={sync.error} description="Quizzer will keep retrying. Your unsent changes remain in this browser." />}
        </Space>
      </Modal>
    </div>
  );
  return embedded ? content : <Layout.Sider width={290} theme={dark ? 'dark' : 'light'} className="desktop-sidebar">{content}</Layout.Sider>;
}
