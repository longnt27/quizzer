import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Descriptions, Divider, Drawer, Input, Modal, Progress, Radio, Space, Spin, Steps, Tag, Typography } from 'antd';
import { ApiOutlined, CheckCircleOutlined, FileAddOutlined, FormOutlined, LaptopOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type StoredAppProfile } from '../db/db';
import type { HardwareCapabilities, HardwareProfileId, InterfaceMode, OnboardingStep } from '../types';
import { useConfiguredProviders } from '../utils/useConfiguredProviders';
import { advanceOnboarding, goToOnboardingStep, ONBOARDING_STEPS, setHardwareProfile, setInterfaceMode, skipOnboarding, updateAppProfile } from '../utils/appProfile';
import { serviceFetch } from '../utils/serviceApi';

interface Props {
  open: boolean;
  profile: StoredAppProfile;
  onPause: () => void;
  onFinish: () => void;
  onOpenPlugins: () => void;
  onAddDocument: () => void;
  onAddTest: () => void;
  onOpenTest: (id: string) => void;
}

const labels: Record<OnboardingStep, string> = {
  welcome: 'Welcome', hardware: 'Hardware', provider: 'AI', document: 'Document', instruction: 'Goal', generate: 'Generate', practice: 'Practice', complete: 'Finish',
};

const profileDetails: Record<HardwareProfileId, string> = {
  lite: 'Sparse local search with remote or signed-in-agent generation. No model downloads.',
  balanced: 'Adds OCR on demand, local embeddings, and hybrid retrieval.',
  max: 'Enables heavier visual extraction, reranking, and optional local generation.',
};

