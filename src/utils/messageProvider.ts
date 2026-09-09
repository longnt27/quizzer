import type { MessageInstance } from 'antd/es/message/interface';
import { formatErrorMessage } from './errorFormatting';

let messageApi: MessageInstance | null = null;

export const setMessageApi = (api: MessageInstance) => {
  messageApi = api;
};

export const getMessageApi = (): MessageInstance => {
  if (!messageApi) {
      throw new Error('Message API has not been initialized');
  }
  return {
    ...messageApi,
    error: (content, duration, onClose) => {
      if (typeof content === 'string' || content instanceof Error) {
        return messageApi!.error(formatErrorMessage(content), duration as any, onClose);
      }
      if (typeof content === 'object' && content !== null && 'content' in content) {
        return messageApi!.error({ ...content, content: formatErrorMessage(content.content) as any });
      }
      return messageApi!.error(content as any, duration as any, onClose);
    },
    warning: (content, duration, onClose) => {
      if (typeof content === 'string' || content instanceof Error) {
        return messageApi!.warning(formatErrorMessage(content), duration as any, onClose);
      }
      if (typeof content === 'object' && content !== null && 'content' in content) {
        return messageApi!.warning({ ...content, content: formatErrorMessage(content.content) as any });
      }
      return messageApi!.warning(content as any, duration as any, onClose);
    },
  } as MessageInstance;
};

