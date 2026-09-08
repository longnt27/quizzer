import { useEffect } from 'react';
import { App as AntdApp, Button } from 'antd';
import type { QuizzerDesktopUpdaterApi, UpdaterStatus } from '../types/updater';

const UPDATE_CHECK_SESSION_KEY = 'quizzer.startupUpdateCheck.v1';
const UPDATE_NOTIFICATION_KEY = 'quizzer-update-available';

let startupUpdateCheck: Promise<UpdaterStatus | null> | undefined;

const checkOncePerSession = (updater: QuizzerDesktopUpdaterApi) => {
  if (startupUpdateCheck) return startupUpdateCheck;
  try {
    if (sessionStorage.getItem(UPDATE_CHECK_SESSION_KEY)) return Promise.resolve(null);
    sessionStorage.setItem(UPDATE_CHECK_SESSION_KEY, 'started');
  } catch { /* The in-memory promise still prevents duplicate checks in restricted storage contexts. */ }
  startupUpdateCheck = updater.checkForUpdates().catch(() => null);
  return startupUpdateCheck;
};

interface Props {
  onOpenSettings: () => void;
}

export default function UpdateAvailableNotifier({ onOpenSettings }: Props) {
  const { notification } = AntdApp.useApp();

  useEffect(() => {
    const updater = window.quizzerDesktop?.updater;
    if (!updater) return;
    let active = true;
    void checkOncePerSession(updater).then(status => {
      if (!active || status?.state !== 'available' || !status.updateInfo) return;
      notification.info({
        key: UPDATE_NOTIFICATION_KEY,
        role: 'status',
        duration: 0,
        placement: 'bottomLeft',
        message: `Quizzer ${status.updateInfo.version} is available`,
        description: 'Review the signed update in Settings when you are ready. Quizzer will not download or install it automatically.',
        actions: <Button type="primary" size="small" onClick={() => {
          notification.destroy(UPDATE_NOTIFICATION_KEY);
          onOpenSettings();
        }}>Review update</Button>,
      });
    });
    return () => { active = false; };
  }, [notification, onOpenSettings]);

  return null;
}