export default function OnboardingGuide({ open, profile, onPause, onFinish, onOpenPlugins, onAddDocument, onAddTest, onOpenTest }: Props) {
  const configured = useConfiguredProviders();
  const library = useLiveQuery(async () => {
    const [documents, tests, jobs, drafts] = await Promise.all([db.documents.toArray(), db.tests.toArray(), db.generationJobs.toArray(), db.testDrafts.toArray()]);
    return { documents, tests, jobs, drafts };
  }, []);
  const [hardware, setHardware] = useState<HardwareCapabilities>();
  const [hardwareError, setHardwareError] = useState('');
  const [instruction, setInstruction] = useState(profile.defaultLearningInstruction ?? '');
  const step = profile.onboarding.currentStep;
  const index = ONBOARDING_STEPS.indexOf(step);

  useEffect(() => setInstruction(profile.defaultLearningInstruction ?? ''), [profile.defaultLearningInstruction]);
  useEffect(() => {
    if (!open || hardware || hardwareError) return;
    void serviceFetch('/api/system/capabilities').then(async response => {
      if (!response.ok) throw new Error('Hardware scan is unavailable');
      setHardware(await response.json() as HardwareCapabilities);
    }).catch(error => setHardwareError((error as Error).message));
  }, [hardware, hardwareError, open]);

  const onboardingDocument = library?.documents.find(document => document.id === profile.onboarding.documentId && document.content.trim());
  const generationJob = library?.jobs.find(job => job.id === profile.onboarding.generationJobId
    && job.testId === profile.onboarding.generationTestId);
  const generatedTest = library?.tests.find(test => test.id === profile.onboarding.generationTestId);
  const practiceComplete = useMemo(() => Boolean(generatedTest?.attempts.length
    || library?.drafts.some(draft => draft.testId === generatedTest?.id
      && Object.values(draft.submittedQuestions).some(Boolean))), [generatedTest, library]);
  const requirementMet: Record<OnboardingStep, boolean> = {
    welcome: true,
    hardware: Boolean(hardware) || Boolean(hardwareError),
    provider: configured.providers.length > 0,
    document: Boolean(onboardingDocument),
    instruction: true,
    generate: Boolean(generationJob && generatedTest),
    practice: practiceComplete,
    complete: true,
  };

  const next = async () => {
    if (step === 'welcome') await setInterfaceMode(profile.interfaceMode);
    if (step === 'hardware') await setHardwareProfile(profile.hardwareProfile);
    if (step === 'instruction') await updateAppProfile({ defaultLearningInstruction: instruction.trim() || undefined });
    if (step === 'complete') {
      await advanceOnboarding('complete', 'complete');
      onFinish();
      return;
    }
    await advanceOnboarding(step, ONBOARDING_STEPS[index + 1]);
  };

  const chooseRecommended = async (capabilities: HardwareCapabilities) => {
    setHardware(capabilities);
    await setHardwareProfile(capabilities.recommendedProfile);
  };

  const confirmSkip = () => Modal.confirm({
    title: 'Skip setup?',
    content: 'You can restart the walkthrough at any time from the sidebar. Your current documents and settings will stay intact.',
    okText: 'Skip for now',
    onOk: async () => { await skipOnboarding(); onFinish(); },
  });

  return <Drawer className="onboarding-drawer" title="Set up Quizzer" width={440} open={open} mask={index === 0} closable onClose={onPause}
    extra={<Button type="text" onClick={confirmSkip}>Skip</Button>}
    footer={<div className="onboarding-footer">
      <Button disabled={index === 0} onClick={() => void goToOnboardingStep(ONBOARDING_STEPS[index - 1])}>Back</Button>
      <Typography.Text type="secondary">Step {index + 1} of {ONBOARDING_STEPS.length}</Typography.Text>
      <Button type="primary" disabled={!requirementMet[step]} onClick={() => void next()}>{step === 'complete' ? 'Finish' : 'Continue'}</Button>
    </div>}>
    <Progress percent={Math.round(index / (ONBOARDING_STEPS.length - 1) * 100)} showInfo={false} />
    <Steps size="small" current={index} direction="vertical" className="onboarding-steps"
      items={ONBOARDING_STEPS.map(item => ({ title: labels[item], status: profile.onboarding.completedSteps.includes(item) ? 'finish' : item === step ? 'process' : 'wait' }))} />
    <Divider />

    {step === 'welcome' && <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={3}>Learn from your own material</Typography.Title>
      <Typography.Paragraph>Quizzer keeps your library on this device. Only the source excerpts needed for a request are sent to the AI route you approve.</Typography.Paragraph>
      <Radio.Group value={profile.interfaceMode} onChange={event => void setInterfaceMode(event.target.value as InterfaceMode)} className="onboarding-choice-grid">
        <Radio.Button value="simple"><strong>Simple</strong><span>Recommended settings and a short creation flow</span></Radio.Button>
        <Radio.Button value="advanced"><strong>Advanced</strong><span>Provider, model, coverage, batching, and validation controls</span></Radio.Button>
      </Radio.Group>
    </Space>}

    {step === 'hardware' && <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={3}>Choose a hardware profile</Typography.Title>
      {!hardware && !hardwareError && <Space><Spin /><Typography.Text>Scanning CPU, memory, and free disk space…</Typography.Text></Space>}
      {hardwareError && <Alert type="warning" showIcon message={hardwareError} description="Lite is safe on every supported machine. You can change this later." />}
      {hardware && <>
        <Descriptions bordered size="small" column={2} items={[
          { key: 'cpu', label: 'CPU', children: `${hardware.cpuCores} cores` },
          { key: 'ram', label: 'Memory', children: `${hardware.memoryGB} GB` },
          { key: 'disk', label: 'Free disk', children: `${hardware.freeDiskGB} GB` },
          { key: 'arch', label: 'System', children: `${hardware.platform} ${hardware.architecture}` },
        ]} />
        <Alert type="success" showIcon message={`${hardware.recommendedProfile.toUpperCase()} is recommended`} description={hardware.reasons.join(' ')}
          action={<Button size="small" onClick={() => void chooseRecommended(hardware)}>Use recommendation</Button>} />
      </>}
      <Radio.Group value={profile.hardwareProfile} onChange={event => void setHardwareProfile(event.target.value)}>
        <Space direction="vertical">{(['lite', 'balanced', 'max'] as HardwareProfileId[]).map(item => <Radio key={item} value={item}><strong>{item.toUpperCase()}</strong> — {profileDetails[item]}</Radio>)}</Space>
      </Radio.Group>
      <Typography.Text type="secondary">Quizzer always asks before downloading a large model.</Typography.Text>
    </Space>}

    {step === 'provider' && <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <LaptopOutlined className="onboarding-hero-icon" />
      <Typography.Title level={3}>Configure your AI</Typography.Title>
      <Typography.Paragraph>Use an already signed-in CLI agent or add an API provider. Credentials are not included in library sync or diagnostics.</Typography.Paragraph>
      {configured.loading ? <Spin /> : configured.providers.length
        ? <Alert type="success" showIcon message="AI is ready" description={<Space wrap>{configured.providers.map(item => <Tag color="success" key={item.id}>{item.label}</Tag>)}</Space>} />
        : <Alert type="warning" showIcon message="Connect at least one provider to continue" />}
      <Button type="primary" icon={<ApiOutlined />} onClick={onOpenPlugins}>{configured.providers.length ? 'Review AI settings' : 'Configure AI'}</Button>
    </Space>}

    {step === 'document' && <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <FileAddOutlined className="onboarding-hero-icon" />
      <Typography.Title level={3}>Import a real document</Typography.Title>
      <Typography.Paragraph>Add a PDF, Markdown, or text file. This step completes only after readable content is extracted and saved.</Typography.Paragraph>
      {onboardingDocument ? <Alert type="success" showIcon message={`${onboardingDocument.name} is readable and saved`} /> : null}
      <Button type="primary" icon={<FileAddOutlined />} onClick={onAddDocument}>Add document</Button>
    </Space>}

    {step === 'instruction' && <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Title level={3}>What do you want to learn?</Typography.Title>
      <Typography.Paragraph>Give Quizzer an optional emphasis. It is saved as your starting value and snapshotted with each generated test.</Typography.Paragraph>
      <Input.TextArea rows={5} maxLength={2000} showCount value={instruction} onChange={event => setInstruction(event.target.value)}
        placeholder="For example: coding questions about Terraform only" />
      <Typography.Text type="secondary">Leave this blank for broad coverage. Source documents are always treated as untrusted content, never as instructions.</Typography.Text>
    </Space>}

    {step === 'generate' && <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <FormOutlined className="onboarding-hero-icon" />
      <Typography.Title level={3}>Create your first quiz</Typography.Title>
      <Typography.Paragraph>Review the source, learning goal, provider, and privacy note, then queue generation. Progress is checkpointed in Activity.</Typography.Paragraph>
      {generationJob && ['queued', 'running', 'waiting', 'paused'].includes(generationJob.status) && <Alert type="info" showIcon message="Your quiz is being generated" description="You can pause this walkthrough and come back when it finishes." />}
      {generationJob?.status === 'error' && <Alert type="warning" showIcon message="Generation needs attention" description={generationJob.error || 'Open Activity to retry or switch routes without losing progress.'} />}
      {generatedTest && <Alert type="success" showIcon message={`${generatedTest.name} is ready`} description={`${generatedTest.questions.length} validated questions`} />}
      <Button type="primary" icon={<FormOutlined />} onClick={onAddTest}>{generatedTest ? 'Create another test' : 'Create test'}</Button>
    </Space>}

    {step === 'practice' && <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <PlayCircleOutlined className="onboarding-hero-icon" />
      <Typography.Title level={3}>Try one question</Typography.Title>
      <Typography.Paragraph>Open the generated test in Practice mode, answer one question, and check it. You’ll see feedback and can use citations or Ask AI where available.</Typography.Paragraph>
      {practiceComplete && <Alert type="success" showIcon icon={<CheckCircleOutlined />} message="First question answered" />}
      {generatedTest && <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => onOpenTest(generatedTest.id)}>Open {generatedTest.name}</Button>}
    </Space>}

    {step === 'complete' && <Card className="onboarding-complete-card">
      <CheckCircleOutlined />
      <Typography.Title level={3}>You’re ready</Typography.Title>
      <Typography.Paragraph>Your setup, profile, and progress are saved. Head Home to add more sources, resume work, or create another test.</Typography.Paragraph>
    </Card>}
  </Drawer>;
}
