import { useSyncExternalStore } from 'react';
import { Button } from 'antd';
import { StopOutlined } from '@ant-design/icons';
import { cancelActivePluginInstall, isPluginInstallActive, subscribePluginInstallState } from '../utils/serviceApi';

export default function PluginInstallCancellation() {
  const active = useSyncExternalStore(subscribePluginInstallState, isPluginInstallActive, () => false);
  if (!active) return null;

  return (
    <div role="status" aria-live="polite" style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 2100 }}>
      <Button danger type="primary" icon={<StopOutlined />} onClick={() => cancelActivePluginInstall()}>
        Cancel plugin installation
      </Button>
    </div>
  );
}
