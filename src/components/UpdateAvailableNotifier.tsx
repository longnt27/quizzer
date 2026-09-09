import { useEffect } from 'react';
import { App as AntdApp, Button, Space } from 'antd';
import type { QuizzerDesktopUpdaterApi, UpdaterStatus } from '../types/updater';

const UPDATE_CHECK_SESSION_KEY = 'quizzer.startupUpdateCheck.v2';
const UPDATE_NOTIFICATION_KEY = 'quizzer-update-available';

let startupUpdateCheck: Promise<UpdaterStatus | null> | undefined;

const checkOncePerSession = (updater: QuizzerDesktopUpdaterApi) => {
  if (startupUpdateCheck) return startupUpdateCheck;
  try {
    if (sessionStorage.getItem(UPDATE_CHECK_SESSION_KEY)) return Promise.resolve(null);
    sessionStorage.setItem(UPDATE_CHECK_SESSION_KEY, 'started');
  } catch { /* The in-memory promise still prevents duplicate checks in restricted storage contexts. */ }

  startupUpdateCheck = (async () => {
    const current = await updater.getStatus();
    if (current.state === 'downloaded') return current;
    const checked = current.state === 'available' ? current : await updater.checkForUpdates();
    if (checked.state === 'available' && checked.autoDownload) {
      return updater.downloadUpdate();
    }
    return checked;
  })().catch(() => null);
  return startupUpdateCheck;
};

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
        description: 'The signed update was downloaded and verified. Quizzer will restart after installation.',
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

    void checkOncePerSession(updater).then(status => {
      if (!active || !status || isTestActive) return;
      if (status.state === 'downloaded') {
        showReadyToInstall(status);
        return;
      }
      if (status.state !== 'available' || !status.updateInfo) return;

      notification.info({
        key: UPDATE_NOTIFICATION_KEY,
        role: 'status',
        duration: 0,
        placement: 'bottomLeft',
        message: `Quizzer ${status.updateInfo.version} is available`,
        description: 'Automatic downloads are off. Download the signed update when you are ready.',
        actions: <Space>
          <Button size="small" onClick={onOpenSettings}>Settings</Button>
          <Button type="primary" size="small" onClick={() => {
            notification.destroy(UPDATE_NOTIFICATION_KEY);
            const download = updater.downloadUpdate();
            startupUpdateCheck = download.catch(() => null);
            void download.then(downloaded => {
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
    });

    return () => { active = false; };
  }, [isTestActive, notification, onOpenSettings]);

  return null;
}
