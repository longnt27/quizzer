import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Empty, List, Progress, Row, Space, Statistic, Tag, Typography } from 'antd';
import { ApiOutlined, DatabaseOutlined, FileAddOutlined, FormOutlined, ReloadOutlined, RocketOutlined, SafetyCertificateOutlined, SyncOutlined } from '@ant-design/icons';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type StoredAppProfile } from '../db/db';
import { CURRENT_WHATS_NEW_VERSION, ONBOARDING_STEPS, updateAppProfile } from '../utils/appProfile';
import { serviceRequest } from '../utils/serviceApi';
import { useConfiguredProviders } from '../utils/useConfiguredProviders';
import { ErrorDisplay } from './ErrorDisplay';

interface IndexHealth {
  documentCount: number;
  chunkCount: number;
  dense?: { enabled: boolean; status: 'disabled' | 'not-built' | 'ready' | 'unavailable'; chunkCount: number; activeChunkCount?: number; embeddingModel: string };
}

interface PluginHealth {
  builtIn: Array<{ id: string }>;
  plugins: Array<{ id: string; enabled: boolean; compatible: boolean; status: 'installed' | 'blocked' | 'broken' }>;
}

interface Props {
  profile: StoredAppProfile;
  onAddDocument: () => void;
  onAddTest: () => void;
  onOpenGeneration: () => void;
  onOpenPlugins: () => void;
  onOpenTest: (id: string) => void;
  onOpenTutorial: () => void;
}

