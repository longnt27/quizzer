import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Descriptions, Divider, Drawer, Input, Radio, Space, Spin, Progress, Tag, Typography } from 'antd';
import { ApiOutlined, CheckCircleOutlined, FileAddOutlined, FormOutlined, LaptopOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type StoredAppProfile } from '../db/db';
import type { HardwareCapabilities, HardwareProfileId, InterfaceMode, OnboardingStep } from '../types';
import { useConfiguredProviders } from '../utils/useConfiguredProviders';
import { advanceOnboarding, goToOnboardingStep, ONBOARDING_STEPS, setHardwareProfile, setInterfaceMode, skipOnboarding, updateAppProfile } from '../utils/appProfile';
import { serviceFetch } from '../utils/serviceApi';
import { getModalApi } from '../utils/modalProvider';

interface Props {
  open: boolean;
  profile: StoredAppProfile;
  onPause: () => void;
  onFinish: () => void;
  onOpenPlugins: () => void;
  onAddDocument: () => void;
  onAddTest: () => void;
  onOpenTest: (id: string) => void;
  overlayOpen: boolean;
}

const labels: Record<OnboardingStep, string> = {
  welcome: 'Welcome', hardware: 'Hardware', provider: 'AI', document: 'Document', instruction: 'Goal', generate: 'Generate', practice: 'Practice', complete: 'Finish',
};

const profileDetails: Record<HardwareProfileId, string> = {
  lite: 'Sparse local search with remote or signed-in-agent generation. No model downloads.',
  balanced: 'Adds OCR on demand, local embeddings, and hybrid retrieval.',
  max: 'Enables heavier visual extraction, reranking, and optional local generation.',
};

const coachmarkCopy: Partial<Record<OnboardingStep, { selector: string; title: string; body: string }>> = {
  provider: { selector: '[data-onboarding-target="provider"]', title: 'Set up an AI route', body: 'Use this real control to connect or review the provider used for generation.' },
  document: { selector: '[data-onboarding-target="document"]', title: 'Import your source', body: 'Add a readable PDF, text, or Markdown document here. The step completes only after it is saved.' },
  instruction: { selector: '[data-onboarding-target="learning-instruction"], [data-onboarding-target="create-test"]', title: 'Shape the first quiz', body: 'Your learning goal is carried into the real test-creation form when you create the quiz.' },
  generate: { selector: '[data-onboarding-target="create-test"]', title: 'Create the quiz', body: 'Open the real creation form, choose the source, review the route, and queue the test.' },
  practice: { selector: '[data-onboarding-target="practice-feedback"], [data-onboarding-target="citations"], [data-onboarding-target="ask-ai"], [data-onboarding-target="practice"]', title: 'Practice and inspect evidence', body: 'Answer, check the feedback, then review citations or ask AI about this answer.' },
};

const isVisibleTarget = (element: Element) => {
  const node = element as HTMLElement;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
};

function OnboardingCoachMark({ step, open, suspended }: { step: OnboardingStep; open: boolean; suspended: boolean }) {
  const copy = coachmarkCopy[step];
  const [target, setTarget] = useState<HTMLElement>();
  const [rect, setRect] = useState<DOMRect>();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => { setDismissed(false); }, [open, step]);
  useEffect(() => {
    if (!copy || suspended || (!open && step !== 'practice') || dismissed) { setTarget(undefined); setRect(undefined); return undefined; }
    let frame = 0;
    let targetObserver: ResizeObserver | undefined;
    let observedTarget: HTMLElement | undefined;
    const refreshObservedRect = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (observedTarget && document.contains(observedTarget)) setRect(observedTarget.getBoundingClientRect());
        else locate();
      });
    };
    const locate = () => {
      const next = [...document.querySelectorAll(copy.selector)].find(isVisibleTarget) as HTMLElement | undefined;
      setTarget(next);
      setRect(next?.getBoundingClientRect());
      if (next !== observedTarget) {
        targetObserver?.disconnect();
        targetObserver = undefined;
        observedTarget = next;
      }
      if (next && !targetObserver && 'ResizeObserver' in window) {
        targetObserver = new ResizeObserver(refreshObservedRect);
        targetObserver.observe(next);
      }
    };
    const refresh = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(locate); };
    refresh();
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'] });
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') setDismissed(true); };
    window.addEventListener('keydown', keyboard);
    return () => {
      window.cancelAnimationFrame(frame);
      targetObserver?.disconnect();
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('keydown', keyboard);
      observer.disconnect();
    };
  }, [copy, dismissed, open, step, suspended]);

  if (!copy || dismissed || suspended || !target || !rect || (!open && step !== 'practice')) return null;
  const top = Math.max(12, Math.min(window.innerHeight - 150, rect.bottom + 12));
  const left = Math.max(12, Math.min(window.innerWidth - 332, rect.left));
  return <>
    <div className="onboarding-coach-highlight" aria-hidden="true" style={{ top: rect.top - 5, left: rect.left - 5, width: rect.width + 10, height: rect.height + 10 }} />
    <aside className="onboarding-coachmark" role="region" aria-label="Onboarding hint" style={{ top, left }}>
      <div aria-live="polite"><strong>{copy.title}</strong><p>{copy.body}</p></div>
      <Button type="text" size="small" aria-label="Dismiss walkthrough hint" onClick={() => setDismissed(true)}>Dismiss</Button>
    </aside>
  </>;
}

