import { useState, useEffect, useRef, useCallback, useMemo, type FC, type ReactNode, type ReactElement } from 'react';
import { db, type StoredTest } from '../db/db';
import {
    Radio,
    Button,
    Checkbox,
    Typography,
    Space,
    Row,
    Col,
    Popconfirm,
} from 'antd';

const { Title, Paragraph } = Typography;

interface Props {
    test: StoredTest;
    onFinish: () => void;
    timeLimit?: number;
}

// ... (renderWithCode, renderHighlightedText, and SearchBar components remain unchanged)
const renderWithCode = (text: string): ReactNode => {
    if (!text || !text.includes('`')) {
        return <>{text}</>;
    }
    const codeStyle = { fontFamily: 'monospace', backgroundColor: 'var(--code)', padding: '2px 4px', borderRadius: '4px', fontSize: '0.9em' };
    const parts = text.split('`');
    return (
        <>
            {parts.map((part, i) => i % 2 === 1 ? ( <code key={i} style={codeStyle}>{part}</code> ) : ( <span key={i}>{part}</span> ))}
        </>
    );
};
const renderHighlightedText = (text: string, matches: { start: number; end: number; isCurrent: boolean }[]): ReactNode => {
    if (!matches || matches.length === 0) { return <>{text}</>; }
    const sortedMatches = [...matches].sort((a, b) => a.start - b.start);
    let lastIndex = 0;
    const parts: (string | ReactElement)[] = [];
    sortedMatches.forEach((match, i) => {
        if (match.start > lastIndex) { parts.push(text.substring(lastIndex, match.start)); }
        const style = { backgroundColor: match.isCurrent ? '#ffffa0' : '#ffd700', padding: '0', margin: '0', borderRadius: '3px' };
        parts.push(<mark key={`${i}-${match.start}`} style={style}>{text.substring(match.start, match.end)}</mark>);
        lastIndex = match.end;
    });
    if (lastIndex < text.length) { parts.push(text.substring(lastIndex)); }
    return <>{parts}</>;
};
interface SearchBarProps { query: string; setQuery: (q: string) => void; onPrev: () => void; onNext: () => void; onClose: () => void; current: number; total: number; inputRef: React.RefObject<HTMLInputElement | null>; }
const SearchBar: FC<SearchBarProps> = ({ query, setQuery, onPrev, onNext, onClose, current, total, inputRef }) => (
    <div className="quiz-search-bar">
        <input ref={inputRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all questions..." />
        <span>{query && total > 0 ? `${current + 1} of ${total}` : query ? 'Not found' : ''}</span>
        <Button size="middle" onClick={onPrev} disabled={total === 0}>Previous (N)</Button>
        <Button size="middle" onClick={onNext} disabled={total === 0}>Next (n)</Button>
        <Button size="middle" onClick={onClose} type="text" style={{color: '#aaa', marginLeft: 'auto'}}>Close (Esc)</Button>
    </div>
);


const TestTaking: React.FC<Props> = ({ test, onFinish, timeLimit }) => {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<number, string[]>>({});
    const [reviewMarks, setReviewMarks] = useState<Record<number, boolean>>({});
    const [shuffledAnswers, setShuffledAnswers] = useState<Record<number, typeof test.questions[0]['answer']>>({});
    const [remaining, setRemaining] = useState<number>(timeLimit ?? 0);
    const startRef = useRef(Date.now());
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const [isJumping, setIsJumping] = useState(false);
    const [jumpBuffer, setJumpBuffer] = useState('');
    const jumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const submitButtonRef = useRef<HTMLButtonElement>(null);

    const [isSearching, setIsSearching] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<{ questionIndex: number; location: 'statement' | 'answer'; answerContent?: string; match: { start: number; end: number } }[]>([]);
    const [currentResultIndex, setCurrentResultIndex] = useState(-1);
    const searchInputRef = useRef<HTMLInputElement>(null);

    // CHANGED: Simplified state for Popconfirm control
    const [isPopconfirmVisible, setIsPopconfirmVisible] = useState(false);


    const q = test.questions[currentIndex];
    const totalCorrect = q.answer.filter((a) => a.correct).length;
    const choices = useMemo(() => shuffledAnswers[currentIndex] || [], [currentIndex, shuffledAnswers]);
    const answersRef = useRef(answers);
    useEffect(() => { answersRef.current = answers; }, [answers]);

    const handleSubmit = useCallback(async () => {
        setIsPopconfirmVisible(false);
        const duration = Math.floor((Date.now() - startRef.current) / 1000);
        let score = 0;
        test.questions.forEach((question, idx) => {
            const user = answersRef.current[idx] || [];
            const correct = question.answer.filter((answer) => answer.correct).map((answer) => answer.content).sort();
            if (JSON.stringify(correct) === JSON.stringify([...user].sort())) score++;
        });
        const attempt = { id: String(Date.now()), time: Date.now(), duration, selectedAnswers: answersRef.current, score };
        test.attempts.push(attempt);
        await db.tests.put(test);
        onFinish();
    }, [onFinish, test]);

    // ... (All other hooks and functions up to the key listeners remain the same)
    useEffect(() => {
        if (timeLimit) {
            const endTime = startRef.current + timeLimit * 1000;
            timerRef.current = setInterval(() => {
                const now = Date.now();
                const diff = Math.max(0, Math.floor((endTime - now) / 1000));
                setRemaining(diff);
                if (diff <= 0) {
                    clearInterval(timerRef.current!);
                    handleSubmit();
                }
            }, 1000);
        } else {
            timerRef.current = setInterval(() => {
                const now = Date.now();
                const elapsed = Math.floor((now - startRef.current) / 1000);
                setRemaining(elapsed);
            }, 1000);
        }
        return () => clearInterval(timerRef.current!);
    }, [timeLimit, handleSubmit]);

    useEffect(() => {
        if (!shuffledAnswers[currentIndex]) {
            const shuffled = [...q.answer].sort(() => Math.random() - 0.5);
            setShuffledAnswers((prev) => ({ ...prev, [currentIndex]: shuffled }));
        }
    }, [currentIndex, q.answer, shuffledAnswers]);

    useEffect(() => {
        if (!isSearching || !searchQuery) {
            setSearchResults([]);
            setCurrentResultIndex(-1);
            return;
        }
        const results: typeof searchResults = [];
        const queryLower = searchQuery.toLowerCase();
        if (!queryLower) return;
        test.questions.forEach((question, questionIndex) => {
            const statementLower = question.statement.toLowerCase();
            let startIndex = -1;
            while ((startIndex = statementLower.indexOf(queryLower, startIndex + 1)) !== -1) {
                results.push({ questionIndex, location: 'statement', match: { start: startIndex, end: startIndex + queryLower.length } });
            }
            question.answer.forEach((ans) => {
                const answerLower = ans.content.toLowerCase();
                let ansStartIndex = -1;
                while ((ansStartIndex = answerLower.indexOf(queryLower, ansStartIndex + 1)) !== -1) {
                    results.push({ questionIndex, location: 'answer', answerContent: ans.content, match: { start: ansStartIndex, end: ansStartIndex + queryLower.length } });
                }
            });
        });
        setSearchResults(results);
        setCurrentResultIndex(results.length > 0 ? 0 : -1);
    }, [searchQuery, isSearching, test.questions]);

    const navigateToResult = useCallback((index: number) => {
        if (index < 0 || index >= searchResults.length) return;
        setCurrentResultIndex(index);
        const result = searchResults[index];
        if (result.questionIndex !== currentIndex) {
            setCurrentIndex(result.questionIndex);
        }
    }, [searchResults, currentIndex]);

    const handleNextResult = useCallback(() => {
        if (searchResults.length === 0) return;
        const nextIndex = (currentResultIndex + 1) % searchResults.length;
        navigateToResult(nextIndex);
    }, [currentResultIndex, searchResults.length, navigateToResult]);

    const handlePrevResult = useCallback(() => {
        if (searchResults.length === 0) return;
        const prevIndex = (currentResultIndex - 1 + searchResults.length) % searchResults.length;
        navigateToResult(prevIndex);
    }, [currentResultIndex, searchResults.length, navigateToResult]);

    const toggleChoice = useCallback((choice: string) => {
        setAnswers((prev) => {
            const prevChoices = prev[currentIndex] || [];
            if (totalCorrect === 1) return { ...prev, [currentIndex]: [choice] };
            const exists = prevChoices.includes(choice);
            const updated = exists ? prevChoices.filter((c) => c !== choice) : [...prevChoices, choice];
            return { ...prev, [currentIndex]: updated };
        });
    }, [currentIndex, totalCorrect]);

    useEffect(() => {
        if (!isJumping) return;
        if (jumpTimerRef.current) { clearTimeout(jumpTimerRef.current); }
        jumpTimerRef.current = setTimeout(() => {
            if (jumpBuffer) {
                const jumpTo = parseInt(jumpBuffer, 10);
                if (!isNaN(jumpTo) && jumpTo >= 1 && jumpTo <= test.questions.length) {
                    setCurrentIndex(jumpTo - 1);
                }
            }
            setIsJumping(false);
            setJumpBuffer('');
        }, 300);
        return () => { if (jumpTimerRef.current) { clearTimeout(jumpTimerRef.current); }};
    }, [isJumping, jumpBuffer, test.questions.length]);


    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isPopconfirmVisible || isSearching) return;

            if (!isJumping && (e.key === 'ArrowUp' || e.key === ' ')) {
                e.preventDefault();
                setIsJumping(true);
                return;
            }
            if (isJumping) {
                e.preventDefault();
                if (/^[0-9]$/.test(e.key)) { setJumpBuffer(prev => prev + e.key); }
                else if (e.key === 'Escape') { setIsJumping(false); setJumpBuffer(''); }
                return;
            }
            const isInputFocused = (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA';
            if (e.shiftKey && e.key.toUpperCase() === 'S' && !isInputFocused) {
                e.preventDefault();
                setIsPopconfirmVisible(true);
                return;
            }
            if (isInputFocused) return;
            if (/^[0-9]$/.test(e.key)) {
                const idx = parseInt(e.key, 10) - 1;
                if (choices[idx]) { toggleChoice(choices[idx].content); }
                return;
            }
            if (e.key === '`') {
                setReviewMarks((prev) => ({ ...prev, [currentIndex]: !prev[currentIndex] }));
                return;
            }
            if (e.key.toLowerCase() === 'h' || e.key === 'ArrowLeft') { setCurrentIndex((i) => Math.max(0, i - 1)); }
            if (e.key.toLowerCase() === 'l' || e.key === 'ArrowRight') { setCurrentIndex((i) => Math.min(test.questions.length - 1, i + 1)); }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isSearching, isJumping, choices, currentIndex, totalCorrect, isPopconfirmVisible, test.questions.length, toggleChoice]);

    // CHANGED: Keyboard handler for popconfirm is now more direct
    useEffect(() => {
        const handlePopconfirmKeys = (e: KeyboardEvent) => {
            if (!isPopconfirmVisible) return;

            if (e.key.toLowerCase() === 'y') {
                e.preventDefault();
                handleSubmit(); // Call submit directly
            } else if (e.key.toLowerCase() === 'n') {
                e.preventDefault();
                setIsPopconfirmVisible(false); // Just close the dialog
            }
        };

        window.addEventListener('keydown', handlePopconfirmKeys);
        return () => window.removeEventListener('keydown', handlePopconfirmKeys);
    }, [isPopconfirmVisible, handleSubmit]);


    useEffect(() => {
        const handleSearchKeys = (e: KeyboardEvent) => {
            if (((e.ctrlKey || e.metaKey) && e.key === 'f') || e.key === '/') {
                const isTyping = (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA';
                if (!isTyping) {
                    e.preventDefault();
                    setIsSearching(true);
                    setTimeout(() => searchInputRef.current?.focus(), 50);
                }
                return;
            }
            if (!isSearching) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                setIsSearching(false);
                setSearchQuery('');
            }
            const isInputFocused = document.activeElement === searchInputRef.current;
            if (isInputFocused && e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) handlePrevResult(); else handleNextResult();
                searchInputRef.current?.blur();
            }
            if (!isInputFocused) {
                 if (e.key.toLowerCase() === 'n') { e.preventDefault(); if (e.shiftKey) handlePrevResult(); else handleNextResult(); }
                 else if (e.key === 'ArrowDown') { e.preventDefault(); handleNextResult(); }
                 else if (e.key === 'ArrowUp') { e.preventDefault(); handlePrevResult(); }
            }
        };
        window.addEventListener('keydown', handleSearchKeys);
        return () => window.removeEventListener('keydown', handleSearchKeys);
    }, [isSearching, handlePrevResult, handleNextResult]);

    const formatTime = (sec: number) => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const getMatchesForText = (location: 'statement' | 'answer', content?: string) => {
        return searchResults.map((result, index) => ({ ...result, globalIndex: index })).filter(result => result.questionIndex === currentIndex && result.location === location && (location === 'statement' || result.answerContent === content)).map(result => ({ ...result.match, isCurrent: result.globalIndex === currentResultIndex }));
    };

    return (
        <Row className="quiz-layout">
            {isJumping && ( <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: 'rgba(0, 0, 0, 0.75)', color: 'white', padding: '12px 24px', borderRadius: '8px', fontSize: '24px', zIndex: 2000, pointerEvents: 'none' }}> Jumping to: {jumpBuffer} </div> )}
            <Col flex="3" className="quiz-main">
                <Row className="quiz-header" justify="space-between" align="middle">
                    <Title level={4} style={{ margin: 0 }}>{test.name}</Title>
                    <Paragraph style={{ fontSize: 16, margin: 0 }}> {timeLimit ? `Time Left: ${formatTime(remaining)}` : `Elapsed: ${formatTime(remaining)}`} </Paragraph>
                </Row>
                <Row className="quiz-body">
                    <Row className="quiz-actions" justify="space-between" align="middle">
                        <Button type={reviewMarks[currentIndex] ? 'primary' : 'default'} onClick={() => setReviewMarks((prev) => ({ ...prev, [currentIndex]: !prev[currentIndex] }))}> {reviewMarks[currentIndex] ? '✓ Marked' : 'Mark for Review'} </Button>
                        <Title level={3} style={{ margin: 0 }}>Question {currentIndex + 1}</Title>

                        <Popconfirm
                            title="Submit the test?"
                            description="Are you sure you want to submit?"
                            open={isPopconfirmVisible}
                            onConfirm={handleSubmit}
                            onCancel={() => setIsPopconfirmVisible(false)}
                            onOpenChange={(visible) => setIsPopconfirmVisible(visible)}
                            okText="Yes (Y)"
                            cancelText="No (N)"
                        >
                            <Button ref={submitButtonRef} type="primary" danger> Submit </Button>
                        </Popconfirm>
                    </Row>
                    <Paragraph style={{ fontSize: 18, width: '100%' }}>
                        {isSearching && searchQuery ? renderHighlightedText(q.statement, getMatchesForText('statement')) : renderWithCode(q.statement)}
                    </Paragraph>

                    <Paragraph type="secondary" style={{ fontStyle: 'italic', width: '100%' }}>
                        Choose {totalCorrect} answer{totalCorrect > 1 ? 's' : ''}
                    </Paragraph>
                    {totalCorrect === 1 ? (
                        <Radio.Group value={(answers[currentIndex] && answers[currentIndex][0]) || null} onChange={(e) => setAnswers((prev) => ({ ...prev, [currentIndex]: [e.target.value] }))}>
                            <Space direction="vertical" size="large">
                                {choices.map((a, idx) => (
                                    <Radio key={idx} value={a.content}>
                                        {idx + 1}.{' '}
                                        {isSearching && searchQuery ? renderHighlightedText(a.content, getMatchesForText('answer', a.content)) : renderWithCode(a.content)}
                                    </Radio>
                                ))}
                            </Space>
                        </Radio.Group>
                    ) : (
                        <Checkbox.Group value={answers[currentIndex] || []} onChange={(vals) => setAnswers((prev) => ({ ...prev, [currentIndex]: vals as string[] }))}>
                            <Space direction="vertical" size="large">
                                {choices.map((a, idx) => (
                                    <Checkbox key={idx} value={a.content}>
                                         {idx + 1}.{' '}
                                         {isSearching && searchQuery ? renderHighlightedText(a.content, getMatchesForText('answer', a.content)) : renderWithCode(a.content)}
                                    </Checkbox>
                                ))}
                            </Space>
                        </Checkbox.Group>
                    )}
                    <Row justify="space-between" style={{ marginTop: 64, width: '100%' }}>
                        <Button onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))} disabled={currentIndex === 0}>Previous</Button>
                        <Button onClick={() => setCurrentIndex((i) => Math.min(test.questions.length - 1, i + 1))} disabled={currentIndex === test.questions.length - 1}>Next</Button>
                    </Row>
                </Row>
            </Col>
            <Col flex="1" className="quiz-index">
                <Title level={5}>All Questions</Title>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 40px)', gap: 6 }}>
                    {test.questions.map((_, idx) => {
                        const answered = !!answers[idx]?.length;
                        const marked = reviewMarks[idx];
                        const isCurrent = idx === currentIndex;
                        const hasSearchResults = isSearching && searchQuery && searchResults.some(r => r.questionIndex === idx);
                        const bg = marked ? 'gold' : answered ? '#007aff' : 'var(--muted)';
                        const border = isCurrent ? '2px solid var(--strong-border)' : hasSearchResults ? '2px solid #ffd700' : 'none';
                        return (
                            <div key={idx} onClick={() => setCurrentIndex(idx)} style={{ width: 40, height: 40, background: bg, color: answered || marked ? '#fff' : '#000', textAlign: 'center', display: 'flex', justifyContent: 'center', alignItems: 'center', borderRadius: 8, fontWeight: 500, cursor: 'pointer', border: border, boxSizing: 'border-box' }}>
                                {idx + 1}
                            </div>
                        );
                    })}
                </div>
            </Col>
            {isSearching && ( <SearchBar query={searchQuery} setQuery={setSearchQuery} onPrev={handlePrevResult} onNext={handleNextResult} onClose={() => { setIsSearching(false); setSearchQuery(''); }} current={currentResultIndex} total={searchResults.length} inputRef={searchInputRef} /> )}
        </Row>
    );
};

export default TestTaking;
