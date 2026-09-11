import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Checkbox, Dropdown, Empty, Input, Layout, List, Radio, Space, Tabs, Tag, Typography } from 'antd';
import { ApiOutlined, DeleteOutlined, EditOutlined, FileTextOutlined, FormOutlined, PlusOutlined, QuestionCircleOutlined, SearchOutlined, SelectOutlined, SettingOutlined, SyncOutlined, TagsOutlined } from '@ant-design/icons';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type StoredAppProfile } from '../db/db';
import { getMessageApi } from '../utils/messageProvider';
import { getModalApi } from '../utils/modalProvider';
import { countQuestionTypes } from '../utils/questions';
import { serviceJson } from '../utils/serviceApi';
import { syncNow } from '../db/serverSync';
import { useActivitySummary } from '../utils/useActivitySummary';
export type LibrarySelection = { kind: 'test' | 'document'; id: string } | null;

type LibraryKind = 'test' | 'document';
type CountStyle = 'paren' | 'bracket' | 'angle' | 'brace';

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

const countSuffix = (style: CountStyle, index: number) => ({
  paren: `(${index})`, bracket: `[${index}]`, angle: `<${index}>`, brace: `{${index}}`,
}[style]);

export default function Sidebar({ selection, onSelect, onAddTest, onAddDocument, onOpenPlugins, onOpenSettings, onOpenGeneration, onOpenTutorial, profile, dark, embedded = false }: Props) {
  const tests = useLiveQuery(() => db.tests.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const documents = useLiveQuery(() => db.documents.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const [tab, setTab] = useState<'tests' | 'documents'>(selection?.kind === 'document' ? 'documents' : 'tests');
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const message = getMessageApi();
  const activity = useActivitySummary();
  const kind: LibraryKind = tab === 'tests' ? 'test' : 'document';
  const selectionMode = selectedIds.size > 0;
  const activityLabel = activity.running > 0
    ? `${activity.running} job${activity.running === 1 ? '' : 's'} active`
    : activity.attention > 0
      ? `${activity.attention} need attention`
      : activity.count > 0 ? 'Work queued' : 'Activity';

  const normalizedQuery = query.trim().toLowerCase();
  const visibleTests = tests.filter(test => test.name.toLowerCase().includes(normalizedQuery));
  const visibleDocuments = documents.filter(document =>
    document.name.toLowerCase().includes(normalizedQuery) || document.tags.some(tag => tag.toLowerCase().includes(normalizedQuery))
  );
  const visibleIds = (tab === 'tests' ? visibleTests : visibleDocuments).map(item => item.id);

  const clearSelection = () => {
    setSelectedIds(new Set());
    setAnchorId(null);
  };

  useEffect(() => {
    if (!selectionMode) return;
    const handleOutside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.sidebar-list, .ant-dropdown, .ant-modal')) return;
      clearSelection();
    };
    document.addEventListener('pointerdown', handleOutside);
    return () => document.removeEventListener('pointerdown', handleOutside);
  }, [selectionMode]);

  const selectOnly = (id: string) => {
    setSelectedIds(new Set([id]));
    setAnchorId(id);
  };

  const handleItemClick = (event: React.MouseEvent, id: string) => {
    const modifier = event.metaKey || event.ctrlKey;
    if (event.shiftKey && anchorId) {
      const from = visibleIds.indexOf(anchorId);
      const to = visibleIds.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setSelectedIds(current => new Set([...current, ...visibleIds.slice(start, end + 1)]));
        return;
      }
    }
    if (modifier || selectionMode) {
      setSelectedIds(current => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      setAnchorId(id);
      return;
    }
    onSelect({ kind, id });
  };

  const startLongPress = (id: string) => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => selectOnly(id), 1000);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  const effectiveIds = (id: string) => selectionMode && selectedIds.has(id) ? [...selectedIds] : [id];

  const removeItems = (targetKind: LibraryKind, ids: string[]) => {
    getModalApi().confirm({
      title: `Delete ${ids.length} ${targetKind}${ids.length === 1 ? '' : 's'}?`,
      content: targetKind === 'document' ? 'Existing tests will remain available.' : 'This also removes saved drafts for the selected tests.',
      okText: 'Delete', okButtonProps: { danger: true },
      onOk: async () => {
        if (targetKind === 'test') await db.transaction('rw', db.tests, db.testDrafts, async () => {
          await db.tests.bulkDelete(ids);
          await db.testDrafts.bulkDelete(ids);
        }); else await db.documents.bulkDelete(ids);
        if (selection?.kind === targetKind && ids.includes(selection.id)) onSelect(null);
        clearSelection();
        message.success(`${ids.length} ${targetKind}${ids.length === 1 ? '' : 's'} deleted`);
      },
    });
  };

  const renameItems = (targetKind: LibraryKind, ids: string[]) => {
    let name = '';
    let style: CountStyle = 'paren';
    getModalApi().confirm({
      title: `Rename ${ids.length === 1 ? targetKind : `selected ${targetKind}s`}`,
      okText: 'Rename',
      content: <Space direction="vertical" style={{ width: '100%' }}>
        <Input autoFocus aria-label="New name" placeholder={ids.length === 1 ? 'New name' : 'Base name'} onChange={event => { name = event.target.value; }} />
        {ids.length > 1 && <>
          <Typography.Text type="secondary">Count indicator</Typography.Text>
          <Radio.Group defaultValue="paren" onChange={event => { style = event.target.value as CountStyle; }}>
            <Radio value="paren">(1)</Radio><Radio value="bracket">[1]</Radio><Radio value="angle">&lt;1&gt;</Radio><Radio value="brace">{'{1}'}</Radio>
          </Radio.Group>
        </>}
      </Space>,
      onOk: async () => {
        const base = name.trim();
        if (!base) throw new Error('Enter a name');
        const table = targetKind === 'test' ? db.tests : db.documents;
        await Promise.all(ids.map((id, index) => table.update(id, { name: ids.length === 1 ? base : `${base} ${countSuffix(style, index + 1)}` })));
        clearSelection();
        message.success(`${ids.length} ${targetKind}${ids.length === 1 ? '' : 's'} renamed`);
      },
    });
  };

  const addTags = (ids: string[]) => {
    let value = '';
    getModalApi().confirm({
      title: `Add tags to ${ids.length} document${ids.length === 1 ? '' : 's'}`,
      okText: 'Add tags',
      content: <Input autoFocus aria-label="Tags to add" placeholder="exam, review, chapter-3" onChange={event => { value = event.target.value; }} />,
      onOk: async () => {
        const tags = [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
        if (!tags.length) throw new Error('Enter at least one tag');
        const docs = await db.documents.bulkGet(ids);
        await Promise.all(docs.filter(Boolean).map(document => db.documents.update(document!.id, { tags: [...new Set([...document!.tags, ...tags])] })));
        clearSelection();
        message.success(`Tags added to ${ids.length} document${ids.length === 1 ? '' : 's'}`);
      },
    });
  };

  const reindexDocuments = async (ids: string[]) => {
    try {
      await syncNow();
      await serviceJson('/api/v1/index', 'POST', { documentIds: ids, force: true });
      clearSelection();
      message.success(`${ids.length} document${ids.length === 1 ? '' : 's'} queued for reindexing`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Could not reindex selected documents');
    }
  };

  const menuFor = (itemKind: LibraryKind, id: string) => {
    const ids = effectiveIds(id);
    if (!selectionMode) return [
      { key: 'rename', label: 'Rename', icon: <EditOutlined />, onClick: () => renameItems(itemKind, [id]) },
      { key: 'delete', label: 'Delete', danger: true, icon: <DeleteOutlined />, onClick: () => removeItems(itemKind, [id]) },
      { type: 'divider' as const },
      { key: 'select', label: 'Select mode', icon: <SelectOutlined />, onClick: () => selectOnly(id) },
    ];
    return itemKind === 'test' ? [
      { key: 'rename', label: `Rename selected (${ids.length})`, icon: <EditOutlined />, onClick: () => renameItems(itemKind, ids) },
      { key: 'delete', label: `Delete selected (${ids.length})`, danger: true, icon: <DeleteOutlined />, onClick: () => removeItems(itemKind, ids) },
    ] : [
      { key: 'reindex', label: `Reindex selected (${ids.length})`, icon: <SyncOutlined />, onClick: () => void reindexDocuments(ids) },
      { key: 'rename', label: `Rename selected (${ids.length})`, icon: <EditOutlined />, onClick: () => renameItems(itemKind, ids) },
      { key: 'tags', label: `Add tags (${ids.length})`, icon: <TagsOutlined />, onClick: () => addTags(ids) },
      { key: 'delete', label: `Delete selected (${ids.length})`, danger: true, icon: <DeleteOutlined />, onClick: () => removeItems(itemKind, ids) },
    ];
  };

  const content = (
    <div className="sidebar-content">
      <Typography.Title level={4} style={{ textAlign: 'center', margin: '22px 0 10px' }}>Quizzer</Typography.Title>
      <Tabs activeKey={tab} onChange={key => { setTab(key as typeof tab); setQuery(''); clearSelection(); }} centered
        items={[{ key: 'tests', label: 'Tests', icon: <FormOutlined /> }, { key: 'documents', label: 'Documents', icon: <FileTextOutlined /> }]} />
      <div className="sidebar-controls">
        {selectionMode ? <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Text strong>{selectedIds.size} selected</Typography.Text>
          <Button size="small" onClick={clearSelection}>Cancel selection</Button>
        </Space> : <Button data-onboarding-target={tab === 'tests' ? 'create-test' : 'document'} block type="primary" icon={<PlusOutlined />} onClick={() => tab === 'tests' ? onAddTest() : onAddDocument()}>
          {tab === 'tests' ? 'Create test' : 'Add documents'}
        </Button>}
        <Input allowClear prefix={<SearchOutlined />} value={query} onChange={event => setQuery(event.target.value)}
          placeholder={tab === 'tests' ? 'Find tests' : 'Find by name or tag'} style={{ marginTop: 10 }} />
      </div>
      <div className="sidebar-list" role="region" aria-label={`${tab === 'tests' ? 'Tests' : 'Documents'} library`} tabIndex={0}>
        {tab === 'tests' ? <List locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No tests yet" /> }} dataSource={visibleTests}
          renderItem={test => <Dropdown trigger={['contextMenu']} menu={{ items: menuFor('test', test.id) }}>
            <List.Item onClick={event => handleItemClick(event, test.id)} onPointerDown={() => startLongPress(test.id)} onPointerUp={cancelLongPress} onPointerLeave={cancelLongPress}
              style={{ cursor: 'pointer', padding: 10, borderRadius: 8, background: selectedIds.has(test.id) || (selection?.kind === 'test' && selection.id === test.id) ? 'var(--selected)' : undefined }}>
              {selectionMode && <Checkbox checked={selectedIds.has(test.id)} tabIndex={-1} />}
              <List.Item.Meta title={test.name} description={(() => {
                const counts = countQuestionTypes(test.questions);
                const types = [counts.multipleChoice && `${counts.multipleChoice} choice`, counts.fillBlank && `${counts.fillBlank} blank`, counts.reasoning && `${counts.reasoning} reasoning`, counts.coding && `${counts.coding} coding`].filter(Boolean).join(' · ');
                return `${types} · ${test.attempts.length} attempts`;
              })()} />
            </List.Item>
          </Dropdown>} /> : <List locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No documents yet" /> }} dataSource={visibleDocuments}
          renderItem={document => <Dropdown trigger={['contextMenu']} menu={{ items: menuFor('document', document.id) }}>
            <List.Item onClick={event => handleItemClick(event, document.id)} onPointerDown={() => startLongPress(document.id)} onPointerUp={cancelLongPress} onPointerLeave={cancelLongPress}
              style={{ cursor: 'pointer', padding: 10, borderRadius: 8, background: selectedIds.has(document.id) || (selection?.kind === 'document' && selection.id === document.id) ? 'var(--selected)' : undefined }}>
              {selectionMode && <Checkbox checked={selectedIds.has(document.id)} tabIndex={-1} />}
              <List.Item.Meta title={document.name} description={<Space size={[2, 2]} wrap>{document.tags.length ? document.tags.map(tag => <Tag key={tag}>{tag}</Tag>) : <Typography.Text type="secondary">No tags</Typography.Text>}</Space>} />
            </List.Item>
          </Dropdown>} />}
      </div>
      <div className="sidebar-footer">
        {profile && (!profile.onboarding.completedAt && !profile.onboarding.skipped) && <Button type="primary" icon={<QuestionCircleOutlined />} onClick={() => onOpenTutorial()}>Resume setup</Button>}
        <Button type="text" aria-label={activityLabel} icon={<SyncOutlined spin={activity.running > 0} />} onClick={onOpenGeneration}>
          <Space>Activity{activity.count > 0 && <Badge count={activity.count} size="small" style={{ backgroundColor: activity.attention ? '#cf1322' : activity.running ? '#1677ff' : '#8c8c8c' }} />}</Space>
        </Button>
        <Button data-onboarding-target="provider" type="text" icon={<ApiOutlined />} onClick={onOpenPlugins}>Plugins & models</Button>
        <Button type="text" icon={<SettingOutlined />} onClick={onOpenSettings}>Settings</Button>
      </div>
    </div>
  );
  return embedded ? content : <Layout.Sider width={290} theme={dark ? 'dark' : 'light'} className="desktop-sidebar">{content}</Layout.Sider>;
}