export default function HomePage({ profile, onAddDocument, onAddTest, onOpenGeneration, onOpenPlugins, onOpenTest, onOpenTutorial }: Props) {
  const configured = useConfiguredProviders();
  const advanced = profile.interfaceMode === 'advanced';
  const [systemHealth, setSystemHealth] = useState<{ index?: IndexHealth; plugins?: PluginHealth; error?: string; loading: boolean }>({ loading: true });
  const data = useLiveQuery(async () => {
    const [documents, testCount, tests, jobs, indexJobs, drafts] = await Promise.all([
      db.documents.count(),
      db.tests.count(),
      db.tests.orderBy('createdAt').reverse().limit(4).toArray(),
      db.generationJobs.toArray(),
      db.indexJobs.toArray(),
      db.testDrafts.orderBy('updatedAt').reverse().toArray(),
    ]);
    return { documents, testCount, tests, jobs, indexJobs, drafts };
  }, []);
  const activeGenerationJobs = data?.jobs.filter(job => ['queued', 'running', 'waiting', 'paused', 'error'].includes(job.status)) ?? [];
  const activeIndexJobs = data?.indexJobs.filter(job => ['queued', 'running', 'failed'].includes(job.status)) ?? [];
  const activeJobCount = activeGenerationJobs.length + activeIndexJobs.length;
  const hasRunningJob = activeGenerationJobs.some(job => job.status === 'running') || activeIndexJobs.some(job => job.status === 'running');
  const completion = Math.round(profile.onboarding.completedSteps.length / ONBOARDING_STEPS.length * 100);
  const showWhatsNew = profile.upgradedExistingLibrary && profile.whatsNewDismissedVersion !== CURRENT_WHATS_NEW_VERSION;
  const refreshHealth = useCallback(async () => {
    setSystemHealth(current => ({ ...current, loading: true }));
    try {
      const [index, plugins] = await Promise.all([
        serviceRequest<IndexHealth>('/api/v1/index/status'),
        serviceRequest<PluginHealth>('/api/v1/plugins'),
      ]);
      setSystemHealth({ index, plugins, loading: false });
    } catch (error) {
      setSystemHealth(current => ({ ...current, error: error instanceof Error ? error.message : 'Local service is unavailable', loading: false }));
    }
  }, []);
  useEffect(() => {
    if (!advanced) return;
    void refreshHealth();
    const timer = window.setInterval(() => void refreshHealth(), 15_000);
    return () => window.clearInterval(timer);
  }, [advanced, refreshHealth]);

  const pluginProblems = systemHealth.plugins?.plugins.filter(plugin => !plugin.compatible || plugin.status !== 'installed').length ?? 0;
  const healthRows = [
    { label: 'Local service', detail: systemHealth.error ? 'Unavailable' : 'Authenticated and ready', status: systemHealth.error ? 'error' as const : 'success' as const, icon: <SafetyCertificateOutlined /> },
    { label: 'Retrieval index', detail: `${systemHealth.index?.documentCount ?? 0}/${data?.documents ?? 0} documents · ${systemHealth.index?.chunkCount ?? 0} sparse spans${systemHealth.index?.dense?.enabled ? ` · ${systemHealth.index.dense.activeChunkCount ?? 0} dense` : ''}`, status: systemHealth.index?.documentCount === (data?.documents ?? 0) && systemHealth.index?.dense?.status !== 'unavailable' ? 'success' as const : 'warning' as const, icon: <DatabaseOutlined /> },
    { label: 'AI routes', detail: configured.loading ? 'Checking providers…' : `${configured.providers.length} route${configured.providers.length === 1 ? '' : 's'} available`, status: configured.providers.length ? 'success' as const : 'warning' as const, icon: <ApiOutlined /> },
    { label: 'Plugins', detail: pluginProblems ? `${pluginProblems} need attention` : `${systemHealth.plugins?.builtIn.length ?? 0} built in · ${systemHealth.plugins?.plugins.length ?? 0} external`, status: pluginProblems ? 'error' as const : 'success' as const, icon: <RocketOutlined /> },
  ];

  return <div className="home-page">
    <div className="home-heading">
      <div>
        <Typography.Title level={2}>Welcome to Quizzer</Typography.Title>
        <Typography.Paragraph type="secondary">Turn your own documents into focused, source-grounded practice.</Typography.Paragraph>
      </div>
    </div>

    {showWhatsNew && <Alert closable type="info" showIcon icon={<RocketOutlined />} message="Quizzer 1.0 setup is here"
      description="Your existing library is unchanged. You can now choose a hardware profile and use Simple or Advanced creation."
      onClose={() => void updateAppProfile({ whatsNewDismissedVersion: CURRENT_WHATS_NEW_VERSION })}
      action={<Button size="small" onClick={onOpenTutorial}>View walkthrough</Button>} />}

    {!profile.onboarding.completedAt && !profile.onboarding.skipped && <Card className="home-onboarding-card">
      <div className="home-card-heading">
        <div><Typography.Title level={4}>Finish setting up Quizzer</Typography.Title><Typography.Text type="secondary">Your walkthrough is saved and can continue after a restart.</Typography.Text></div>
        <Button type="primary" onClick={onOpenTutorial}>Resume setup</Button>
      </div>
      <Progress aria-label="Onboarding completion" percent={completion} />
    </Card>}

    <Row gutter={[16, 16]}>
      <Col xs={12} md={advanced ? 6 : 8}><Card><Statistic title="Documents" value={data?.documents ?? 0} prefix={<FileAddOutlined />} /></Card></Col>
      <Col xs={12} md={advanced ? 6 : 8}><Card><Statistic title="Tests" value={data?.testCount ?? 0} prefix={<FormOutlined />} /></Card></Col>
      <Col xs={12} md={advanced ? 6 : 8}><Card><Statistic title={advanced ? 'Active jobs' : 'In progress'} value={activeJobCount} prefix={<SyncOutlined spin={hasRunningJob} />} /></Card></Col>
      {advanced && <Col xs={12} md={6}><Card><Statistic title="Profile" value={profile.hardwareProfile.toUpperCase()} prefix={<ApiOutlined />} /></Card></Col>}
    </Row>

    <Card title="Start here">
      <Space wrap>
        <Button data-onboarding-target="document" type="primary" icon={<FileAddOutlined />} onClick={onAddDocument}>Add documents</Button>
        <Button data-onboarding-target="create-test" icon={<FormOutlined />} onClick={onAddTest}>Create test</Button>
        {(advanced || (!configured.loading && !configured.providers.length)) && <Button data-onboarding-target="provider" icon={<ApiOutlined />} onClick={onOpenPlugins}>Configure AI</Button>}
        {(advanced || activeJobCount > 0) && <Button icon={<SyncOutlined />} onClick={onOpenGeneration}>View activity</Button>}
      </Space>
    </Card>

    {advanced && <Card title="System health" extra={<Button size="small" icon={<ReloadOutlined spin={systemHealth.loading} />} onClick={() => void refreshHealth()}>Refresh</Button>}>
      {systemHealth.error && <ErrorDisplay error={systemHealth.error} context="service" style={{ marginBottom: 12 }} />}
      <List size="small" dataSource={healthRows} renderItem={item => <List.Item actions={item.label === 'AI routes' || item.label === 'Plugins'
        ? [<Button type="link" size="small" key="manage" onClick={onOpenPlugins}>Manage</Button>] : undefined}>
        <List.Item.Meta avatar={<span className="system-health-icon">{item.icon}</span>} title={<Space><Badge status={item.status} />{item.label}</Space>} description={item.detail} />
      </List.Item>} />
    </Card>}

    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}><Card title="Recent tests" style={{ height: '100%' }}>
        {!data?.tests.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Your completed tests will appear here" /> : <div className="home-recent-list">
          {data.tests.map(test => <Button key={test.id} type="text" onClick={() => onOpenTest(test.id)}>
            <span>{test.name}</span><Tag>{test.questions.length} questions</Tag>
          </Button>)}
        </div>}
      </Card></Col>
      <Col xs={24} lg={12}><Card title="Resume learning" style={{ height: '100%' }}>
        {!data?.drafts.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No paused sessions" /> : <div className="home-recent-list">
          {data.drafts.slice(0, 4).map(draft => {
            const test = data.tests.find(item => item.id === draft.testId);
            return <Button key={draft.testId} type="text" onClick={() => onOpenTest(draft.testId)}>
              <span>{test?.name ?? 'Saved session'}</span>
              <Tag>{draft.practice ? 'Practice' : 'Test'} · Q{draft.currentIndex + 1}</Tag>
            </Button>;
          })}
        </div>}
      </Card></Col>
    </Row>
  </div>;
}
