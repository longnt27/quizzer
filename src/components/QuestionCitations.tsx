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
  const names = new Map(documents.flatMap(document => document ? [[document.id, document.name] as const] : []));
  return <section className="question-citations" aria-label="Grounding sources">
    <Space><DatabaseOutlined /><Typography.Text strong>Grounding sources</Typography.Text></Space>
    <Typography.Paragraph type="secondary">
      These stable source spans were used to generate this question.
    </Typography.Paragraph>
    <ul>
      {provenance.sourceSpanIds.map(spanId => {
        const documentId = provenance.documentIds.find(id => spanId.startsWith(`${id}:`));
        return <li key={spanId}>
          <Typography.Text>{documentId ? names.get(documentId) ?? documentId : 'Source'}</Typography.Text>
          <Typography.Text code copyable={{ text: spanId }}>{spanId}</Typography.Text>
        </li>;
      })}
    </ul>
  </section>;
}
