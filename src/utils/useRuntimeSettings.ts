import { useEffect } from 'react';
import type { StoredAppProfile } from '../db/db';
import type { HardwareProfileId, InterfaceMode } from '../types';
import { updateAppProfile } from './appProfile';
import { setGenerationBatchSize, setGenerationConcurrency } from './generationSettings';
import { getProviderSettings, setProviderSettings } from './providerSettings';
import { resolveRendererProviderSettings } from './runtimeProviderSettings.ts';
import { serviceJson, serviceRequest } from './serviceApi';

type SettingValue = string | number | boolean;
interface ResolvedSettings {
  values: Record<string, SettingValue>;
  sources: Record<string, string>;
}

const authoritativeSource = (source: string) => ['user', 'environment', 'cli', 'job'].includes(source);

export const applyRendererSettings = (settings: ResolvedSettings) => {
  setGenerationConcurrency(Number(settings.values['generation.concurrency']));
  setGenerationBatchSize(Number(settings.values['generation.batchSize']));

  const current = getProviderSettings();
  const next = resolveRendererProviderSettings(current, settings.values);
  if (next !== current) setProviderSettings(next);
};

export const synchronizeRuntimeSettings = async (profile: Pick<StoredAppProfile, 'interfaceMode' | 'hardwareProfile'>) => {
  let settings = await serviceRequest<ResolvedSettings>(`/api/v1/settings?profile=${profile.hardwareProfile}`);
  const profileValues: Record<string, SettingValue> = {};
  const profileChanges: Partial<Pick<StoredAppProfile, 'interfaceMode' | 'hardwareProfile'>> = {};

  if (authoritativeSource(settings.sources['interface.mode'])) {
    const value = settings.values['interface.mode'] as InterfaceMode;
    if (value !== profile.interfaceMode) profileChanges.interfaceMode = value;
  } else if (settings.values['interface.mode'] !== profile.interfaceMode) {
    profileValues['interface.mode'] = profile.interfaceMode;
  }
  if (authoritativeSource(settings.sources['hardware.profile'])) {
    const value = settings.values['hardware.profile'] as HardwareProfileId;
    if (value !== profile.hardwareProfile) profileChanges.hardwareProfile = value;
  } else if (settings.values['hardware.profile'] !== profile.hardwareProfile || profile.hardwareProfile !== 'lite') {
    profileValues['hardware.profile'] = profile.hardwareProfile;
  }

  if (Object.keys(profileValues).length) {
    settings = await serviceJson<ResolvedSettings>('/api/v1/settings', 'PATCH', { values: profileValues });
  }
  if (Object.keys(profileChanges).length) await updateAppProfile(profileChanges);
  applyRendererSettings(settings);
};

export const useRuntimeSettings = (profile?: StoredAppProfile) => {
  const interfaceMode = profile?.interfaceMode;
  const hardwareProfile = profile?.hardwareProfile;
  useEffect(() => {
    if (!interfaceMode || !hardwareProfile) return;
    const currentProfile = { interfaceMode, hardwareProfile };
    let active = true;
    let retries = 0;
    let retryTimer: number | undefined;
    const refresh = () => {
      void synchronizeRuntimeSettings(currentProfile).catch(() => {
        if (active && retries < 4) {
          retries += 1;
          retryTimer = window.setTimeout(refresh, 1500 * retries);
        }
      });
    };
    const refreshFromEvent = () => { retries = 0; refresh(); };
    refresh();
    window.addEventListener('focus', refreshFromEvent);
    window.addEventListener('quizzer:settings-changed', refreshFromEvent);
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      window.removeEventListener('focus', refreshFromEvent);
      window.removeEventListener('quizzer:settings-changed', refreshFromEvent);
    };
  }, [hardwareProfile, interfaceMode]);
};
