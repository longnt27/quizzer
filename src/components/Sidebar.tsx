import { useState } from 'react';
import { Badge, Button, Empty, Input, Layout, List, Space, Tabs, Tag, Typography } from 'antd';
import { ApiOutlined, FileTextOutlined, FormOutlined, PlusOutlined, QuestionCircleOutlined, SearchOutlined, SettingOutlined, SyncOutlined } from '@ant-design/icons';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type StoredAppProfile } from '../db/db';
import { countQuestionTypes } from '../utils/questions';
import { useActivitySummary } from '../utils/useActivitySummary';
export type LibrarySelection = { kind: 'test' | 'document'; id: string } | null;

interface Props {
  selection: LibrarySelection;
  onSelect: (selection: LibrarySelection) => void;
  onAddTest: () => void;
  onAddDocument: () => void;
  onOpenPlugins: () => void;
  onOpenSettings: () => void;
  onOpenGeneration: () => void;
  onOpenTutorial: () => void;
  profile?: StoredAppProfile;
  dark: boolean;
  embedded?: boolean;
}

export default function Sidebar({ selection, onSelect, onAddTest, onAddDocument, onOpenPlugins, onOpenSettings, onOpenGeneration, onOpenTutorial, profile, dark, embedded = false }: Props) {
  const tests = useLiveQuery(() => db.tests.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const documents = useLiveQuery(() => db.documents.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const [tab, setTab] = useState<'tests' | 'documents'>(selection?.kind === 'document' ? 'documents' : 'tests');
  const [query, setQuery] = useState('');
  const activity = useActivitySummary();
  const activityLabel = activity.running > 0
    ? `${activity.running} job${activity.running === 1 ? '' : 's'} active`
    : activity.attention > 0
      ? `${activity.attention} need attention`
      : activity.count > 0 ? 'Work queued' : 'Activity';

  const normalizedQuery = query.trim().toLowerCase();
  const visibleTests = tests.filter(test => test.name.toLowerCase().includes(normalizedQuery));
  const visibleDocuments = documents.filter(document =>
    document.name.toLowerCase().includes(normalizedQuery) ||
    document.tags.some(tag => tag.toLowerCase().includes(normalizedQuery))
  );

  const content = (
    <div className="sidebar-content">
      <Typography.Title level={4} style={{ textAlign: 'center', margin: '22px 0 10px' }}>Quizzer</Typography.Title>
      <Tabs activeKey={tab} onChange={key => { setTab(key as typeof tab); setQuery(''); }} centered
        items={[
          { key: 'tests', label: 'Tests', icon: <FormOutlined /> },
          { key: 'documents', label: 'Documents', icon: <FileTextOutlined /> },
        ]} />
      <div className="sidebar-controls">
        <Button data-onboarding-target={tab === 'tests' ? 'create-test' : 'document'} block type="primary" icon={<PlusOutlined />} onClick={() => {
          if (tab === 'tests') onAddTest();
          else onAddDocument();
        }}>
          {tab === 'tests' ? 'Create test' : 'Add documents'}
        </Button>
        <Input allowClear prefix={<SearchOutlined />} value={query} onChange={event => setQuery(event.target.value)}
          placeholder={tab === 'tests' ? 'Find tests' : 'Find by name or tag'} style={{ marginTop: 10 }} />
      </div>
      <div className="sidebar-list" role="region" aria-label={`${tab === 'tests' ? 'Tests' : 'Documents'} library`} tabIndex={0}>
        {tab === 'tests' ? (
          <List locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No tests yet" /> }} dataSource={visibleTests}
            renderItem={test => (
              <List.Item onClick={() => onSelect({ kind: 'test', id: test.id })}
                style={{ cursor: 'pointer', padding: 10, borderRadius: 8, background: selection?.kind === 'test' && selection.id === test.id ? 'var(--selected)' : undefined }}>
                <List.Item.Meta title={test.name} description={(() => {
                  const counts = countQuestionTypes(test.questions);
                  const types = [counts.multipleChoice && `${counts.multipleChoice} choice`, counts.fillBlank && `${counts.fillBlank} blank`, counts.reasoning && `${counts.reasoning} reasoning`, counts.coding && `${counts.coding} coding`].filter(Boolean).join(' · ');
                  return `${types} · ${test.attempts.length} attempts`;
                })()} />
              </List.Item>
            )} />
        ) : (
          <List locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No documents yet" /> }} dataSource={visibleDocuments}
            renderItem={document => (
              <List.Item onClick={() => onSelect({ kind: 'document', id: document.id })}
                style={{ cursor: 'pointer', padding: 10, borderRadius: 8, background: selection?.kind === 'document' && selection.id === document.id ? 'var(--selected)' : undefined }}>
                <List.Item.Meta title={document.name} description={<Space size={[2, 2]} wrap>{document.tags.length ? document.tags.map(tag => <Tag key={tag}>{tag}</Tag>) : <Typography.Text type="secondary">No tags</Typography.Text>}</Space>} />
              </List.Item>
            )} />
        )}
      </div>
      <div className="sidebar-footer">
        {profile && (!profile.onboarding.completedAt && !profile.onboarding.skipped) && (
          <Button type="primary" icon={<QuestionCircleOutlined />}
            onClick={() => onOpenTutorial()}>
            Resume setup
          </Button>
        )}
        <Button type="text" aria-label={activityLabel} icon={<SyncOutlined spin={activity.running > 0} />} onClick={onOpenGeneration}>
          <Space>
            Activity
            {activity.count > 0 && (
              <Badge
                count={activity.count}
                size="small"
                style={{
                  backgroundColor: activity.attention ? '#cf1322' : activity.running ? '#1677ff' : '#8c8c8c',
                }}
              />
            )}
          </Space>
        </Button>
        <Button data-onboarding-target="provider" type="text" icon={<ApiOutlined />} onClick={onOpenPlugins}>Plugins & models</Button>
        <Button type="text" icon={<SettingOutlined />} onClick={onOpenSettings}>Settings</Button>
      </div>
    </div>
  );
  return embedded ? content : <Layout.Sider width={290} theme={dark ? 'dark' : 'light'} className="desktop-sidebar">{content}</Layout.Sider>;
}
