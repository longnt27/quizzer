import { useRef, useEffect, useState, type FC, type ReactNode, type ReactElement, useCallback } from 'react';
import { Button, Typography, Row, Col, Space, Tag } from 'antd';
import { StoredTest } from '../db/db';

const { Title, Paragraph } = Typography;

interface Props {
    test: StoredTest;
    onBack: () => void;
}

// NEW: Helper function to render text with highlighted matches (same as before)
const renderHighlightedText = (
    text: string,
    matches: { start: number; end: number; isCurrent: boolean }[]
): ReactNode => {
    if (!matches || matches.length === 0) {
        return <>{text}</>;
    }
    const sortedMatches = [...matches].sort((a, b) => a.start - b.start);
    let lastIndex = 0;
    const parts: (string | ReactElement)[] = [];
    sortedMatches.forEach((match, i) => {
        if (match.start > lastIndex) {
            parts.push(text.substring(lastIndex, match.start));
        }
        const style = {
            backgroundColor: match.isCurrent ? '#ffffa0' : '#ffd700',
            padding: '0',
            margin: '0',
            borderRadius: '3px',
        };
        parts.push(
            <mark key={`${i}-${match.start}`} style={style}>
                {text.substring(match.start, match.end)}
            </mark>
        );
        lastIndex = match.end;
    });
    if (lastIndex < text.length) {
        parts.push(text.substring(lastIndex));
    }
    return <>{parts}</>;
};

// NEW: Search bar component (same as before)
interface SearchBarProps {
    query: string;
    setQuery: (q: string) => void;
    onPrev: () => void;
    onNext: () => void;
    onClose: () => void;
    current: number;
    total: number;
    inputRef: React.RefObject<HTMLInputElement | null>;
}
const SearchBar: FC<SearchBarProps> = ({ query, setQuery, onPrev, onNext, onClose, current, total, inputRef }) => (
    <div style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        width: '100%',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        background: 'white',
        gap: '16px',
        zIndex: 1000,
        boxShadow: '0 -2px 10px rgba(0,0,0,0.2)'
    }}>
        <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all questions..."
            style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid #ddd', background: '#f0f2f5' }}
        />
        <span style={{ textAlign: 'center', fontSize: '14px', color: '#000' }}>
            {query && total > 0 ? `${current + 1} of ${total}` : query ? 'Not found' : ''}
        </span>
        <Button size="middle" onClick={onPrev} disabled={total === 0}>Previous (N)</Button>
        <Button size="middle" onClick={onNext} disabled={total === 0}>Next (n)</Button>
        <Button size="middle" onClick={onClose} type="text" style={{color: '#aaa', marginLeft: 'auto'}}>Close (Esc)</Button>
    </div>
);


