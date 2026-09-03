import { useEffect, useState } from 'react';
import { db, type StoredTest, type StoredTestDraft } from '../db/db';
import TestStart from './TestStart';
import TestSummary from './TestSummary';
import TestTaking from './TestTaking';
import TestReview from './TestReview';
import { TestSession } from '../types';
import { Button, Typography } from 'antd';

const { Title, Paragraph } = Typography;

interface Props {
    selectedTestId: string | null;
    setSelectedTestId: (s: string) => void;
    session: TestSession | null;
    setSession: (s: TestSession | null) => void;
    onAddTest: () => void;
    timeLimit?: number;
}

const MainContent: React.FC<Props> = ({ selectedTestId, setSelectedTestId, session, setSession, onAddTest }) => {
    const [test, setTest] = useState<StoredTest | null>(null);
    const [draft, setDraft] = useState<StoredTestDraft | undefined>();
    const [starting, setStarting] = useState(false);

    useEffect(() => {
        if (!selectedTestId) {
            setTest(null);
            setDraft(undefined);
            return;
        }
        setTest(null);
        setDraft(undefined);
        void Promise.all([db.tests.get(selectedTestId), db.testDrafts.get(selectedTestId)]).then(([value, savedDraft]) => {
            setTest(value ?? null);
            setDraft(savedDraft);
        });
        setStarting(false);
    }, [selectedTestId]);

    const handleNewTestCreated = (id: string) => {
        setSelectedTestId(id);
    }

    const handleStartTest = (options: {timeLimit?: number; practice: boolean}) => {
        if (!test) return;
        setStarting(false);
        setDraft(undefined);
        void db.testDrafts.delete(test.id);
        setSession({testId: test.id, mode: 'taking', timeLimit: options.timeLimit, startedAt: Date.now(), options: { instantFeedback: options.practice }});
    }

    if (!test) {
        return (
            <div
                style={{
                    height: '100%',
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexDirection: 'column',
                    textAlign: 'center',
                    padding: 32,
                }}
            >
                <Title level={3}>Choose a test from the sidebar</Title>
                <Paragraph>...or create a new one to begin your quiz journey.</Paragraph>
                <Button type="primary" onClick={onAddTest}>
                    Create New Test
                </Button>
            </div>
        );
    }

    const latest = test.attempts[test.attempts.length - 1];

    if (!test.attempts.length && !session) {
        return <TestStart test={test} onStart={handleStartTest} />;
    }

    if (session?.mode === 'taking') {
        return <TestTaking test={test} onFinish={() => setSession(null)} timeLimit={session.timeLimit} practice={session.options?.instantFeedback}
            startedAt={session.startedAt} initialDraft={draft} />;
    }

    if (session?.mode === 'reviewing') {
        return <TestReview test={test} onBack={() => setSession(null)} />;
    }

    if (!latest && !session || starting) {
        return (
            <TestStart
                test={test}
                onStart={handleStartTest}
            />
        );
    }

    return <TestSummary test={test} setSession={setSession} setStarting={setStarting} onNewTestCreated={handleNewTestCreated} />;
};

export default MainContent;
