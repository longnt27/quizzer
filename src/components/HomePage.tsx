import { Alert, Button, Card, Col, Empty, Progress, Row, Segmented, Space, Statistic, Tag, Typography } from 'antd';
import { ApiOutlined, FileAddOutlined, FormOutlined, PlayCircleOutlined, RocketOutlined, SyncOutlined } from '@ant-design/icons';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type StoredAppProfile } from '../db/db';
import type { InterfaceMode } from '../types';
import { CURRENT_WHATS_NEW_VERSION, ONBOARDING_STEPS, setInterfaceMode, updateAppProfile } from '../utils/appProfile';

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
  const data = useLiveQuery(async () => {
    const [documents, tests, jobs, drafts] = await Promise.all([
      db.documents.count(),
      db.tests.orderBy('createdAt').reverse().limit(4).toArray(),
      db.generationJobs.toArray(),
      db.testDrafts.orderBy('updatedAt').reverse().toArray(),
    ]);
    return { documents, tests, jobs, drafts };
  }, []);
  const activeJobs = data?.jobs.filter(job => ['queued', 'running', 'waiting', 'paused'].includes(job.status)) ?? [];
  const completion = Math.round(profile.onboarding.completedSteps.length / ONBOARDING_STEPS.length * 100);
  const showWhatsNew = profile.upgradedExistingLibrary && profile.whatsNewDismissedVersion !== CURRENT_WHATS_NEW_VERSION;

  return <div className="home-page">
    <div className="home-heading">
      <div>
        <Typography.Title level={2}>Welcome to Quizzer</Typography.Title>
        <Typography.Paragraph type="secondary">Turn your own documents into focused, source-grounded practice.</Typography.Paragraph>
      </div>
      <Segmented aria-label="Interface mode" value={profile.interfaceMode} onChange={value => void setInterfaceMode(value as InterfaceMode)}
        options={[{ label: 'Simple', value: 'simple' }, { label: 'Advanced', value: 'advanced' }]} />
    </div>

    {showWhatsNew && <Alert closable type="info" showIcon icon={<RocketOutlined />} message="Quizzer 1.0 setup is here"
      description="Your existing library is unchanged. You can now choose a hardware profile, use Simple or Advanced creation, and attach a learning instruction to every quiz."
      onClose={() => void updateAppProfile({ whatsNewDismissedVersion: CURRENT_WHATS_NEW_VERSION })}
      action={<Button size="small" onClick={onOpenTutorial}>View walkthrough</Button>} />}

    {!profile.onboarding.completedAt && !profile.onboarding.skipped && <Card className="home-onboarding-card">
      <div className="home-card-heading">
        <div><Typography.Title level={4}>Finish setting up Quizzer</Typography.Title><Typography.Text type="secondary">Your walkthrough is saved and can continue after a restart.</Typography.Text></div>
        <Button type="primary" onClick={onOpenTutorial}>Resume setup</Button>
      </div>
      <Progress percent={completion} />
    </Card>}

    <Row gutter={[16, 16]}>
      <Col xs={12} md={6}><Card><Statistic title="Documents" value={data?.documents ?? 0} prefix={<FileAddOutlined />} /></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="Tests" value={data?.tests.length ?? 0} prefix={<FormOutlined />} /></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="Active jobs" value={activeJobs.length} prefix={<SyncOutlined spin={activeJobs.some(job => job.status === 'running')} />} /></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="Profile" value={profile.hardwareProfile.toUpperCase()} prefix={<ApiOutlined />} /></Card></Col>
    </Row>

    <Card title="Start here">
      <Space wrap>
        <Button type="primary" icon={<FileAddOutlined />} onClick={onAddDocument}>Add documents</Button>
        <Button icon={<FormOutlined />} onClick={onAddTest}>Create test</Button>
        <Button icon={<ApiOutlined />} onClick={onOpenPlugins}>Configure AI</Button>
        <Button icon={<SyncOutlined />} onClick={onOpenGeneration}>View activity</Button>
      </Space>
    </Card>

    <Row gutter={[16, 16]}>
      <Col xs={24} lg={14}><Card title="Recent tests">
        {!data?.tests.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Your completed tests will appear here" /> : <div className="home-recent-list">
          {data.tests.map(test => <Button key={test.id} type="text" onClick={() => onOpenTest(test.id)}>
            <span>{test.name}</span><Tag>{test.questions.length} questions</Tag>
          </Button>)}
        </div>}
      </Card></Col>
      <Col xs={24} lg={10}><Card title="Resume learning">
        {!data?.drafts.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No paused sessions" /> : <Space direction="vertical" style={{ width: '100%' }}>
          {data.drafts.slice(0, 3).map(draft => {
            const test = data.tests.find(item => item.id === draft.testId);
            return <Button key={draft.testId} block icon={<PlayCircleOutlined />} onClick={() => onOpenTest(draft.testId)}>{test?.name ?? 'Saved session'}</Button>;
          })}
        </Space>}
      </Card></Col>
    </Row>
  </div>;
}