const TestReview: React.FC<Props> = ({ test, onBack }) => {
    const latest = test.attempts[test.attempts.length - 1];
    const [currentIndex, setCurrentIndex] = useState(0);

    // NEW: State for search functionality
    const [isSearching, setIsSearching] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<{ questionIndex: number; location: 'statement' | 'answer'; answerContent?: string; match: { start: number; end: number } }[]>([]);
    const [currentResultIndex, setCurrentResultIndex] = useState(-1);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const q = test.questions[currentIndex];
    const userAnswer = latest.selectedAnswers[currentIndex] || [];
    const correctAnswers = q.answer.filter((a) => a.correct).map((a) => a.content).sort();

    const getAnswerTag = (a: typeof q.answer[number]) => {
        const picked = userAnswer.includes(a.content);
        const correct = a.correct;
        let color: string | undefined;
        let prefix = '';

        if (correct && picked) { color = 'green'; prefix = '✓'; }
        else if (correct && !picked) { color = 'blue'; prefix = '+'; }
        else if (!correct && picked) { color = 'red'; prefix = '✗'; }

        // NEW: Apply highlighting to the answer content
        const contentNode = isSearching && searchQuery
            ? renderHighlightedText(a.content, getMatchesForText('answer', a.content))
            : a.content;

        return (
            <Tag color={color} style={{ whiteSpace: 'normal', wordBreak: 'break-word', maxWidth: '100%', display: 'inline-block' }}>
                {prefix && <strong style={{ marginRight: 4 }}>{prefix}</strong>}
                {contentNode}
            </Tag>
        );
    };

    // CHANGED: Refactored jump-to-question logic to be consistent with TestTaking component
    const bufferRef = useRef('');
    const spacePressedRef = useRef(false);
    const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // NEW: Search logic effect
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
            // Search in statement
            const statementLower = question.statement.toLowerCase();
            let startIndex = -1;
            while ((startIndex = statementLower.indexOf(queryLower, startIndex + 1)) !== -1) {
                results.push({
                    questionIndex,
                    location: 'statement',
                    match: { start: startIndex, end: startIndex + queryLower.length },
                });
            }
            // Search in answers (not explanations)
            question.answer.forEach((ans) => {
                const answerLower = ans.content.toLowerCase();
                let ansStartIndex = -1;
                while ((ansStartIndex = answerLower.indexOf(queryLower, ansStartIndex + 1)) !== -1) {
                    results.push({
                        questionIndex,
                        location: 'answer',
                        answerContent: ans.content,
                        match: { start: ansStartIndex, end: ansStartIndex + queryLower.length },
                    });
                }
            });
        });
        setSearchResults(results);
        setCurrentResultIndex(results.length > 0 ? 0 : -1);
    }, [searchQuery, isSearching, test.questions]);

    // NEW: Search result navigation logic
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

    // CHANGED: Updated main keyboard handler
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (isSearching) return; // Ignore if in search mode

            const isInputFocused = (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA';
            const isDigit = /^\d$/.test(e.key);

            if (spacePressedRef.current) {
                if (isDigit) {
                    bufferRef.current += e.key;
                    if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);
                    bufferTimerRef.current = setTimeout(() => {
                        const target = parseInt(bufferRef.current, 10) - 1;
                        if (!isNaN(target) && target >= 0 && target < test.questions.length) {
                            setCurrentIndex(target);
                        }
                        bufferRef.current = '';
                        spacePressedRef.current = false;
                    }, 500);
                } else if (e.key === 'Escape') {
                    bufferRef.current = '';
                    spacePressedRef.current = false;
                    if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);
                }
                return;
            }

            if (!isInputFocused) {
                if (e.key.toLowerCase() === 'l' || e.key === 'ArrowRight') {
                    setCurrentIndex((i) => Math.min(test.questions.length - 1, i + 1));
                } else if (e.key.toLowerCase() === 'h' || e.key === 'ArrowLeft') {
                    setCurrentIndex((i) => Math.max(0, i - 1));
                } else if (e.key === 'ArrowUp' || e.key === ' ') {
                    e.preventDefault();
                    spacePressedRef.current = true;
                    bufferRef.current = '';
                }
            }
        };

        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [test.questions.length, isSearching]); // NEW: Added isSearching dependency

    // NEW: Keyboard handling for search mode
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
                 if (e.key.toLowerCase() === 'n') {
                    e.preventDefault();
                    if (e.shiftKey) handlePrevResult(); else handleNextResult();
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    handleNextResult();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    handlePrevResult();
                }
            }
        };

        window.addEventListener('keydown', handleSearchKeys);
        return () => window.removeEventListener('keydown', handleSearchKeys);
    }, [isSearching, handlePrevResult, handleNextResult]);

    // NEW: Helper to get matches for the current question
    const getMatchesForText = (location: 'statement' | 'answer', content?: string) => {
        return searchResults
            .map((result, index) => ({ ...result, globalIndex: index }))
            .filter(result =>
                result.questionIndex === currentIndex &&
                result.location === location &&
                (location === 'statement' || result.answerContent === content)
            )
            .map(result => ({ ...result.match, isCurrent: result.globalIndex === currentResultIndex }));
    };

    return (
        <Row style={{height: '100vh', background: '#fafafa' }}>
            <Col flex="3" style={{ padding: '64px 48px', background: '#fff', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <Row justify="space-between" align="middle" style={{ marginBottom: 24 }}>
                    <Title level={3} style={{ margin: 0 }}>
                        Question {currentIndex + 1}
                    </Title>
                    <Button onClick={onBack}>Back to Summary</Button>
                </Row>

                {/* NEW: Apply highlighting to the statement */}
                <Paragraph style={{ fontSize: 18 }}>
                    {isSearching && searchQuery ? renderHighlightedText(q.statement, getMatchesForText('statement')) : q.statement}
                </Paragraph>

                <Paragraph type="secondary" style={{ fontStyle: 'italic' }}>
                    Choose {correctAnswers.length} answer{correctAnswers.length > 1 ? 's' : ''}
                </Paragraph>

                <Space direction="vertical" size="middle" style={{ marginTop: 16 }}>
                    {q.answer.map((a, idx) => (
                        <div key={idx}>
                            {getAnswerTag(a)}
                            <div style={{ marginLeft: 8, fontStyle: 'italic', color: '#888' }}>
                                {a.explanation}
                            </div>
                        </div>
                    ))}
                </Space>

                <div style={{ marginTop: 'auto', paddingTop: 32 }}>
                    <Space>
                        <Button disabled={currentIndex === 0} onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}>
                            Previous
                        </Button>
                        <Button disabled={currentIndex === test.questions.length - 1} onClick={() => setCurrentIndex((i) => Math.min(test.questions.length - 1, i + 1))}>
                            Next
                        </Button>
                    </Space>
                </div>
            </Col>
            <Col flex="1" style={{ background: '#f5f5f7', padding: 32, borderLeft: '1px solid #ddd', overflowY: 'auto' }}>
                <Title level={5}>All Questions</Title>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 40px)', gap: 6 }}>
                    {test.questions.map((_, idx) => {
                        const user = latest.selectedAnswers[idx] || [];
                        const correct = test.questions[idx].answer.filter((a) => a.correct).map(a => a.content).sort();
                        const correctMatch = JSON.stringify(user.sort()) === JSON.stringify(correct);
                        // NEW: Add indicator for questions with search results
                        const hasSearchResults = isSearching && searchQuery && searchResults.some(r => r.questionIndex === idx);
                        const border = currentIndex === idx ? '2px solid #000' : hasSearchResults ? '2px solid #ffd700' : '2px solid transparent';

                        return (
                            <div
                                key={idx}
                                onClick={() => setCurrentIndex(idx)}
                                style={{
                                    width: 40,
                                    height: 40,
                                    background: correctMatch ? '#52c41a' : '#ff4d4f',
                                    color: '#fff',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    borderRadius: 6,
                                    fontWeight: 500,
                                    cursor: 'pointer',
                                    border: border,
                                    boxSizing: 'border-box',
                                }}
                            >
                                {idx + 1}
                            </div>
                        );
                    })}
                </div>
            </Col>

            {/* NEW: Render search bar when active */}
            {isSearching && (
                <SearchBar
                    query={searchQuery}
                    setQuery={setSearchQuery}
                    onPrev={handlePrevResult}
                    onNext={handleNextResult}
                    onClose={() => { setIsSearching(false); setSearchQuery(''); }}
                    current={currentResultIndex}
                    total={searchResults.length}
                    inputRef={searchInputRef}
                />
            )}
        </Row>
    );
};

export default TestReview;
