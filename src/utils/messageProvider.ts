import type { MessageInstance } from 'antd/es/message/interface';

let messageApi: MessageInstance | null = null;

export const setMessageApi = (api: MessageInstance) => {
  messageApi = api;
};

export const getMessageApi = (): MessageInstance => {
  if (!messageApi) {
      throw new Error('Message API has not been initialized');
  }
  return messageApi;
};

