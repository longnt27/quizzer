import { DatabaseOutlined } from '@ant-design/icons';
import { Space, Typography } from 'antd';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type StoredDocument } from '../db/db';
import type { QuestionProvenance } from '../types';

interface Props {
  provenance?: QuestionProvenance;
}

export default function QuestionCitations({ provenance }: Props) {
  const documentKey = provenance?.documentIds.join('\u0000') ?? '';
  const documents = useLiveQuery(async (): Promise<(StoredDocument | undefined)[]> =>
    provenance?.documentIds.length ? db.documents.bulkGet(provenance.documentIds) : [], [documentKey]) ?? [];
  if (!provenance?.sourceSpanIds.length) return null;
  const documentById = new Map(documents.flatMap(document => document ? [[document.id, document] as const] : []));
  const seen = new Set<string>();
  const sources = provenance.sourceSpanIds.flatMap(spanId => {
    const documentId = provenance.documentIds.find(id => spanId === id || spanId.startsWith(`${id}:`));
    const document = documentId ? documentById.get(documentId) : undefined;
    const localSpanId = documentId && spanId.startsWith(`${documentId}:`) ? spanId.slice(documentId.length + 1) : spanId;
    const chunk = document?.chunks?.find(item => item.id === spanId || item.id === localSpanId);
    const key = `${documentId ?? spanId}:${chunk?.page ?? 'document'}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, label: `${document?.name ?? 'Source document'}${chunk?.page ? ` · page ${chunk.page}` : ''}` }];
  });
  return <section data-onboarding-target="citations" className="question-citations" aria-label="Grounding sources">
    <Space><DatabaseOutlined /><Typography.Text strong>Grounding sources</Typography.Text></Space>
    <Typography.Paragraph type="secondary">
      These documents were used to generate this question.
    </Typography.Paragraph>
    <ul>
      {sources.map(source => <li key={source.key}><Typography.Text>{source.label}</Typography.Text></li>)}
    </ul>
  </section>;
}
