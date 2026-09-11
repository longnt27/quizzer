import { useState, useSyncExternalStore } from 'react';
import { Alert, Button, Input, List, Modal, Space, Spin, Tag, Upload, Typography } from 'antd';
import { InboxOutlined, ReloadOutlined } from '@ant-design/icons';
import type { RcFile } from 'antd/es/upload';
import { v4 as uuidv4 } from 'uuid';
import { db, type StoredDocument } from '../db/db';
import { extractPdf } from '../utils/pdf';
import { getMessageApi } from '../utils/messageProvider';
import { chunkDocumentContent, STRUCTURAL_CHUNKER_VERSION } from '../utils/documentChunks';
import { getProviderSettings } from '../utils/providerSettings';
import { serviceFetch } from '../utils/serviceApi';
import { pendingDocumentImports, type PendingDocumentImport } from '../utils/pendingDocumentImports';
import { ErrorDisplay } from './ErrorDisplay';
import TagEditor from './TagEditor';

interface Props {
  onClose: () => void;
  onCreated: (id: string) => void | Promise<void>;
}

const hashBytes = async (value: BufferSource) => {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};
const hashText = (value: string) => hashBytes(new TextEncoder().encode(value));

export default function AddDocumentModal({ onClose, onCreated }: Props) {
  const toolSettings = getProviderSettings().enabledTools;
  const files = useSyncExternalStore(pendingDocumentImports.subscribe, pendingDocumentImports.getSnapshot, pendingDocumentImports.getSnapshot);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const message = getMessageApi();

  const update = (id: string, changes: Partial<PendingDocumentImport>) => pendingDocumentImports.update(id, changes);

  const applyBulkTags = (tags: string[]) => {
    const added = tags.filter(tag => !bulkTags.includes(tag));
    const removed = bulkTags.filter(tag => !tags.includes(tag));
    setBulkTags(tags);
    pendingDocumentImports.replaceTags(item => [
      ...item.tags.filter(tag => !removed.includes(tag)),
      ...added.filter(tag => !item.tags.includes(tag)),
    ]);
  };

  const extract = async (id: string, file: RcFile) => {
    update(id, { status: 'extracting', stage: 'Reading document…', error: undefined, extracted: undefined });
    try {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      let extracted: Pick<StoredDocument, 'content' | 'pageCount' | 'images' | 'parserVersion'> = isPdf
        ? { ...await extractPdf(file), parserVersion: 'pdfjs-5.3.31' }
        : { content: await file.text(), pageCount: undefined, parserVersion: 'utf8-1' };
      update(id, { stage: isPdf ? 'Running the configured document extractor…' : 'Checking the configured document extractor…' });
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const response = await serviceFetch('/api/extract', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, data: dataUrl.split(',')[1], ocrEnabled: toolSettings.ocr }),
        });
        if (response.ok) extracted = await response.json() as typeof extracted;
      } catch { /* The configured extractor is optional; retain the basic extraction. */ }
      if (!extracted.content.trim()) throw new Error('No readable text was found in this document.');
      update(id, {
        status: 'ready', stage: undefined,
        extracted: {
          ...extracted,
          parserVersion: extracted.parserVersion || (isPdf ? 'pdfjs-5.3.31' : 'utf8-1'),
          extractionSchemaVersion: 1,
          extractedAt: Date.now(),
          extractionContentHash: await hashText(extracted.content),
        },
      });
    } catch (error) {
      update(id, { status: 'error', stage: undefined, error: (error as Error).message });
    }
  };

  const addFile = (file: RcFile) => {
    const id = uuidv4();
    pendingDocumentImports.add({
      id,
      file,
      name: file.name.replace(/\.[^/.]+$/, ''),
      tags: [...bulkTags],
      status: 'extracting',
      stage: 'Queued…',
    });
    void extract(id, file);
    return false;
  };

  const save = async () => {
    const ready = files.filter(file => file.status === 'ready' && file.extracted);
    if (!ready.length) return;
    setSaving(true);
    try {
      for (const item of ready) {
        const contentHash = await hashBytes(await item.file.arrayBuffer());
        await db.documents.put({
          id: item.id,
          name: item.name.trim() || item.file.name,
          createdAt: Date.now(),
          mimeType: item.file.type || 'application/octet-stream',
          size: item.file.size,
          tags: item.tags,
          content: item.extracted!.content,
          contentHash,
          parserVersion: item.extracted!.parserVersion,
          extractionSchemaVersion: item.extracted!.extractionSchemaVersion,
          extractedAt: item.extracted!.extractedAt,
          extractionContentHash: item.extracted!.extractionContentHash,
          chunkingVersion: STRUCTURAL_CHUNKER_VERSION,
          pageCount: item.extracted!.pageCount,
          originalFile: item.file,
          images: item.extracted!.images,
          chunks: chunkDocumentContent(item.extracted!.content),
        });
      }
      pendingDocumentImports.removeMany(ready.map(item => item.id));
      message.success(`${ready.length} document(s) added`);
      await onCreated(ready[0].id);
    } finally {
      setSaving(false);
    }
  };

  const extractingCount = files.filter(file => file.status === 'extracting').length;

  return (
    <Modal open title="Add documents" width={680} onCancel={onClose} footer={(_, { CancelBtn }) => <>
      {!saving && <CancelBtn />}
      {saving ? <Space><Spin size="small" /> Saving documents…</Space>
        : extractingCount === 0 && files.some(file => file.status === 'ready')
          ? <Button type="primary" onClick={() => void save()}>Add to library</Button>
          : null}
    </>}>
      <Typography.Paragraph type="secondary">
        Quizzer automatically uses your configured extractor, then falls back to built-in text extraction when needed. You can change the extractor later and re-extract a saved document.
      </Typography.Paragraph>
      <Upload.Dragger data-onboarding-target="document" multiple showUploadList={false} beforeUpload={addFile} accept=".pdf,.txt,.md">
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">Drop PDF, text, or Markdown documents here</p>
      </Upload.Dragger>
      {files.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <TagEditor tags={bulkTags} subject="all uploading documents" onChange={applyBulkTags} />
          <Typography.Text type="secondary">Changes here are applied to every document currently in this upload, and to files added afterward.</Typography.Text>
        </div>
      ) : null}
      {extractingCount > 0 && <Alert style={{ marginTop: 16 }} type="info" showIcon icon={<Spin size="small" />}
        message={`Extracting ${extractingCount} document${extractingCount === 1 ? '' : 's'}`}
        description="Extraction continues if you close this modal. Reopen Add documents to review the completed files." />}
      <List style={{ marginTop: 16, maxHeight: 330, overflow: 'auto' }} dataSource={files}
        renderItem={item => (
          <List.Item actions={item.status === 'error' ? [
            <Button key="retry" size="small" icon={<ReloadOutlined />} onClick={() => void extract(item.id, item.file)}>Retry</Button>,
            <Button key="remove" danger size="small" onClick={() => pendingDocumentImports.remove(item.id)}>Remove</Button>,
          ] : [<Button key="remove" danger size="small" onClick={() => pendingDocumentImports.remove(item.id)}>Remove</Button>]}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space><Input value={item.name} onChange={event => update(item.id, { name: event.target.value })} />
                <Tag color={item.status === 'ready' ? 'success' : item.status === 'error' ? 'error' : 'processing'}>
                  {item.status === 'extracting' ? <Space size={5}><Spin size="small" /> Extracting</Space> : item.status}
                </Tag>
              </Space>
              <TagEditor tags={item.tags} subject={item.name || item.file.name} onChange={tags => update(item.id, { tags })} />
              {item.error && <ErrorDisplay error={item.error} context="document" />}
              {item.stage && <Typography.Text type="secondary">{item.stage}</Typography.Text>}
            </Space>
          </List.Item>
        )} />
    </Modal>
  );
}
