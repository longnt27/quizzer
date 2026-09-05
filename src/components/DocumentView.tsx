import { useEffect, useState } from 'react';
import { Alert, Button, Card, Empty, Input, List, Space, Spin, Tabs, Tag, Typography } from 'antd';
import { DatabaseOutlined, DownloadOutlined, ReloadOutlined, RobotOutlined, SearchOutlined } from '@ant-design/icons';
import { db, type StoredDocument } from '../db/db';
import { getMessageApi } from '../utils/messageProvider';
import DocumentAskModal from './DocumentAskModal';
import { serviceJson, serviceRequest } from '../utils/serviceApi';
import { syncNow } from '../db/serverSync';

interface Props { documentId: string; }

interface IndexStatus {
  documents: Array<{ id: string; versionHash: string; chunks: number; indexedAt: number }>;
}

interface RetrievalResult {
  sourceSpanId: string;
  documentId: string;
  documentName: string;
  page?: number;
  breadcrumb?: string;
  excerpt: string;
  score: number;
  neighbors: Array<{ sourceSpanId: string }>;
}

interface RetrievalPreview {
  confidence: 'low' | 'medium' | 'high';
  correctivePass: boolean;
  estimatedContextTokens: number;
  results: RetrievalResult[];
  refusal?: string;
}

