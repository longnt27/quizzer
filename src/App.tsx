import { useEffect, useState } from 'react';
import { Button, ConfigProvider, Drawer, Grid, Layout, message, theme } from 'antd';
import { MenuOutlined } from '@ant-design/icons';
import Sidebar, { type LibrarySelection } from './components/Sidebar';
import MainContent from './components/MainContent';
import AddTestModal from './components/AddTestModal';
import AddDocumentModal from './components/AddDocumentModal';
import DocumentView from './components/DocumentView';
import PluginsModal from './components/PluginsModal';
import GenerationWorker from './components/GenerationWorker';
import { GenerationActivity, GenerationCenter } from './components/GenerationCenter';
import { setMessageApi } from './utils/messageProvider';
import type { TestSession } from './types';
import { db } from './db/db';
import type { StoredAppProfile } from './db/db';
import { useLiveQuery } from 'dexie-react-hooks';
import HomePage from './components/HomePage';
import OnboardingGuide from './components/OnboardingGuide';
import { setInterfaceMode } from './utils/appProfile';

interface ShellProps { dark: boolean; onToggleTheme: () => void; }

function AppShell({ dark, onToggleTheme }: ShellProps) {
  const [selection, setSelection] = useState<LibrarySelection>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDocumentModal, setShowDocumentModal] = useState(false);
  const [showPluginsModal, setShowPluginsModal] = useState(false);
  const [showGenerationCenter, setShowGenerationCenter] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [session, setSession] = useState<TestSession | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const screens = Grid.useBreakpoint();
  const mobile = screens.md === false;
  const profile = useLiveQuery(() => db.profiles.get('default'), []) as StoredAppProfile | undefined;
  setMessageApi(messageApi);

  useEffect(() => {
    let active = true;
    void db.testDrafts.orderBy('updatedAt').last().then(async draft => {
      if (!draft || !active || !await db.tests.get(draft.testId)) return;
      const pauseDuration = draft.pausedAt ? Math.max(0, Date.now() - draft.pausedAt) : 0;
      const resumedStartedAt = draft.startedAt + pauseDuration;
      if (draft.pausedAt) {
        await db.testDrafts.put({ ...draft, pausedAt: undefined, startedAt: resumedStartedAt, updatedAt: Date.now() });
      }
      setSelection({ kind: 'test', id: draft.testId });
      setSession({
        testId: draft.testId,
        mode: 'taking',
        timeLimit: draft.timeLimit,
        startedAt: resumedStartedAt,
        options: { instantFeedback: draft.practice },
      });
    });
    return () => { active = false; };
  }, []);

  const select = (next: LibrarySelection) => {
    setSelection(next);
    setSession(null);
    setMobileMenuOpen(false);
  };

  const sidebarProps = {
    selection,
    onSelect: select,
    onAddTest: () => { setShowAddModal(true); setMobileMenuOpen(false); },
    onAddDocument: () => { setShowDocumentModal(true); setMobileMenuOpen(false); },
    onOpenPlugins: () => { setShowPluginsModal(true); setMobileMenuOpen(false); },
    onOpenGeneration: () => { setShowGenerationCenter(true); setMobileMenuOpen(false); },
    onOpenHome: () => select(null),
    onOpenTutorial: () => { setShowOnboarding(true); setMobileMenuOpen(false); },
    profile,
    onToggleInterfaceMode: () => profile && void setInterfaceMode(profile.interfaceMode === 'simple' ? 'advanced' : 'simple'),
    dark,
    onToggleTheme,
  };

  return <>
    {contextHolder}
    <GenerationWorker />
    <Layout className="app-shell">
      {!mobile && session?.mode !== 'taking' && <Sidebar {...sidebarProps} />}
      {mobile && session?.mode !== 'taking' && (
        <header className="mobile-header">
          <Button aria-label="Open navigation" type="text" icon={<MenuOutlined />} onClick={() => setMobileMenuOpen(true)} />
          <strong>Quizzer</strong>
          <span className="mobile-header-spacer" />
        </header>
      )}
      <main className={`app-main ${mobile && session?.mode !== 'taking' ? 'with-mobile-header' : ''}`}>
        {selection?.kind === 'document' ? <DocumentView documentId={selection.id} /> : selection?.kind === 'test' ? (
          <MainContent
            selectedTestId={selection.id}
            setSelectedTestId={id => setSelection({ kind: 'test', id })}
            session={session}
            setSession={setSession}
            onAddTest={() => setShowAddModal(true)}
            onOpenDocument={id => select({ kind: 'document', id })}
          />
        ) : profile ? <HomePage profile={profile} onAddDocument={() => setShowDocumentModal(true)} onAddTest={() => setShowAddModal(true)}
          onOpenGeneration={() => setShowGenerationCenter(true)} onOpenPlugins={() => setShowPluginsModal(true)}
          onOpenTest={id => setSelection({ kind: 'test', id })} onOpenTutorial={() => setShowOnboarding(true)} /> : null}
      </main>
      <Drawer placement="left" width="min(88vw, 340px)" open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} styles={{ body: { padding: 0 } }}>
        <Sidebar {...sidebarProps} embedded />
      </Drawer>
      {showAddModal && profile && <AddTestModal profile={profile} onClose={() => setShowAddModal(false)} onManagePlugins={() => setShowPluginsModal(true)} />}
      {showDocumentModal && <AddDocumentModal onClose={() => setShowDocumentModal(false)} onCreated={id => {
        setSelection({ kind: 'document', id }); setShowDocumentModal(false);
      }} />}
      {showPluginsModal && <PluginsModal onClose={() => setShowPluginsModal(false)} />}
      {showGenerationCenter && <GenerationCenter open onClose={() => setShowGenerationCenter(false)} onManagePlugins={() => setShowPluginsModal(true)} onOpenTest={id => {
        setSelection({ kind: 'test', id }); setSession(null);
      }} />}
      {profile && <OnboardingGuide open={showOnboarding && !profile.onboarding.completedAt && !profile.onboarding.skipped} profile={profile}
        onPause={() => setShowOnboarding(false)} onFinish={() => { setShowOnboarding(false); select(null); }}
        onOpenPlugins={() => setShowPluginsModal(true)} onAddDocument={() => setShowDocumentModal(true)} onAddTest={() => setShowAddModal(true)}
        onOpenTest={id => { setSelection({ kind: 'test', id }); setShowOnboarding(false); }} />}
      {session?.mode !== 'taking' && <GenerationActivity onOpen={() => setShowGenerationCenter(true)} />}
    </Layout>
  </>;
}

export default function App() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('quizzer.theme');
    return saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    localStorage.setItem('quizzer.theme', dark ? 'dark' : 'light');
  }, [dark]);

  return (
    <ConfigProvider theme={{
      algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: { colorPrimary: '#1677ff', borderRadius: 8 },
    }}>
      <AppShell dark={dark} onToggleTheme={() => setDark(value => !value)} />
    </ConfigProvider>
  );
}
