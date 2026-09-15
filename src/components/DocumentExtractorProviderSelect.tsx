import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Select, Space, Spin, Typography } from 'antd';
import { CloudDownloadOutlined } from '@ant-design/icons';
import { formatErrorMessage } from '../utils/errorFormatting';
import { getMessageApi } from '../utils/messageProvider';
import { serviceJson, serviceRequest } from '../utils/serviceApi';

interface ToolStatus {
  installed: boolean;
  managed: boolean;
  job?: { state: 'idle' | 'working' | 'complete' | 'error'; message: string };
}

interface IntegrationStatus {
  marker?: ToolStatus;
  docling?: ToolStatus;
}

interface Props {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}

const labels: Record<string, string> = {
  auto: 'Auto',
  basic: 'Basic',
  marker: 'Marker',
  docling: 'Docling (local)',
  'mistral-ocr': 'Mistral-ocr',
  plugin: 'Plugin',
};

const managedProvider = (value: string) => value === 'marker' || value === 'docling';

export default function DocumentExtractorProviderSelect({ value, options, onChange }: Props) {
  const [status, setStatus] = useState<IntegrationStatus>();
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const message = getMessageApi();

  const refresh = useCallback(async () => {
    try {
      setStatus(await serviceRequest<IntegrationStatus>('/api/integrations'));
    } catch (error) {
      message.error(formatErrorMessage(error, 'plugin'));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { void refresh(); }, [refresh]);

  const working = status?.marker?.job?.state === 'working' || status?.docling?.job?.state === 'working';
  useEffect(() => {
    if (!working) return undefined;
    const timer = window.setInterval(() => { void refresh(); }, 500);
    return () => window.clearInterval(timer);
  }, [refresh, working]);

  const selectOptions = useMemo(() => options.map(option => ({
    value: option,
    label: labels[option] ?? option,
    disabled: managedProvider(option) && (!status || !status[option as 'marker' | 'docling']?.installed),
  })), [options, status]);

  const install = async (provider: 'marker' | 'docling') => {
    setAction(provider);
    try {
      await serviceJson(`/api/integrations/${provider}/install`, 'POST', {});
      await refresh();
    } catch (error) {
      message.error(formatErrorMessage(error, 'plugin'));
    } finally {
      setAction('');
    }
  };

  const marker = status?.marker;
  const docling = status?.docling;
  const statusMessage = docling?.job?.message || marker?.job?.message;

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Select aria-label="Document extractor provider" value={value} disabled={loading}
        onChange={onChange} options={selectOptions} style={{ width: '100%' }} />
      <Typography.Text type="secondary">
        Docling runs locally after a one-time managed install. Installation downloads the pinned Docling package and model artifacts; documents stay on this device during extraction.
      </Typography.Text>
      <Space wrap>
        {!marker?.installed && marker?.job?.state !== 'working' ? (
          <Button size="small" icon={<CloudDownloadOutlined />} loading={action === 'marker'} disabled={loading}
            onClick={() => void install('marker')}>Install Marker</Button>
        ) : null}
        {!docling?.installed && docling?.job?.state !== 'working' ? (
          <Button size="small" icon={<CloudDownloadOutlined />} loading={action === 'docling'} disabled={loading}
            onClick={() => void install('docling')}>Install Docling</Button>
        ) : null}
        {working ? <Space size="small"><Spin size="small" /><Typography.Text type="secondary">{statusMessage || 'Installing extractor…'}</Typography.Text></Space> : null}
        {docling?.job?.state === 'complete' && docling.job.message ? <Typography.Text type="secondary">{docling.job.message}</Typography.Text> : null}
        {docling?.job?.state === 'error' && docling.job.message ? <Typography.Text type="danger">{docling.job.message}</Typography.Text> : null}
      </Space>
    </Space>
  );
}
