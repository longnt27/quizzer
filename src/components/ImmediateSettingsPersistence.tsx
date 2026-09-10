import { useEffect, useRef } from 'react';
import type { GenerationProvider, HardwareProfileId, InterfaceMode } from '../types';
import { updateAppProfile } from '../utils/appProfile';
import { setGenerationBatchSize, setGenerationConcurrency } from '../utils/generationSettings';
import {
  PROVIDERS,
  forgetRememberedApiKey,
  getProviderSettings,
  rememberApiKey,
  setApiKey,
  setProviderSettings,
} from '../utils/providerSettings';
import { serviceJson, serviceRequest } from '../utils/serviceApi';

interface SettingDefinition {
  key: string;
  type: 'string' | 'integer' | 'boolean';
  enum?: string[];
}

interface CredentialSnapshot {
  key: string;
  remember?: boolean;
}

const targetId = (key: string) => `setting-${key.replace(/[^a-z0-9-]/gi, '-')}`;
const providerName = (label: string) => label.replace(' – ', ' ');
const capabilitySetting: Record<string, string> = {
  extractor: 'extraction.extractorPlugin',
  ocr: 'extraction.ocrPlugin',
  embedder: 'embeddings.embedderPlugin',
  'vector-index': 'retrieval.vectorIndexPlugin',
  reranker: 'retrieval.rerankerPlugin',
};

const readSettingControl = (row: Element, definition: SettingDefinition): string | number | boolean | undefined => {
  const switchControl = row.querySelector<HTMLElement>('[role="switch"]');
  if (switchControl) return switchControl.getAttribute('aria-checked') === 'true';

  const selectedRadio = row.querySelector<HTMLElement>('.ant-radio-button-wrapper-checked, [role="radio"][aria-checked="true"]');
  if (selectedRadio) {
    const text = selectedRadio.textContent?.trim() ?? '';
    return definition.enum?.find(value => value.toLowerCase() === text.toLowerCase()) ?? text.toLowerCase();
  }

  const selected = row.querySelector<HTMLElement>('.ant-select-selection-item');
  if (selected) {
    const text = selected.getAttribute('title') || selected.textContent?.trim() || '';
    if (definition.key === 'generation.defaultProvider') {
      return PROVIDERS.find(provider => providerName(provider.label).toLowerCase() === text.toLowerCase() || provider.label.toLowerCase() === text.toLowerCase())?.id;
    }
    return definition.enum?.find(value => value.toLowerCase() === text.toLowerCase()) ?? text;
  }

  const input = row.querySelector<HTMLInputElement>('input');
  if (!input) return undefined;
  if (definition.type === 'integer') {
    const number = Number(input.value);
    return Number.isFinite(number) ? number : undefined;
  }
  return input.value;
};

const equalRecord = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a) === JSON.stringify(b);

