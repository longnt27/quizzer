import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Space, Typography } from 'antd';
import { StopOutlined } from '@ant-design/icons';
import { createPortal } from 'react-dom';
import { cancelActivePluginInstall, isPluginInstallActive, subscribePluginInstallState } from '../utils/serviceApi';
import ImmediateSettingsPersistence from './ImmediateSettingsPersistence';

interface PendingInstall {
  button: HTMLButtonElement;
  name: string;
  detail: string;
  left: number;
  top: number;
}

const diskDetailFor = (button: HTMLButtonElement, name: string) => {
  const option = button.closest('.plugin-option');
  const text = option?.textContent ?? '';
  const diskMatch = text.match(/([\d,.]+)\s*MB\s*disk/i);
  if (diskMatch) return `Installing ${name} will use approximately ${diskMatch[1]} MB on this device.`;
  if (/bge-m3/i.test(text)) return `Installing ${name} will use approximately 1.2 GB on this device.`;
  if (/all-minilm/i.test(text)) return `Installing ${name} will use approximately 46 MB on this device.`;
  return `Installing ${name} will use additional disk space on this device. The exact size varies by platform and package version.`;
};

const installNameFor = (button: HTMLButtonElement) => {
  const option = button.closest('.plugin-option');
  const optionName = option?.querySelector<HTMLElement>('.plugin-option-copy strong')?.textContent?.trim();
  if (optionName) return optionName;
  const dialog = button.closest('[role="dialog"]');
  const title = dialog?.querySelector<HTMLElement>('.ant-modal-title')?.textContent?.replace(/settings$/i, '').trim();
  return title || 'this component';
};

const isInstallTrigger = (button: HTMLButtonElement) => {
  const label = button.textContent?.trim() ?? '';
  if (!/^(Install|Download model|Download [^?]+)$/i.test(label)) return false;
  if (button.dataset.installConfirmationBypass === 'true') return false;
  const dialog = button.closest('[role="dialog"]');
  const dialogText = dialog?.querySelector<HTMLElement>('.ant-modal-title')?.textContent ?? '';
  return /Plugins & models|settings/i.test(dialogText);
};

export default function PluginInstallCancellation() {
  const active = useSyncExternalStore(subscribePluginInstallState, isPluginInstallActive, () => false);
  const [pending, setPending] = useState<PendingInstall | null>(null);

  useEffect(() => {
    const intercept = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target.closest('button') : null;
      if (!(target instanceof HTMLButtonElement) || !isInstallTrigger(target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const bounds = target.getBoundingClientRect();
      const name = installNameFor(target);
      setPending({
        button: target,
        name,
        detail: diskDetailFor(target, name),
        left: Math.min(Math.max(12, bounds.right - 320), window.innerWidth - 332),
        top: Math.min(bounds.bottom + 8, window.innerHeight - 180),
      });
    };
    document.addEventListener('click', intercept, true);
    return () => document.removeEventListener('click', intercept, true);
  }, []);

  const confirm = () => {
    if (!pending) return;
    const { button } = pending;
    setPending(null);
    button.dataset.installConfirmationBypass = 'true';
    try { button.click(); }
    finally { delete button.dataset.installConfirmationBypass; }
  };

  return (
    <>
      <ImmediateSettingsPersistence />
      {pending ? createPortal(
        <div role="dialog" aria-label={`Confirm installation of ${pending.name}`} style={{
          position: 'fixed', left: pending.left, top: pending.top, width: 320, zIndex: 2200,
          padding: 12, borderRadius: 8, background: 'var(--panel-bg, Canvas)', boxShadow: '0 8px 30px rgb(0 0 0 / 22%)',
          border: '1px solid var(--strong-border, ButtonBorder)',
        }}>
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Typography.Text strong>Install {pending.name}?</Typography.Text>
            <Typography.Text type="secondary">{pending.detail} Are you sure?</Typography.Text>
            <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
              <Button size="small" onClick={() => setPending(null)}>Cancel</Button>
              <Button size="small" type="primary" onClick={confirm}>Install</Button>
            </Space>
          </Space>
        </div>, document.body,
      ) : null}
      {active ? (
        <div role="status" aria-live="polite" style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 2100 }}>
          <Button danger type="primary" icon={<StopOutlined />} onClick={() => cancelActivePluginInstall()}>
            Cancel plugin installation
          </Button>
        </div>
      ) : null}
    </>
  );
}
