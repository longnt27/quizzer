import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Space, Spin, Tabs, Tag, Typography } from 'antd';
import { DownloadOutlined, RobotOutlined } from '@ant-design/icons';
import { db, type StoredDocument } from '../db/db';
import { getMessageApi } from '../utils/messageProvider';
import DocumentAskModal from './DocumentAskModal';

interface Props { documentId: string; }

export default function DocumentView({ documentId }: Props) {
  const [document, setDocument] = useState<StoredDocument | null>();
  const [tagText, setTagText] = useState('');
  const [originalUrl, setOriginalUrl] = useState('');
  const [originalText, setOriginalText] = useState('');
  const [askOpen, setAskOpen] = useState(false);
  const message = getMessageApi();

  useEffect(() => {
    setDocument(undefined);
    void db.documents.get(documentId).then(item => {
      setDocument(item ?? null);
      setTagText(item?.tags.join(', ') ?? '');
    });
  }, [documentId]);

  useEffect(() => {
    const file = document?.originalFile;
    if (!file) { setOriginalUrl(''); setOriginalText(''); return; }
    const url = URL.createObjectURL(file);
    let active = true;
    setOriginalUrl(url);
    setOriginalText('');
    if (file.type.startsWith('text/') || /\.(?:md|markdown|txt)$/i.test(document.name)) {
      void file.text().then(text => { if (active) setOriginalText(text); });
    }
    return () => { active = false; URL.revokeObjectURL(url); };
  }, [document]);

  if (document === undefined) return <Spin style={{ margin: 40 }} />;
  if (document === null) return <Typography.Title level={4}>Document not found</Typography.Title>;

  const saveTags = async () => {
    const tags = [...new Set(tagText.split(',').map(tag => tag.trim()).filter(Boolean))];
    await db.documents.update(document.id, { tags });
    setDocument({ ...document, tags });
    message.success('Tags saved');
  };

  return (
    <div className="document-view">
      <Typography.Title level={2}>{document.name}</Typography.Title>
      <Space wrap style={{ marginBottom: 16 }}>
        <Tag>{document.mimeType || 'document'}</Tag>
        {document.pageCount && <Tag>{document.pageCount} pages</Tag>}
        {document.tags.map(tag => <Tag color="blue" key={tag}>{tag}</Tag>)}
        {!!document.images?.length && <Tag color="purple">{document.images.length} extracted images</Tag>}
      </Space>
      <Button type="primary" icon={<RobotOutlined />} onClick={() => setAskOpen(true)} style={{ marginBottom: 20 }}>
        Ask AI about this document
      </Button>
      <Card size="small" title="Tags" style={{ marginBottom: 20 }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={tagText} onChange={event => setTagText(event.target.value)} placeholder="lecture, networking, exam-1" />
          <Button type="primary" onClick={saveTags}>Save</Button>
        </Space.Compact>
      </Card>
      <Tabs defaultActiveKey="extracted" items={[
        { key: 'extracted', label: 'Extracted content', children: <Card>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' }}>{document.content}</Typography.Paragraph>
        </Card> },
        { key: 'original', label: 'Original file', children: <Card>
          {!document.originalFile ? <Alert type="info" showIcon message="The original file is unavailable" description="This document may have been added by an older Quizzer version that stored only extracted text." />
            : document.mimeType === 'application/pdf' ? <iframe className="document-original-frame" src={originalUrl} title={`Original ${document.name}`} />
              : document.mimeType.startsWith('image/') ? <img className="document-original-image" src={originalUrl} alt={document.name} />
                : originalText ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' }}>{originalText}</Typography.Paragraph>
                  : <Empty description="Preview is unavailable for this file type"><Button href={originalUrl} download={document.name} icon={<DownloadOutlined />}>Download original</Button></Empty>}
        </Card> },
      ]} />
      {askOpen && <DocumentAskModal document={document} onClose={() => setAskOpen(false)} />}
    </div>
  );
}
