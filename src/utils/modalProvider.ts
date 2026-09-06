import type { HookAPI } from 'antd/es/modal/useModal';

let modalApi: HookAPI | null = null;

export const setModalApi = (api: HookAPI) => {
  modalApi = api;
};

export const getModalApi = (): HookAPI => {
  if (!modalApi) throw new Error('Modal API has not been initialized');
  return modalApi;
};
