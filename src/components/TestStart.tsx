import { Alert, Button, Typography, Checkbox, InputNumber, Popconfirm, Radio, Space, Tag } from 'antd';
import { FileTextOutlined, LinkOutlined } from '@ant-design/icons';
import type { StoredTest, StoredTestDraft } from '../db/db';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { countQuestionTypes } from '../utils/questions';

const { Title, Paragraph } = Typography;

interface Props {
    test: StoredTest;
    draft?: StoredTestDraft;
    onStart: (options: { timeLimit?: number; practice: boolean }) => void;
    onResume: () => void;
    onOpenDocument: (id: string) => void;
}

const TestStart: React.FC<Props> = ({ test, draft, onStart, onResume, onOpenDocument }) => {
    const [timed, setTimed] = useState(false);
    const [durationMinutes, setDurationMinutes] = useState(15); // default to 15 mins
    const [mode, setMode] = useState<'test' | 'practice'>('test');
    const counts = countQuestionTypes(test.questions);
    const documentIds = test.documentIds ?? [];
    const sourceDocuments = useLiveQuery(() => db.documents.bulkGet(documentIds), [test.id, documentIds.join('|')]);

    return <div className="test-start">
      <div className="test-start-main">
        <Title level={2} style={{ marginBottom: 8 }}>{test.name}</Title>
        <Paragraph type="secondary" style={{ fontSize: 16, marginBottom: 32 }}>
          This test contains <strong>{test.questions.length}</strong> questions
        </Paragraph>
        {draft && <Alert type="info" showIcon style={{ width: 'min(100%, 560px)', marginBottom: 24 }}
          message={`Paused ${draft.practice ? 'practice' : 'test'} available`}
          description={`Continue from question ${draft.currentIndex + 1}. Your answers, feedback, timer, and review marks are saved.`} />}
        <Space wrap style={{ justifyContent: 'center', marginBottom: 24 }}>
          {counts.multipleChoice > 0 && <Tag color="blue">{counts.multipleChoice} multiple choice</Tag>}
          {counts.fillBlank > 0 && <Tag color="purple">{counts.fillBlank} fill in the blank</Tag>}
          {counts.reasoning > 0 && <Tag color="gold">{counts.reasoning} reasoning</Tag>}
          {counts.coding > 0 && <Tag color="cyan">{counts.coding} coding</Tag>}
        </Space>
        <Radio.Group value={mode} onChange={event => setMode(event.target.value)} optionType="button" buttonStyle="solid" style={{ marginBottom: 20 }}
          options={[{ label: 'Test mode', value: 'test' }, { label: 'Practice mode', value: 'practice' }]} />
        <Paragraph type="secondary" style={{ maxWidth: 520, marginBottom: 20 }}>
          {mode === 'practice'
            ? 'Check each answer immediately, study its explanation, then continue.'
            : counts.reasoning || counts.coding
              ? 'Complete the questions without seeing answers. After submission, reasoning and coding responses are graded by the configured AI provider before review.'
              : 'Complete the questions first, then review your results after submitting the test.'}
        </Paragraph>
        <div className="test-timer-control">
          <Checkbox checked={timed} onChange={(event) => setTimed(event.target.checked)} style={{ fontSize: 14 }}>Timed test</Checkbox>
          {timed && <InputNumber min={1} max={240} value={durationMinutes} onChange={(value) => setDurationMinutes(value || 1)}
            addonAfter="minutes" style={{ width: 200 }} />}
        </div>
        {draft ? <Space wrap style={{ justifyContent: 'center' }}>
          <Button type="primary" size="large" onClick={onResume}>Resume {draft.practice ? 'Practice' : 'Test'}</Button>
          <Popconfirm title="Start over?" description="This removes the paused session and its saved answers." onConfirm={() => onStart({
            timeLimit: timed ? durationMinutes * 60 : undefined, practice: mode === 'practice',
          })}><Button size="large">Start Over</Button></Popconfirm>
        </Space> : <Button type="primary" size="large" className="test-start-button"
          onClick={() => onStart({ timeLimit: timed ? durationMinutes * 60 : undefined, practice: mode === 'practice' })}>
          {mode === 'practice' ? 'Start Practice' : 'Start Test'}
        </Button>}
      </div>
      <aside className="test-source-sidebar">
        <Typography.Title level={5} className="test-source-title"><FileTextOutlined /> Source documents</Typography.Title>
        {documentIds.length ? <div className="test-source-list">
          {documentIds.map((documentId, index) => {
            const document = sourceDocuments?.[index];
            return <div className="test-source-item" key={documentId}>
              <div>
                <Typography.Text strong>{document?.name ?? (sourceDocuments ? 'Deleted document' : 'Loading source…')}</Typography.Text>
                <div className="test-source-meta">
                  {document?.pageCount && <Tag>{document.pageCount} pages</Tag>}
                  {document?.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}
                  {!document && sourceDocuments && <Tag color="error">No longer in library</Tag>}
                </div>
              </div>
              {document && <Button type="link" icon={<LinkOutlined />} onClick={() => onOpenDocument(document.id)}>Open document</Button>}
            </div>;
          })}
        </div> : <Alert type="info" showIcon message="Source information is unavailable"
          description="This test was created before Quizzer recorded document origins, or it was imported without source metadata." />}
      </aside>
    </div>;
};

export default TestStart;
