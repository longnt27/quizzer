import { Button, Typography, Checkbox, InputNumber, Radio, Space, Tag } from 'antd';
import type { StoredTest } from '../db/db';
import { useState } from 'react';
import { countQuestionTypes } from '../utils/questions';

const { Title, Paragraph } = Typography;

interface Props {
    test: StoredTest;
    onStart: (options: { timeLimit?: number; practice: boolean }) => void;
}

const TestStart: React.FC<Props> = ({ test, onStart }) => {
    const [timed, setTimed] = useState(false);
    const [durationMinutes, setDurationMinutes] = useState(15); // default to 15 mins
    const [mode, setMode] = useState<'test' | 'practice'>('test');
    const counts = countQuestionTypes(test.questions);

    return (
        <div className="test-start"
            style={{
                width: '100%',
                height: '100%',
                margin: '0 auto',
                padding: '64px 24px',
                background: 'var(--surface)',
                borderRadius: 16,
                boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
            }}
        >
            <Title level={2} style={{ marginBottom: 8 }}>
                {test.name}
            </Title>
            <Paragraph type="secondary" style={{ fontSize: 16, marginBottom: 32 }}>
                This test contains <strong>{test.questions.length}</strong> questions
            </Paragraph>
            <Space wrap style={{ justifyContent: 'center', marginBottom: 24 }}>
                {counts.multipleChoice > 0 && <Tag color="blue">{counts.multipleChoice} multiple choice</Tag>}
                {counts.fillBlank > 0 && <Tag color="purple">{counts.fillBlank} fill in the blank</Tag>}
                {counts.reasoning > 0 && <Tag color="gold">{counts.reasoning} reasoning</Tag>}
            </Space>

            <Radio.Group value={mode} onChange={event => setMode(event.target.value)} optionType="button" buttonStyle="solid" style={{ marginBottom: 20 }}
                options={[
                    { label: 'Test mode', value: 'test' },
                    { label: 'Practice mode', value: 'practice' },
                ]} />
            <Paragraph type="secondary" style={{ maxWidth: 520, marginBottom: 20 }}>
                {mode === 'practice'
                    ? 'Check each answer immediately, study its explanation, then continue.'
                    : counts.reasoning
                        ? 'Complete the questions without seeing answers. After submission, reasoning responses are graded by the configured AI provider before review.'
                        : 'Complete the questions first, then review your results after submitting the test.'}
            </Paragraph>

            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
                <Checkbox
                    checked={timed}
                    onChange={(e) => setTimed(e.target.checked)}
                    style={{ fontSize: 14 }}
                >
                    Timed test
                </Checkbox>
                {timed && (
                    <InputNumber
                        min={1}
                        max={240}
                        value={durationMinutes}
                        onChange={(val) => setDurationMinutes(val || 1)}
                        addonAfter="minutes"
                        style={{ width: '200px' }}
                    />
                )}
            </div>


            <Button
                type="primary"
                size="large"
                style={{
                    borderRadius: 24,
                    padding: '0 36px',
                    height: 48,
                    width: 150,
                    fontSize: 16,
                }}
                onClick={() =>
                    onStart({
                        timeLimit: timed ? durationMinutes * 60 : undefined,
                        practice: mode === 'practice',
                    })
                }
            >
                {mode === 'practice' ? 'Start Practice' : 'Start Test'}
            </Button>
        </div>
    );
};

export default TestStart;