export default function DocumentView({ documentId }: Props) {
  const [document, setDocument] = useState<StoredDocument | null>();
  const [tagText, setTagText] = useState('');
  const [originalUrl, setOriginalUrl] = useState('');
  const [originalText, setOriginalText] = useState('');
  const [askOpen, setAskOpen] = useState(false);
  const [indexStatus, setIndexStatus] = useState<IndexStatus>();
  const [indexing, setIndexing] = useState(false);
  const [retrievalQuery, setRetrievalQuery] = useState('');
  const [retrieving, setRetrieving] = useState(false);
  const [retrieval, setRetrieval] = useState<RetrievalPreview>();
  const [retrievalError, setRetrievalError] = useState('');
  const message = getMessageApi();

  useEffect(() => {
    setDocument(undefined);
    void db.documents.get(documentId).then(item => {
      setDocument(item ?? null);
      setTagText(item?.tags.join(', ') ?? '');
    });
  }, [documentId]);

  useEffect(() => {
    void serviceRequest<IndexStatus>('/api/v1/index/status').then(setIndexStatus).catch(() => setIndexStatus(undefined));
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

  const indexDocument = async () => {
    setIndexing(true);
    try {
      await syncNow();
      const response = await serviceJson<{ status: IndexStatus }>('/api/v1/index', 'POST', { documentIds: [document.id], force: true });
      setIndexStatus(response.status);
      message.success('Document indexed for retrieval');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Could not index document');
    } finally {
      setIndexing(false);
    }
  };

  const previewRetrieval = async () => {
    if (!retrievalQuery.trim()) return;
    setRetrieving(true);
    try {
      await syncNow();
      const result = await serviceJson<RetrievalPreview>('/api/v1/retrieval/preview', 'POST', {
        query: retrievalQuery,
        documentIds: [document.id],
        limit: 8,
        includeNeighbors: true,
      });
      setRetrieval(result);
      setRetrievalError('');
      setIndexStatus(await serviceRequest<IndexStatus>('/api/v1/index/status'));
    } catch (error) {
      setRetrievalError(error instanceof Error ? error.message : 'Could not retrieve evidence');
    } finally {
      setRetrieving(false);
    }
  };

  const indexed = indexStatus?.documents.find(item => item.id === document.id);

  return (
    <div className="document-view">
      <Typography.Title level={2}>{document.name}</Typography.Title>
      <Space wrap style={{ marginBottom: 16 }}>
        <Tag>{document.mimeType || 'document'}</Tag>
        {document.pageCount && <Tag>{document.pageCount} pages</Tag>}
        {document.tags.map(tag => <Tag color="blue" key={tag}>{tag}</Tag>)}
        {!!document.images?.length && <Tag color="purple">{document.images.length} extracted images</Tag>}
        {indexed ? <Tag color="green">Indexed · {indexed.chunks} spans</Tag> : <Tag>Not indexed</Tag>}
      </Space>
      <Space wrap style={{ marginBottom: 20 }}>
        <Button type="primary" icon={<RobotOutlined />} onClick={() => setAskOpen(true)}>Ask AI about this document</Button>
        <Button icon={indexed ? <ReloadOutlined /> : <DatabaseOutlined />} loading={indexing} onClick={() => void indexDocument()}>{indexed ? 'Reindex document' : 'Index for retrieval'}</Button>
      </Space>
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
        ...(document.images?.length ? [{ key: 'images', label: `Images (${document.images.length})`, children: <div className="document-image-grid">
          {document.images.map((image, index) => <Card key={image.id ?? `${image.name}-${index}`} size="small"
            cover={<img className="document-extracted-image" src={`data:${image.mimeType};base64,${image.data}`} alt={image.caption || image.name} />}>
            <Typography.Text strong>{image.name}</Typography.Text>
            <Space wrap style={{ marginTop: 8, marginBottom: 8 }}>
              {image.page && <Tag>Page {image.page}</Tag>}
              {image.ocrText && <Tag color="cyan">OCR text</Tag>}
            </Space>
            {image.caption && <Typography.Paragraph><Typography.Text type="secondary">Caption: </Typography.Text>{image.caption}</Typography.Paragraph>}
            {image.ocrText && <Typography.Paragraph className="document-image-ocr"><Typography.Text type="secondary">Text in image: </Typography.Text>{image.ocrText}</Typography.Paragraph>}
            {!image.caption && !image.ocrText && <Typography.Text type="secondary">No caption or OCR text is available.</Typography.Text>}
          </Card>)}
        </div> }] : []),
        { key: 'retrieval', label: 'Retrieval preview', children: <Card>
          <Typography.Title level={4}>Find grounded evidence</Typography.Title>
          <Typography.Paragraph type="secondary">Preview the exact indexed passages, stable citation IDs, page metadata, and context budget Quizzer can use for generation.</Typography.Paragraph>
          <Input.Search enterButton={<><SearchOutlined /> Retrieve</>} size="large" value={retrievalQuery} loading={retrieving}
            onChange={event => setRetrievalQuery(event.target.value)} onSearch={() => void previewRetrieval()}
            aria-label="Retrieval query" placeholder="For example: How does remote state locking work?" />
          {retrievalError && <Alert style={{ marginTop: 14 }} type="error" showIcon message={retrievalError} />}
          {retrieval && <Space direction="vertical" size="middle" style={{ width: '100%', marginTop: 16 }}>
            <Alert type={retrieval.confidence === 'low' ? 'warning' : 'info'} showIcon
              message={`${retrieval.confidence[0].toUpperCase() + retrieval.confidence.slice(1)} retrieval confidence`}
              description={`${retrieval.results.length} passage${retrieval.results.length === 1 ? '' : 's'} · approximately ${retrieval.estimatedContextTokens.toLocaleString()} context tokens${retrieval.correctivePass ? ' · one corrective retrieval pass used' : ''}`} />
            {retrieval.refusal && <Alert type="warning" showIcon message={retrieval.refusal} />}
            <List dataSource={retrieval.results} locale={{ emptyText: <Empty description="No indexed evidence found" /> }} renderItem={(result, position) => <List.Item>
              <Card size="small" className="retrieval-result" title={<Space wrap><Tag color="blue">#{position + 1}</Tag><Typography.Text>{result.breadcrumb || result.documentName}</Typography.Text></Space>}
                extra={<Space>{result.page && <Tag>Page {result.page}</Tag>}<Tag>{result.score.toFixed(4)}</Tag></Space>}>
                <Typography.Paragraph>{result.excerpt}</Typography.Paragraph>
                <Typography.Text code copyable>{result.sourceSpanId}</Typography.Text>
                {!!result.neighbors.length && <Typography.Text type="secondary"> · {result.neighbors.length} neighboring span{result.neighbors.length === 1 ? '' : 's'} available</Typography.Text>}
              </Card>
            </List.Item>} />
          </Space>}
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
