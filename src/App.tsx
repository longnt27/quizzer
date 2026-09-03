import { useState } from 'react';
import { Layout, message } from 'antd';
import Sidebar from './components/Sidebar';
import MainContent from './components/MainContent';
import AddTestModal from './components/AddTestModal';
import AddDocumentModal from './components/AddDocumentModal';
import DocumentView from './components/DocumentView';
import type { LibrarySelection } from './components/Sidebar';
import { setMessageApi } from './utils/messageProvider';

interface TestSession {
    mode: 'taking' | 'reviewing';
    testId: string;
    timeLimit?: number;
}

const App = () => {
    const [selection, setSelection] = useState<LibrarySelection>(null);
    const [showAddModal, setShowAddModal] = useState(false);
    const [showDocumentModal, setShowDocumentModal] = useState(false);
    const [session, setSession] = useState<TestSession | null>(null);
    const [messageApi, contextHolder] = message.useMessage();

    setMessageApi(messageApi);

    return (
        <>
            {contextHolder}
            <Layout style={{ display: 'flex', height: '100vh', width: '99vw' }}>
                {session?.mode !== 'taking' && (
                    <Sidebar
                        selection={selection}
                        onSelect={(next) => {
                            setSelection(next);
                            setSession(null);
                        }}
                        onAddTest={() => setShowAddModal(true)}
                        onAddDocument={() => setShowDocumentModal(true)}
                    />
                )}
                <div style={{ flex: 1, minWidth: 0, overflow: 'auto', height: '100%' }}>
                    {selection?.kind === 'document' ? <DocumentView documentId={selection.id} /> : (
                        <MainContent
                            selectedTestId={selection?.kind === 'test' ? selection.id : null}
                            setSelectedTestId={(id) => setSelection({ kind: 'test', id })}
                            session={session}
                            setSession={setSession}
                            onAddTest={() => setShowAddModal(true)}
                        />
                    )}
                </div>
                {showAddModal && (
                    <AddTestModal
                        onClose={() => setShowAddModal(false)}
                        onCreated={(id) => {
                            setSelection({ kind: 'test', id });
                            setShowAddModal(false);
                            setSession(null);
                        }}
                    />
                )}
                {showDocumentModal && (
                    <AddDocumentModal
                        onClose={() => setShowDocumentModal(false)}
                        onCreated={(id) => {
                            setSelection({ kind: 'document', id });
                            setShowDocumentModal(false);
                        }}
                    />
                )}
            </Layout>
        </>
    );
};

export default App;
