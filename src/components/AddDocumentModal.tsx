import { useState } from 'react';
import { Alert, Button, Input, List, Modal, Select, Space, Spin, Tag, Upload, Typography } from 'antd';
import { InboxOutlined, ReloadOutlined } from '@ant-design/icons';
import type { RcFile } from 'antd/es/upload';
import { v4 as uuidv4 } from 'uuid';
import { db, type StoredDocument } from '../db/db';
import { extractPdf } from '../utils/pdf';
import { getMessageApi } from '../utils/messageProvider';

interface PendingDocument {
  id: string;
  file: RcFile;
  name: string;
  tags: string[];
  status: 'extracting' | 'ready' | 'error';
  stage?: string;
  error?: string;
  extracted?: Pick<StoredDocument, 'content' | 'pageCount' | 'images'>;
}

interface Props {
  onClose: () => void;
  onCreated: (id: string) => void;
}

const parseTags = (value: string) => value.split(',').map(tag => tag.trim()).filter(Boolean);

export default function AddDocumentModal({ onClose, onCreated }: Props) {
  const [files, setFiles] = useState<PendingDocument[]>([]);
  const [saving, setSaving] = useState(false);
  const [converter, setConverter] = useState<'automatic' | 'basic'>('automatic');
  const message = getMessageApi();

  const update = (id: string, changes: Partial<PendingDocument>) =>
    setFiles(current => current.map(item => item.id === id ? { ...item, ...changes } : item));

  const extract = async (id: string, file: RcFile, mode: 'automatic' | 'basic') => {
    update(id, { status: 'extracting', stage: 'Reading document…', error: undefined, extracted: undefined });
    try {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      let extracted: Pick<StoredDocument, 'content' | 'pageCount' | 'images'> = isPdf
        ? await extractPdf(file)
        : { content: await file.text(), pageCount: undefined };
      if (isPdf && mode === 'automatic') {
        update(id, { stage: 'Extracting layout and images with Marker…' });
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          const response = await fetch('/api/extract', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.name, data: dataUrl.split(',')[1] }),
          });
          if (response.ok) extracted = await response.json() as typeof extracted;
        } catch { /* Marker is optional; retain the basic extraction. */ }
      }
      if (!extracted.content.trim()) throw new Error('No readable text was found in this document.');
      update(id, { status: 'ready', stage: undefined, extracted });
    } catch (error) {
      update(id, { status: 'error', stage: undefined, error: (error as Error).message });
    }
  };

  const addFile = (file: RcFile) => {
    const id = uuidv4();
    const pending: PendingDocument = {
      id,
      file,
      name: file.name.replace(/\.[^/.]+$/, ''),
      tags: [],
      status: 'extracting',
      stage: 'Queued…',
    };
    setFiles(current => [...current, pending]);
    void extract(id, file, converter);
    return false;
  };

  const save = async () => {
    const ready = files.filter(file => file.status === 'ready' && file.extracted);
    if (!ready.length) return;
    setSaving(true);
    try {
      for (const item of ready) {
        await db.documents.put({
          id: item.id,
          name: item.name.trim() || item.file.name,
          createdAt: Date.now(),
          mimeType: item.file.type || 'application/octet-stream',
          size: item.file.size,
          tags: item.tags,
          content: item.extracted!.content,
          pageCount: item.extracted!.pageCount,
          originalFile: item.file,
          images: item.extracted!.images,
        });
      }
      message.success(`${ready.length} document(s) added`);
      onCreated(ready[0].id);
    } finally {
      setSaving(false);
    }
  };

  const extractingCount = files.filter(file => file.status === 'extracting').length;

  return (
    <Modal open title="Add documents" width={680} onCancel={onClose} onOk={save}
      confirmLoading={saving} okText={extractingCount ? 'Extracting…' : 'Add to library'}
      okButtonProps={{ disabled: extractingCount > 0 || !files.some(file => file.status === 'ready') }}>
      <Typography.Paragraph type="secondary">
        Documents are extracted now and saved to your local library. Creating a quiz is a separate step.
      </Typography.Paragraph>
      <Select value={converter} onChange={setConverter} style={{ width: 280, marginBottom: 12 }} options={[
        { value: 'automatic', label: 'Automatic (use Marker if installed)' },
        { value: 'basic', label: 'Basic PDF text extraction' },
      ]} />
      <Upload.Dragger multiple showUploadList={false} beforeUpload={addFile} accept=".pdf,.txt,.md">
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">Drop PDF, text, or Markdown documents here</p>
      </Upload.Dragger>
      {extractingCount > 0 && <Alert style={{ marginTop: 16 }} type="info" showIcon icon={<Spin size="small" />}
        message={`Extracting ${extractingCount} document${extractingCount === 1 ? '' : 's'}`}
        description="You can keep editing names and tags while extraction finishes." />}
      <List style={{ marginTop: 16, maxHeight: 330, overflow: 'auto' }} dataSource={files}
        renderItem={item => (
          <List.Item actions={item.status === 'error' ? [
            <Button key="retry" size="small" icon={<ReloadOutlined />} onClick={() => void extract(item.id, item.file, converter)}>Retry</Button>,
            <Button key="remove" danger size="small" onClick={() => setFiles(all => all.filter(file => file.id !== item.id))}>Remove</Button>,
          ] : [<Button key="remove" danger size="small" onClick={() => setFiles(all => all.filter(file => file.id !== item.id))}>Remove</Button>]}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space><Input value={item.name} onChange={event => update(item.id, { name: event.target.value })} />
                <Tag color={item.status === 'ready' ? 'success' : item.status === 'error' ? 'error' : 'processing'}>
                  {item.status === 'extracting' ? <Space size={5}><Spin size="small" /> Extracting</Space> : item.status}
                </Tag>
              </Space>
              <Input placeholder="Tags, separated by commas" value={item.tags.join(', ')}
                onChange={event => update(item.id, { tags: parseTags(event.target.value) })} />
              {item.error && <Typography.Text type="danger">{item.error}</Typography.Text>}
              {item.stage && <Typography.Text type="secondary">{item.stage}</Typography.Text>}
            </Space>
          </List.Item>
        )} />
    </Modal>
  );
}
