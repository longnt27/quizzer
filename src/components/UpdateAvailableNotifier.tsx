import { useEffect } from 'react';
import { App as AntdApp, Button, Space, Typography } from 'antd';
import type { QuizzerDesktopUpdaterApi, UpdaterStatus } from '../types/updater';

const UPDATE_NOTIFICATION_KEY = 'quizzer-update-available';
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

let updateCheck: Promise<UpdaterStatus | null> | undefined;
let lastUpdateCheckAt = 0;

const performUpdateCheck = async (updater: QuizzerDesktopUpdaterApi): Promise<UpdaterStatus> => {
  const current = await updater.getStatus();
  if (current.state === 'downloaded' || current.state === 'downloading' || current.state === 'applying' || current.state === 'installer-handoff-pending') {
    return current;
  }
  if (current.state === 'available') {
    return current.autoDownload ? updater.downloadUpdate() : current;
  }

  const now = Date.now();
  if (lastUpdateCheckAt && now - lastUpdateCheckAt < UPDATE_CHECK_INTERVAL_MS) return current;
  lastUpdateCheckAt = now;
  const checked = await updater.checkForUpdates();
  if (checked.state === 'available' && checked.autoDownload) return updater.downloadUpdate();
  return checked;
};

const checkForUpdates = (updater: QuizzerDesktopUpdaterApi) => {
  if (updateCheck) return updateCheck;
  updateCheck = performUpdateCheck(updater)
    .catch(() => null)
    .finally(() => { updateCheck = undefined; });
  return updateCheck;
};

const UpdateDescription = ({ status, lead }: { status: UpdaterStatus; lead: string }) => (
  <Space direction="vertical" size={4} style={{ maxWidth: 420 }}>
    <Typography.Text type="secondary">{lead}</Typography.Text>
    {status.updateInfo?.releaseNotes && <details className="update-release-notes">
      <summary>What's new in this update</summary>
      <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>
        {status.updateInfo.releaseNotes}
      </Typography.Paragraph>
    </details>}
  </Space>
);

interface Props {
  isTestActive: boolean;
  onOpenSettings: () => void;
}

export default function UpdateAvailableNotifier({ isTestActive, onOpenSettings }: Props) {
  const { notification } = AntdApp.useApp();

  useEffect(() => {
    if (isTestActive) {
      notification.destroy(UPDATE_NOTIFICATION_KEY);
      return;
    }
    const updater = window.quizzerDesktop?.updater;
    if (!updater) return;
    let active = true;

    const showReadyToInstall = (status: UpdaterStatus) => {
      if (!status.updateInfo) return;
      notification.success({
        key: UPDATE_NOTIFICATION_KEY,
        role: 'status',
        duration: 0,
        placement: 'bottomLeft',
        message: `Quizzer ${status.updateInfo.version} is ready to install`,
        description: <UpdateDescription status={status} lead="The signed update was downloaded and verified. Quizzer will restart after installation." />,
        actions: <Space>
          <Button size="small" onClick={onOpenSettings}>Settings</Button>
          <Button type="primary" size="small" onClick={() => {
            notification.destroy(UPDATE_NOTIFICATION_KEY);
            void updater.applyUpdate({ restart: true }).catch(error => {
              if (!active) return;
              notification.error({
                key: UPDATE_NOTIFICATION_KEY,
                message: 'Quizzer could not install the update',
                description: error instanceof Error ? error.message : String(error),
                duration: 0,
                placement: 'bottomLeft',
              });
            });
          }}>Install and restart</Button>
        </Space>,
      });
    };

    const showAvailable = (status: UpdaterStatus) => {
      if (!status.updateInfo) return;
      notification.info({
        key: UPDATE_NOTIFICATION_KEY,
        role: 'status',
        duration: 0,
        placement: 'bottomLeft',
        message: `Quizzer ${status.updateInfo.version} is available`,
        description: <UpdateDescription status={status} lead="Automatic downloads are off. Download the signed update when you are ready." />,
        actions: <Space>
          <Button size="small" onClick={onOpenSettings}>Settings</Button>
          <Button type="primary" size="small" onClick={() => {
            notification.destroy(UPDATE_NOTIFICATION_KEY);
            void updater.downloadUpdate().then(downloaded => {
              if (active && !isTestActive) showReadyToInstall(downloaded);
            }).catch(error => {
              if (!active) return;
              notification.error({
                key: UPDATE_NOTIFICATION_KEY,
                message: 'Quizzer could not download the update',
                description: error instanceof Error ? error.message : String(error),
                duration: 0,
                placement: 'bottomLeft',
              });
            });
          }}>Download update</Button>
        </Space>,
      });
    };

    const surfaceStatus = (status: UpdaterStatus | null) => {
      if (!active || isTestActive || !status) return;
      if (status.state === 'downloaded') showReadyToInstall(status);
      else if (status.state === 'available') showAvailable(status);
    };

    const refresh = () => { void checkForUpdates(updater).then(surfaceStatus); };
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') refresh(); };

    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const interval = window.setInterval(refresh, UPDATE_CHECK_INTERVAL_MS);

    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [isTestActive, notification, onOpenSettings]);

  return null;
}
