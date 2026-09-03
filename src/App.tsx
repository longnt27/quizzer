import { useEffect, useState } from 'react';
import { Button, ConfigProvider, Drawer, Grid, Layout, message, theme } from 'antd';
import { MenuOutlined } from '@ant-design/icons';
import Sidebar, { type LibrarySelection } from './components/Sidebar';
import MainContent from './components/MainContent';
import AddTestModal from './components/AddTestModal';
import AddDocumentModal from './components/AddDocumentModal';
import DocumentView from './components/DocumentView';
import { setMessageApi } from './utils/messageProvider';

interface TestSession {
  mode: 'taking' | 'reviewing';
  testId: string;
  timeLimit?: number;
}

interface ShellProps { dark: boolean; onToggleTheme: () => void; }

function AppShell({ dark, onToggleTheme }: ShellProps) {
  const [selection, setSelection] = useState<LibrarySelection>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDocumentModal, setShowDocumentModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [session, setSession] = useState<TestSession | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const screens = Grid.useBreakpoint();
  const mobile = screens.md === false;
  setMessageApi(messageApi);

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
    dark,
    onToggleTheme,
  };

  return <>
    {contextHolder}
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
        {selection?.kind === 'document' ? <DocumentView documentId={selection.id} /> : (
          <MainContent
            selectedTestId={selection?.kind === 'test' ? selection.id : null}
            setSelectedTestId={id => setSelection({ kind: 'test', id })}
            session={session}
            setSession={setSession}
            onAddTest={() => setShowAddModal(true)}
          />
        )}
      </main>
      <Drawer placement="left" width="min(88vw, 340px)" open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} styles={{ body: { padding: 0 } }}>
        <Sidebar {...sidebarProps} embedded />
      </Drawer>
      {showAddModal && <AddTestModal onClose={() => setShowAddModal(false)} onCreated={id => {
        setSelection({ kind: 'test', id }); setShowAddModal(false); setSession(null);
      }} />}
      {showDocumentModal && <AddDocumentModal onClose={() => setShowDocumentModal(false)} onCreated={id => {
        setSelection({ kind: 'document', id }); setShowDocumentModal(false);
      }} />}
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
