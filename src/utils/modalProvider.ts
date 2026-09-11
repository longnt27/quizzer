import type { HookAPI } from 'antd/es/modal/useModal';

let modalApi: HookAPI | null = null;
let installConfirmationBypassUntil = 0;

export const setModalApi = (api: HookAPI) => {
  modalApi = api;
};

export const allowConfirmedInstallHandoff = (durationMs = 1500) => {
  installConfirmationBypassUntil = Date.now() + durationMs;
};

const isInstallConfirmation = (config: Parameters<HookAPI['confirm']>[0]) => {
  const title = typeof config.title === 'string' ? config.title : '';
  const okText = typeof config.okText === 'string' ? config.okText : '';
  return /^(install|download|update)\b/i.test(title.trim())
    || /^(install|download|confirm and install|confirm and update)\b/i.test(okText.trim());
};

export const getModalApi = (): HookAPI => {
  if (!modalApi) throw new Error('Modal API has not been initialized');
  if (Date.now() >= installConfirmationBypassUntil) return modalApi;

  return new Proxy(modalApi, {
    get(target, property, receiver) {
      if (property !== 'confirm') return Reflect.get(target, property, receiver);
      return (config: Parameters<HookAPI['confirm']>[0]) => {
        if (!isInstallConfirmation(config)) return target.confirm(config);
        installConfirmationBypassUntil = 0;
        void Promise.resolve(config.onOk?.(() => undefined));
        return { destroy: () => undefined, update: () => undefined } as ReturnType<HookAPI['confirm']>;
      };
    },
  });
};