export default function ImmediateSettingsPersistence() {
  const definitions = useRef<SettingDefinition[]>([]);
  const settingsSnapshot = useRef<Record<string, unknown> | null>(null);
  const pluginSnapshot = useRef<Record<string, unknown> | null>(null);
  const writeQueue = useRef(Promise.resolve());

  useEffect(() => {
    let disposed = false;
    void serviceRequest<{ registry: SettingDefinition[] }>('/api/v1/settings/schema')
      .then(contract => { if (!disposed) definitions.current = contract.registry; })
      .catch(() => {});

    const enqueue = (work: () => Promise<unknown>) => {
      writeQueue.current = writeQueue.current.then(work, work).then(() => undefined, () => undefined);
    };

    const scanSettings = () => {
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
        .find(element => element.querySelector('.ant-modal-title')?.textContent?.trim() === 'Settings');
      if (!dialog || !definitions.current.length) {
        settingsSnapshot.current = null;
        return;
      }

      const next: Record<string, unknown> = {};
      for (const definition of definitions.current) {
        const row = dialog.querySelector(`#${CSS.escape(targetId(definition.key))}`);
        if (!row) continue;
        const value = readSettingControl(row, definition);
        if (value !== undefined) next[definition.key] = value;
      }

      const previous = settingsSnapshot.current;
      settingsSnapshot.current = next;
      if (!previous) return;

      const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => previous[key] !== value));
      if (!Object.keys(changed).length) return;

      enqueue(async () => {
        const resolved = await serviceJson<{ values: Record<string, unknown> }>('/api/v1/settings', 'PATCH', { values: changed });
        if ('interface.mode' in changed || 'hardware.profile' in changed) {
          await updateAppProfile({
            ...('interface.mode' in changed ? { interfaceMode: changed['interface.mode'] as InterfaceMode } : {}),
            ...('hardware.profile' in changed ? { hardwareProfile: changed['hardware.profile'] as HardwareProfileId } : {}),
          });
        }
        if ('generation.concurrency' in changed) setGenerationConcurrency(Number(changed['generation.concurrency']));
        if ('generation.batchSize' in changed) setGenerationBatchSize(Number(changed['generation.batchSize']));
        if ('generation.defaultProvider' in changed) {
          const current = getProviderSettings();
          setProviderSettings({ ...current, defaultProvider: changed['generation.defaultProvider'] as GenerationProvider });
        }
        if (resolved.values) window.dispatchEvent(new Event('quizzer:settings-changed'));
      });
    };

    const scanPlugins = () => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
      const main = dialogs.find(element => /Plugins & models/.test(element.querySelector('.ant-modal-title')?.textContent ?? ''));
      if (!main) {
        pluginSnapshot.current = null;
        return;
      }

      const stored = getProviderSettings();
      const nextModels = { ...stored.models };
      const nextEnabledProviders = { ...stored.enabledProviders };
      const nextEnabledTools = { ...stored.enabledTools };
      let nextDefault = stored.defaultProvider;
      const serviceValues: Record<string, unknown> = {};
      const credentials: Record<string, CredentialSnapshot> = {};
      let llamaEndpoint: string | undefined;
      let llamaModel: string | undefined;

      for (const row of main.querySelectorAll<HTMLElement>('.plugin-option')) {
        const title = row.querySelector<HTMLElement>('.plugin-option-copy strong')?.textContent?.trim() ?? '';
        const description = row.querySelector<HTMLElement>('.plugin-option-copy')?.textContent ?? '';
        const toggle = row.querySelector<HTMLElement>('[role="switch"]');
        const checked = toggle?.getAttribute('aria-checked') === 'true';
        const provider = PROVIDERS.find(candidate => providerName(candidate.label) === title);
        if (provider && toggle) nextEnabledProviders[provider.id] = checked;
        if (title === 'Marker visual extraction' && toggle) {
          nextEnabledTools.marker = checked;
          serviceValues['extraction.marker'] = checked;
        }
        if (title === 'RapidOCR' && toggle) {
          nextEnabledTools.ocr = checked;
          serviceValues['extraction.ocr'] = checked;
          if (checked) serviceValues['extraction.ocrPlugin'] = 'builtin';
        }
        if (/^Ollama embeddings/.test(title) && toggle) {
          nextEnabledTools.embeddings = checked;
          serviceValues['embeddings.enabled'] = checked;
          if (checked) serviceValues['embeddings.embedderPlugin'] = 'builtin';
        }

        const external = /External\s+(extractor|ocr|embedder|vector-index|reranker|generator)\s+plugin\s+·\s+([^\s]+)/i.exec(description);
        if (external && toggle && checked) {
          const capability = external[1].toLowerCase();
          const pluginId = external[2];
          if (capability === 'generator') {
            nextModels.plugin = pluginId;
            nextEnabledProviders.plugin = true;
          } else if (capabilitySetting[capability]) serviceValues[capabilitySetting[capability]] = pluginId;
        }

        const defaultButton = [...row.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Default');
        if (defaultButton) nextDefault = provider?.id ?? (external?.[1].toLowerCase() === 'generator' ? 'plugin' : nextDefault);
      }

      const modelDialog = dialogs.find(element => / settings$/.test(element.querySelector('.ant-modal-title')?.textContent?.trim() ?? ''));
      if (modelDialog) {
        for (const provider of PROVIDERS) {
          const display = providerName(provider.label);
          const modelInput = modelDialog.querySelector<HTMLInputElement>(`input[aria-label="${CSS.escape(`${display} default model`)}"]`);
          if (modelInput) nextModels[provider.id] = modelInput.value;
          if (provider.keyLabel) {
            const keyInput = modelDialog.querySelector<HTMLInputElement>(`input[aria-label="${CSS.escape(provider.keyLabel)}"]`);
            if (keyInput) credentials[provider.id] = { key: keyInput.value.trim() };
          }
          const concurrency = modelDialog.querySelector<HTMLInputElement>(`input[aria-label="${CSS.escape(`Maximum concurrency for ${display}`)}"]`);
          if (concurrency && Number.isFinite(Number(concurrency.value))) serviceValues[`providers.${provider.id}.maxConcurrency`] = Number(concurrency.value);
          const remember = modelDialog.querySelector<HTMLElement>(`[role="switch"][aria-label="${CSS.escape(`Remember ${display} with OS protection`)}"]`);
          if (remember && provider.kind === 'api') {
            const current = credentials[provider.id] ?? { key: '' };
            credentials[provider.id] = { ...current, remember: remember.getAttribute('aria-checked') === 'true' };
          }
        }
        const openaiEndpoint = modelDialog.querySelector<HTMLInputElement>('input[aria-label="OpenAI-compatible base endpoint"]')?.value;
        if (openaiEndpoint !== undefined) serviceValues['providers.openai-compatible.endpoint'] = openaiEndpoint.trim() || 'https://api.openai.com/v1';
        llamaEndpoint = modelDialog.querySelector<HTMLInputElement>('input[aria-label="llama.cpp local endpoint"]')?.value;
        llamaModel = modelDialog.querySelector<HTMLInputElement>('input[aria-label="llama.cpp model name"]')?.value;
        if (llamaEndpoint !== undefined) serviceValues['providers.llama-cpp.endpoint'] = llamaEndpoint.trim() || 'http://127.0.0.1:8080/v1';
        if (llamaModel !== undefined) serviceValues['providers.llama-cpp.model'] = llamaModel.trim() || 'local-model';
      }

      nextDefault = nextDefault || stored.defaultProvider;
      serviceValues['generation.defaultProvider'] = nextDefault;
      const nextProviderSettings = {
        defaultProvider: nextDefault,
        models: nextModels,
        enabledProviders: nextEnabledProviders,
        enabledTools: nextEnabledTools,
      };
      const next = { providerSettings: nextProviderSettings, serviceValues, credentials };
      const previous = pluginSnapshot.current;
      pluginSnapshot.current = next;
      if (!previous || equalRecord(previous, next)) return;

      const previousCredentials = (previous['credentials'] ?? {}) as Record<string, CredentialSnapshot>;
      for (const [providerId, credential] of Object.entries(credentials)) {
        const prior = previousCredentials[providerId];
        const keyChanged = prior?.key !== credential.key;
        const rememberChanged = prior?.remember !== credential.remember;
        if (keyChanged) setApiKey(providerId as GenerationProvider, credential.key);
        if (credential.remember !== undefined && (keyChanged || rememberChanged)) {
          if (credential.remember && credential.key) void rememberApiKey(providerId as GenerationProvider, credential.key).catch(() => {});
          else if (!credential.remember) void forgetRememberedApiKey(providerId as GenerationProvider).catch(() => {});
        }
      }

      const providerSettingsChanged = JSON.stringify(previous['providerSettings']) !== JSON.stringify(nextProviderSettings);
      const serviceValuesChanged = JSON.stringify(previous['serviceValues']) !== JSON.stringify(serviceValues);
      if (providerSettingsChanged) setProviderSettings(nextProviderSettings);
      if (serviceValuesChanged) {
        enqueue(async () => {
          await serviceJson('/api/v1/settings', 'PATCH', { values: serviceValues });
          if (llamaEndpoint !== undefined && llamaModel !== undefined) {
            await serviceJson('/api/v1/integrations/llama-cpp/configure', 'POST', {
              endpoint: serviceValues['providers.llama-cpp.endpoint'],
              model: serviceValues['providers.llama-cpp.model'],
              confirmed: true,
            });
          }
          window.dispatchEvent(new Event('quizzer:settings-changed'));
        });
      }
    };

    const hideSaveButtons = () => {
      for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"]')) {
        const title = dialog.querySelector('.ant-modal-title')?.textContent ?? '';
        if (!/^(Settings|Plugins & models)/.test(title.trim())) continue;
        for (const button of dialog.querySelectorAll<HTMLButtonElement>('.ant-modal-footer button')) {
          if (/^Save (changes|settings)$/i.test(button.textContent?.trim() ?? '')) button.style.display = 'none';
        }
      }
    };

    const scan = () => {
      hideSaveButtons();
      scanSettings();
      scanPlugins();
    };
    scan();
    const timer = window.setInterval(scan, 200);
    const flush = () => scan();
    document.addEventListener('click', flush, true);
    document.addEventListener('input', flush, true);
    document.addEventListener('change', flush, true);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('click', flush, true);
      document.removeEventListener('input', flush, true);
      document.removeEventListener('change', flush, true);
    };
  }, []);

  return null;
}