export default function OnboardingGuide({ open, profile, onPause, onFinish, onOpenPlugins, onAddDocument, onAddTest, onOpenTest, overlayOpen }: Props) {
  const configured = useConfiguredProviders();
  const library = useLiveQuery(async () => {
    const [documents, tests, jobs, drafts] = await Promise.all([db.documents.toArray(), db.tests.toArray(), db.generationJobs.toArray(), db.testDrafts.toArray()]);
    return { documents, tests, jobs, drafts };
  }, []);
  const [hardware, setHardware] = useState<HardwareCapabilities>();
  const [hardwareError, setHardwareError] = useState('');
  const recommendationApplied = useRef(false);
  const [instruction, setInstruction] = useState(profile.defaultLearningInstruction ?? '');
  const step = profile.onboarding.currentStep;
  const index = ONBOARDING_STEPS.indexOf(step);

  useEffect(() => setInstruction(profile.defaultLearningInstruction ?? ''), [profile.defaultLearningInstruction]);
  useEffect(() => {
    if (!open || hardware || hardwareError) return;
    void serviceFetch('/api/system/capabilities').then(async response => {
      if (!response.ok) throw new Error('Hardware scan is unavailable');
      const capabilities = await response.json() as HardwareCapabilities;
      setHardware(capabilities);
      if (!recommendationApplied.current && !profile.onboarding.completedSteps.includes('hardware')) {
        recommendationApplied.current = true;
        await setHardwareProfile(capabilities.recommendedProfile);
      }
    }).catch(error => setHardwareError((error as Error).message));
  }, [hardware, hardwareError, open, profile.onboarding.completedSteps]);

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

  const confirmSkip = () => getModalApi().confirm({
    title: 'Skip setup?',
    content: 'You can restart the walkthrough at any time from the sidebar. Your current documents and settings will stay intact.',
    okText: 'Skip for now',
    onOk: async () => { await skipOnboarding(); onFinish(); },
  });

  return <>
  <OnboardingCoachMark step={step} open={open} suspended={overlayOpen} />
  <Drawer className="onboarding-drawer" title="Set up Quizzer" width={440} open={open} mask={index === 0} closable onClose={onPause}
    extra={<Button type="text" onClick={confirmSkip}>Skip</Button>}
    footer={<div className="onboarding-footer">
      <Button disabled={index === 0} onClick={() => void goToOnboardingStep(ONBOARDING_STEPS[index - 1])}>Back</Button>
      <Typography.Text type="secondary">Step {index + 1} of {ONBOARDING_STEPS.length}</Typography.Text>
      <Button type="primary" disabled={!requirementMet[step]} onClick={() => void next()}>{step === 'complete' ? 'Finish' : 'Continue'}</Button>
    </div>}>
    <div aria-label="Setup progress" role="progressbar" aria-valuenow={index + 1} aria-valuemin={1} aria-valuemax={ONBOARDING_STEPS.length}>
      <Progress percent={Math.round((index / (ONBOARDING_STEPS.length - 1)) * 100)} showInfo={false} size="small" />
    </div>
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
        <Alert type="success" showIcon message={`${hardware.recommendedProfile.toUpperCase()} is recommended and selected`} description={hardware.reasons.join(' ')} />
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
  </Drawer>
  </>;
}
