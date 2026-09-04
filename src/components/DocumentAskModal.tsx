import type { StoredDocument } from '../db/db';
import { askDocument } from '../utils/askDocument';
import AskAIModal from './AskAIModal';

interface Props { document: StoredDocument; onClose: () => void; }

export default function DocumentAskModal({ document, onClose }: Props) {
  return <AskAIModal title={`Ask AI about ${document.name}`} onClose={onClose}
    scope={[{ id: document.id, label: document.name }]}
    emptyMessage="Ask for a summary, explanation, comparison, or a detail from this document."
    loadingMessage="Reading the document…"
    ask={(question, provider, model, history, signal) => askDocument(
      document,
      question,
      provider,
      model,
      history,
      signal,
    )} />;
}
