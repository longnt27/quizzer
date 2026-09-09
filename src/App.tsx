import { useCallback, useEffect, useState } from 'react';
import { App as AntdApp, Button, ConfigProvider, Drawer, Grid, Layout, theme } from 'antd';
import { ApiOutlined, ExperimentOutlined, FileAddOutlined, FormOutlined, HomeOutlined, MenuOutlined, MoonOutlined, QuestionCircleOutlined, SettingOutlined, SwapOutlined, SyncOutlined, SunOutlined } from '@ant-design/icons';
import Sidebar, { type LibrarySelection } from './components/Sidebar';
import MainContent from './components/MainContent';
import AddTestModal from './components/AddTestModal';
import AddDocumentModal from './components/AddDocumentModal';
import DocumentView from './components/DocumentView';
import PluginsModal from './components/PluginsModal';
import SettingsModal from './components/SettingsModal';
import CommandPalette, { type PaletteCommand } from './components/CommandPalette';
import GenerationWorker from './components/GenerationWorker';
import { GenerationActivity, GenerationCenter } from './components/GenerationCenter';
import { setMessageApi } from './utils/messageProvider';
import { setModalApi } from './utils/modalProvider';
import type { TestSession } from './types';
import { db } from './db/db';
import type { StoredAppProfile } from './db/db';
import { useLiveQuery } from 'dexie-react-hooks';
import HomePage from './components/HomePage';
import OnboardingGuide from './components/OnboardingGuide';
import { recordOnboardingDocument, recordOnboardingGeneration, restartOnboarding, setInterfaceMode } from './utils/appProfile';
import { useRuntimeSettings } from './utils/useRuntimeSettings';
import UpdateAvailableNotifier from './components/UpdateAvailableNotifier';
import {
  SHORTCUT_ACTIONS,
  changeKeyboardShortcut,
  formatKeyboardShortcut,
  keyboardShortcutMatches,
  loadKeyboardShortcuts,
  saveKeyboardShortcuts,
  type ShortcutActionId,
} from './utils/keyboardShortcuts';

interface ShellProps { dark: boolean; onThemeChange: (dark: boolean) => void; }

