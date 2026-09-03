import { useEffect, useState } from 'react';
import { db, StoredTest } from '../db/db';
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
    const [timeLimit, setTimeLimit] = useState<number | undefined>(0);
    const [starting, setStarting] = useState(false);

    useEffect(() => {
        if (!selectedTestId) {
            setTest(null);
            return;
        }
        db.tests.get(selectedTestId).then(value => setTest(value ?? null));
        setStarting(false);
    }, [selectedTestId]);

    const handleNewTestCreated = (id: string) => {
        setSelectedTestId(id);
    }

    const handleStartTest = (options: {timeLimit?: number; practice: boolean}) => {
        if (!test) return;
        setStarting(false);
        setSession({testId: test.id, mode: 'taking', options: { instantFeedback: options.practice }});
        if (options.timeLimit)
            setTimeLimit(options.timeLimit);
        else
            setTimeLimit(undefined);
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
        return <TestTaking test={test} onFinish={() => setSession(null)} timeLimit={timeLimit} practice={session.options?.instantFeedback} />;
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
