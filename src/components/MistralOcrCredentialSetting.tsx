import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Space, Switch, Typography } from 'antd';
import { API_PROVIDERS, getApiKey } from '../utils/providerSettings';
import { serviceJson, serviceRequest } from '../utils/serviceApi';
import { formatErrorMessage } from '../utils/errorFormatting';
import { getMessageApi } from '../utils/messageProvider';

interface Props {
  active: boolean;
}

const sessionCredentialValues = (mistralKey: string) => ({
  ...Object.fromEntries(API_PROVIDERS.flatMap(provider => {
    const value = getApiKey(provider.id).trim();
    return value ? [[provider.id, value]] : [];
  })),
  ...(mistralKey.trim() ? { 'mistral-ocr': mistralKey.trim() } : {}),
});

export default function MistralOcrCredentialSetting({ active }: Props) {
  const [key, setKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [remember, setRemember] = useState(false);
  const [storage, setStorage] = useState({ available: false, message: 'OS-protected storage is available only in the desktop app.' });
  const [saving, setSaving] = useState(false);
  const message = getMessageApi();

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      serviceRequest<{ providers: string[] }>('/api/v1/provider-credentials').catch(() => ({ providers: [] as string[] })),
      window.quizzerDesktop
        ? Promise.all([window.quizzerDesktop.credentials.status(), window.quizzerDesktop.credentials.list()])
        : Promise.resolve(undefined),
    ]).then(([status, desktop]) => {
      if (!mounted) return;
      setConfigured(status.providers.includes('mistral-ocr'));
      if (desktop) {
        const [nextStorage, remembered] = desktop;
        setStorage({ available: nextStorage.available, message: nextStorage.message });
        const rememberedKey = remembered['mistral-ocr'] ?? '';
        if (rememberedKey) {
          setKey(rememberedKey);
          setRemember(true);
        }
      }
    });
    return () => { mounted = false; };
  }, []);

  const statusText = useMemo(() => configured ? 'Configured for this Quizzer session' : 'API key required', [configured]);

  if (!active) return null;

  const save = async () => {
    const trimmed = key.trim();
    if (!trimmed) {
      message.error('Enter a Mistral API key before enabling Mistral OCR.');
      return;
    }
    setSaving(true);
    try {
      if (window.quizzerDesktop) {
        if (remember) await window.quizzerDesktop.credentials.set('mistral-ocr', trimmed);
        else await window.quizzerDesktop.credentials.delete('mistral-ocr');
      }
      await serviceJson('/api/v1/provider-credentials', 'PUT', { values: sessionCredentialValues(trimmed) });
      setConfigured(true);
      message.success(remember ? 'Mistral OCR key saved with OS protection' : 'Mistral OCR key enabled for this session');
    } catch (error) {
      message.error(formatErrorMessage(error, 'provider'));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    try {
      if (window.quizzerDesktop) await window.quizzerDesktop.credentials.delete('mistral-ocr');
      await serviceJson('/api/v1/provider-credentials', 'PUT', { values: sessionCredentialValues('') });
      setKey('');
      setRemember(false);
      setConfigured(false);
      message.success('Mistral OCR key cleared');
    } catch (error) {
      message.error(formatErrorMessage(error, 'provider'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section" aria-label="Mistral OCR credentials">
      <Alert type="warning" showIcon message="Cloud extraction sends the selected document to Mistral"
        description="Use this only when you are comfortable processing the document through Mistral's API. Quizzer never selects this remote extractor automatically." />
      <div className="settings-list">
        <div className="settings-row">
          <div className="settings-copy">
            <Typography.Text strong>Mistral OCR API key</Typography.Text>
            <Typography.Text type="secondary">{statusText}. The key is kept out of config, backups, diagnostics, and extraction metadata.</Typography.Text>
            <Typography.Text type="secondary">{storage.message}</Typography.Text>
          </div>
          <div className="settings-control">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Input.Password aria-label="Mistral OCR API key" value={key} onChange={event => setKey(event.target.value)}
                placeholder={configured && !key ? 'Configured for this session' : 'Mistral API key'} autoComplete="off" />
              {window.quizzerDesktop ? <Space>
                <Switch aria-label="Remember Mistral OCR key with OS protection" checked={remember} disabled={!storage.available}
                  onChange={setRemember} />
                <Typography.Text>Remember with OS protection</Typography.Text>
              </Space> : null}
              <Space wrap>
                <Button type="primary" loading={saving} onClick={() => void save()}>Save key</Button>
                <Button disabled={!configured && !key} loading={saving} onClick={() => void clear()}>Clear key</Button>
              </Space>
            </Space>
          </div>
        </div>
      </div>
    </section>
  );
}