function AppShell({ dark, onThemeChange }: ShellProps) {
  const [selection, setSelection] = useState<LibrarySelection>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDocumentModal, setShowDocumentModal] = useState(false);
  const [showPluginsModal, setShowPluginsModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean | 'prompts'>(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showGenerationCenter, setShowGenerationCenter] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [session, setSession] = useState<TestSession | null>(null);
  const [keyboardShortcuts, setKeyboardShortcuts] = useState(loadKeyboardShortcuts);
  const { message: messageApi, modal: modalApi } = AntdApp.useApp();
  const screens = Grid.useBreakpoint();
  const mobile = screens.md === false;
  const profile = useLiveQuery(() => db.profiles.get('default'), []) as StoredAppProfile | undefined;
  const interfaceMode = profile?.interfaceMode;
  useRuntimeSettings(profile);
  setMessageApi(messageApi);
  setModalApi(modalApi);

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

  const select = useCallback((next: LibrarySelection) => {
    setSelection(next);
    setSession(null);
    setMobileMenuOpen(false);
  }, []);
  const openSettings = useCallback(() => setShowSettingsModal(true), []);

  const updateKeyboardShortcut = (actionId: ShortcutActionId, shortcut: string) => {
    const changed = changeKeyboardShortcut(keyboardShortcuts, actionId, shortcut);
    if (!changed.ok) {
      messageApi.error(changed.error);
      return;
    }
    try {
      saveKeyboardShortcuts(changed.shortcuts);
      setKeyboardShortcuts(changed.shortcuts);
    } catch {
      messageApi.error('Could not save keyboard shortcuts');
    }
  };

  const sidebarProps = {
    selection,
    onSelect: select,
    onAddTest: () => { setShowAddModal(true); setMobileMenuOpen(false); },
    onAddDocument: () => { setShowDocumentModal(true); setMobileMenuOpen(false); },
    onOpenPlugins: () => { setShowPluginsModal(true); setMobileMenuOpen(false); },
    onOpenSettings: () => { setShowSettingsModal(true); setMobileMenuOpen(false); },
    onOpenPromptStudio: () => { setShowSettingsModal('prompts'); setMobileMenuOpen(false); },
    onOpenGeneration: () => { setShowGenerationCenter(true); setMobileMenuOpen(false); },
    onOpenHome: () => select(null),
    onOpenTutorial: () => { setShowOnboarding(true); setMobileMenuOpen(false); },
    profile,
    dark,
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (event.defaultPrevented || event.repeat || target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const action = SHORTCUT_ACTIONS.find(candidate => keyboardShortcutMatches(event, keyboardShortcuts[candidate.id]));
      if (!action || (action.id === 'prompts' && interfaceMode !== 'advanced')) return;
      event.preventDefault();
      switch (action.id) {
        case 'command-palette': setShowCommandPalette(true); break;
        case 'settings': setShowSettingsModal(true); break;
        case 'home': select(null); break;
        case 'test-create': setShowAddModal(true); break;
        case 'document-add': setShowDocumentModal(true); break;
        case 'activity': setShowGenerationCenter(true); break;
        case 'plugins': setShowPluginsModal(true); break;
        case 'prompts': setShowSettingsModal('prompts'); break;
        case 'mode': if (interfaceMode) void setInterfaceMode(interfaceMode === 'simple' ? 'advanced' : 'simple'); break;
        case 'tutorial': void restartOnboarding().then(() => setShowOnboarding(true)); break;
        case 'theme': onThemeChange(!dark); break;
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [dark, interfaceMode, keyboardShortcuts, onThemeChange, select]);

  const commands: PaletteCommand[] = [
    { id: 'home', label: 'Go to Home', description: 'Open recent work, setup progress, and system status.', keywords: ['navigation'], shortcut: formatKeyboardShortcut(keyboardShortcuts.home), icon: <HomeOutlined />, run: () => select(null) },
    { id: 'test-create', label: 'Create a test', description: 'Choose sources and generate a new quiz.', keywords: ['quiz', 'generate'], shortcut: formatKeyboardShortcut(keyboardShortcuts['test-create']), icon: <FormOutlined />, run: () => setShowAddModal(true) },
    { id: 'document-add', label: 'Add documents', description: 'Import and index source material.', keywords: ['import', 'pdf', 'text'], shortcut: formatKeyboardShortcut(keyboardShortcuts['document-add']), icon: <FileAddOutlined />, run: () => setShowDocumentModal(true) },
    { id: 'activity', label: 'Open Activity', description: 'Review indexing and generation checkpoints.', keywords: ['activity', 'jobs', 'indexing'], shortcut: formatKeyboardShortcut(keyboardShortcuts.activity), icon: <SyncOutlined />, run: () => setShowGenerationCenter(true) },
    { id: 'plugins', label: 'Open plugins & models', description: 'Configure providers, extraction, OCR, and external plugins.', keywords: ['provider', 'api', 'models'], shortcut: formatKeyboardShortcut(keyboardShortcuts.plugins), icon: <ApiOutlined />, run: () => setShowPluginsModal(true) },
    { id: 'settings', label: 'Open Settings', description: 'Search and edit resolved application settings.', shortcut: formatKeyboardShortcut(keyboardShortcuts.settings), icon: <SettingOutlined />, run: () => setShowSettingsModal(true) },
    ...(profile?.interfaceMode === 'advanced' ? [{ id: 'prompts', label: 'Open Prompt Studio', description: 'Edit, validate, preview, import, and export prompt profiles.', keywords: ['templates', 'generation', 'grading', 'rag'], shortcut: formatKeyboardShortcut(keyboardShortcuts.prompts), icon: <ExperimentOutlined />, run: () => setShowSettingsModal('prompts') }] : []),
    { id: 'mode', label: `Switch to ${profile?.interfaceMode === 'advanced' ? 'Simple' : 'Advanced'} mode`, description: 'Change disclosure without changing stored capabilities or data.', keywords: ['interface'], shortcut: formatKeyboardShortcut(keyboardShortcuts.mode), icon: <SwapOutlined />, run: () => profile && setInterfaceMode(profile.interfaceMode === 'simple' ? 'advanced' : 'simple') },
    { id: 'tutorial', label: 'Restart tutorial', description: 'Return to the resumable first-run walkthrough.', keywords: ['help', 'onboarding'], shortcut: formatKeyboardShortcut(keyboardShortcuts.tutorial), icon: <QuestionCircleOutlined />, run: async () => { await restartOnboarding(); setShowOnboarding(true); } },
    { id: 'theme', label: `Use ${dark ? 'light' : 'dark'} theme`, description: 'Change the application color theme.', keywords: ['appearance'], shortcut: formatKeyboardShortcut(keyboardShortcuts.theme), icon: dark ? <SunOutlined /> : <MoonOutlined />, run: () => onThemeChange(!dark) },
  ];

  return <>
    <GenerationWorker />
    <UpdateAvailableNotifier onOpenSettings={openSettings} />
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
      {showAddModal && profile && <AddTestModal profile={profile} onClose={() => setShowAddModal(false)} onManagePlugins={() => setShowPluginsModal(true)} onOpenPromptStudio={() => setShowSettingsModal('prompts')}
        onCreated={async jobs => { const job = jobs[0]; if (job) await recordOnboardingGeneration(job.id, job.testId); }} />}
      {showDocumentModal && <AddDocumentModal onClose={() => setShowDocumentModal(false)} onCreated={async id => {
        await recordOnboardingDocument(id);
        setSelection({ kind: 'document', id }); setShowDocumentModal(false);
      }} />}
      {showPluginsModal && profile && <PluginsModal interfaceMode={profile.interfaceMode} onClose={() => setShowPluginsModal(false)} />}
      {showSettingsModal && profile && <SettingsModal profile={profile} dark={dark} onThemeChange={onThemeChange}
        keyboardShortcuts={keyboardShortcuts} onKeyboardShortcutChange={updateKeyboardShortcut}
        initialTab={typeof showSettingsModal === 'string' ? showSettingsModal : undefined}
        onOpenCommandPalette={() => { setShowSettingsModal(false); setShowCommandPalette(true); }} onClose={() => setShowSettingsModal(false)} />}
      <CommandPalette open={showCommandPalette} commands={commands} onClose={() => setShowCommandPalette(false)} />
      {showGenerationCenter && <GenerationCenter open onClose={() => setShowGenerationCenter(false)} onManagePlugins={() => setShowPluginsModal(true)} onOpenTest={id => {
        setSelection({ kind: 'test', id }); setSession(null);
      }} />}
      {profile && <OnboardingGuide open={showOnboarding && !profile.onboarding.completedAt && !profile.onboarding.skipped} profile={profile}
        onPause={() => setShowOnboarding(false)} onFinish={() => { setShowOnboarding(false); select(null); }}
        onOpenPlugins={() => setShowPluginsModal(true)} onAddDocument={() => setShowDocumentModal(true)} onAddTest={() => setShowAddModal(true)}
        onOpenTest={id => { setSelection({ kind: 'test', id }); setShowOnboarding(false); }}
        overlayOpen={Boolean(showPluginsModal || showDocumentModal || showAddModal || showGenerationCenter || showSettingsModal || showCommandPalette)} />}
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
      token: dark ? {
        colorPrimary: '#69b1ff', colorLink: '#69b1ff', colorTextLightSolid: '#101214', colorTextSecondary: '#b7c0cd', colorTextDescription: '#b7c0cd', borderRadius: 8,
      } : {
        colorPrimary: '#0050b3', colorLink: '#0050b3', colorTextSecondary: '#595959', colorTextDescription: '#595959', colorTextDisabled: '#666666', borderRadius: 8,
      },
    }}>
      <AntdApp>
        <AppShell dark={dark} onThemeChange={setDark} />
      </AntdApp>
    </ConfigProvider>
  );
}
