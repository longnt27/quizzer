import { useEffect, useState } from 'react';
import { Button, Card, Input, Space, Spin, Tag, Typography } from 'antd';
import { db, type StoredDocument } from '../db/db';
import { getMessageApi } from '../utils/messageProvider';

interface Props { documentId: string; }

export default function DocumentView({ documentId }: Props) {
  const [document, setDocument] = useState<StoredDocument | null>();
  const [tagText, setTagText] = useState('');
  const message = getMessageApi();

  useEffect(() => {
    setDocument(undefined);
    void db.documents.get(documentId).then(item => {
      setDocument(item ?? null);
      setTagText(item?.tags.join(', ') ?? '');
    });
  }, [documentId]);

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
      <Card size="small" title="Tags" style={{ marginBottom: 20 }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={tagText} onChange={event => setTagText(event.target.value)} placeholder="lecture, networking, exam-1" />
          <Button type="primary" onClick={saveTags}>Save</Button>
        </Space.Compact>
      </Card>
      <Card title="Extracted content">
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' }}>
          {document.content}
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
