import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Descriptions, Divider, Progress, Radio, Space, Switch, Tag, Typography } from 'antd';
import { formatErrorMessage } from '../utils/errorFormatting';
import { ErrorDisplay } from './ErrorDisplay';
import {
  CheckCircleOutlined,
  CloudDownloadOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { UpdateChannel, UpdaterStatus } from '../types/updater';
import { getMessageApi } from '../utils/messageProvider';
import { getModalApi } from '../utils/modalProvider';

const formatBytes = (bytes?: number) => {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};

export default function UpdaterStatusView() {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const message = getMessageApi();

  const isDesktop = typeof window !== 'undefined' && Boolean(window.quizzerDesktop?.updater);

  const refreshStatus = useCallback(async () => {
    if (!window.quizzerDesktop?.updater) return;
    try {
      const current = await window.quizzerDesktop.updater.getStatus();
      setStatus(current);
    } catch (err) {
      console.error('Could not read updater status:', err);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleCheck = async (channelOverride?: UpdateChannel) => {
    if (!window.quizzerDesktop?.updater) return;
    setLoading(true);
    try {
      let next = await window.quizzerDesktop.updater.checkForUpdates({
        channel: channelOverride || status?.channel,
      });
      setStatus(next);
      if (next.state === 'available') {
        if (next.autoDownload) {
          setDownloading(true);
          next = await window.quizzerDesktop.updater.downloadUpdate();
          setStatus(next);
          message.success(`Update ${next.updateInfo?.version} downloaded and verified`);
        } else {
          message.info(`Update ${next.updateInfo?.version} is available`);
        }
      } else if (next.state === 'up-to-date') {
        message.success('Quizzer is up to date');
      } else if (next.state === 'error') {
        message.error(formatErrorMessage(next.error, 'updater'));
      }
    } catch (err) {
      message.error(formatErrorMessage(err, 'updater'));
    } finally {
      setLoading(false);
      setDownloading(false);
    }
  };

  const handleChannelChange = async (nextChannel: UpdateChannel) => {
    if (!status || status.channel === nextChannel) return;
    await handleCheck(nextChannel);
  };

  const handleDownload = async () => {
    if (!window.quizzerDesktop?.updater) return;
    setDownloading(true);
    try {
      const next = await window.quizzerDesktop.updater.downloadUpdate();
      setStatus(next);
      message.success('Update downloaded and verified');
    } catch (err) {
      message.error(formatErrorMessage(err, 'updater'));
      await refreshStatus();
    } finally {
      setDownloading(false);
    }
  };

  const handleAutoDownloadChange = async (enabled: boolean) => {
    if (!window.quizzerDesktop?.updater) return;
    try {
      let next = await window.quizzerDesktop.updater.setAutoDownload(enabled);
      setStatus(next);
      if (enabled && next.state === 'available') {
        setDownloading(true);
        next = await window.quizzerDesktop.updater.downloadUpdate();
        setStatus(next);
        message.success('Automatic downloads enabled; update downloaded and verified');
      }
    } catch (err) {
      message.error(formatErrorMessage(err, 'updater'));
      await refreshStatus();
    } finally {
      setDownloading(false);
    }
  };

  const handleApply = async () => {
    if (!window.quizzerDesktop?.updater) return;
    setApplying(true);
    try {
      const result = await window.quizzerDesktop.updater.applyUpdate({ restart: true });
      setStatus(result.status);
      message.success(result.message || 'Verified staged package — installer handoff pending');
    } catch (err) {
      message.error(formatErrorMessage(err, 'updater'));
      await refreshStatus();
    } finally {
      setApplying(false);
    }
  };

  const handleDiscard = () => {
    getModalApi().confirm({
      title: 'Discard staged update?',
      icon: <ExclamationCircleOutlined />,
      content: 'This will remove the downloaded update package and staging metadata from private storage.',
      okText: 'Discard staged update',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!window.quizzerDesktop?.updater) return;
        setDiscarding(true);
        try {
          const result = await window.quizzerDesktop.updater.discardUpdate();
          setStatus(result.status);
          message.info('Staged update discarded');
        } catch (err) {
          message.error(formatErrorMessage(err, 'updater'));
          await refreshStatus();
        } finally {
          setDiscarding(false);
        }
      },
    });
  };

  const handleRollback = () => {
    getModalApi().confirm({
      title: 'Hand off signed rollback candidate?',
      icon: <RollbackOutlined />,
      content: 'Quizzer will open the previously retained signed installer. The running application is not replaced in place.',
      okText: 'Hand off rollback',
      onOk: async () => {
        if (!window.quizzerDesktop?.updater) return;
        setRollingBack(true);
        try {
          const result = await window.quizzerDesktop.updater.rollbackUpdate();
          setStatus(result.status);
          message.info(result.message);
        } catch (err) {
          message.error(formatErrorMessage(err, 'updater'));
          await refreshStatus();
        } finally {
          setRollingBack(false);
        }
      },
    });
  };

  if (!isDesktop) {
    return (
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Typography.Text strong>
            <SafetyCertificateOutlined /> Desktop Updates
          </Typography.Text>
          <Typography.Text type="secondary">
            Running in web browser mode. Automatic signed updates and rollbacks are supported in Quizzer Desktop.
          </Typography.Text>
        </Space>
      </Card>
    );
  }

  const state = status?.state || 'idle';

  return (
    <Card size="small" className="updater-status-card" style={{ marginBottom: 16 }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Space>
            <SafetyCertificateOutlined style={{ fontSize: 18, color: '#1677ff' }} />
            <div>
              <Typography.Text strong>Software Updates</Typography.Text>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Current version: <Tag>{status?.currentVersion || 'unknown'}</Tag>
                  Target: <Tag>{status?.target.platform} / {status?.target.architecture}</Tag>
                </Typography.Text>
              </div>
            </div>
          </Space>

          <Space>
            <Radio.Group
              size="small"
              value={status?.channel || 'stable'}
              onChange={e => void handleChannelChange(e.target.value as UpdateChannel)}
              disabled={loading || downloading || applying || discarding || rollingBack}
            >
              <Radio.Button value="stable">Stable</Radio.Button>
              <Radio.Button value="beta">Beta</Radio.Button>
            </Radio.Group>

            <Button
              size="small"
              icon={loading ? <LoadingOutlined /> : <SyncOutlined />}
              onClick={() => void handleCheck()}
              loading={loading}
              disabled={downloading || applying || rollingBack}
            >
              Check for updates
            </Button>
          </Space>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <div>
            <Typography.Text>Download updates automatically</Typography.Text>
            <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>Quizzer still waits for you to install and restart.</Typography.Text></div>
          </div>
          <Switch
            aria-label="Download updates automatically"
            checked={status?.autoDownload ?? true}
            onChange={enabled => void handleAutoDownloadChange(enabled)}
            disabled={!status || loading || downloading || applying || discarding || rollingBack}
          />
        </div>

        {/* State Alerts & Actions */}
        {state === 'available' && status?.updateInfo && (
          <Alert
            type="info"
            showIcon
            icon={<CloudDownloadOutlined />}
            message={`New update available: Quizzer ${status.updateInfo.version}`}
            description={
              <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 8 }}>
                <Typography.Text type="secondary">
                  Artifact: <code>{status.updateInfo.artifact.name}</code> ({formatBytes(status.updateInfo.artifact.size)})
                  <br />
                  Signature verified: Ed25519 (Key ID: {status.updateInfo.publicKeyId})
                </Typography.Text>
                {status.updateInfo.releaseNotes && <details className="update-release-notes">
                  <summary>What's new in this update</summary>
                  <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>
                    {status.updateInfo.releaseNotes}
                  </Typography.Paragraph>
                </details>}
                <Button
                  type="primary"
                  size="small"
                  icon={<CloudDownloadOutlined />}
                  onClick={() => void handleDownload()}
                  loading={downloading}
                >
                  Download and verify update
                </Button>
              </Space>
            }
          />
        )}

        {state === 'downloading' && (
          <div>
            <Typography.Text strong>Downloading update...</Typography.Text>
            <Progress aria-label="Update download progress" percent={status?.downloadProgress?.percent || 0} status="active" />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatBytes(status?.downloadProgress?.bytesDownloaded)} of {formatBytes(status?.downloadProgress?.totalBytes)}
            </Typography.Text>
          </div>
        )}

        {state === 'downloaded' && (
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            message="Update downloaded and verified"
            description={
              <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 8 }}>
                <Typography.Text type="secondary">
                  SHA-256 and Ed25519 signature verified in private staging. Install now to replace Quizzer and restart automatically.
                </Typography.Text>
                <Space>
                  <Button
                    type="primary"
                    size="small"
                    icon={<CheckCircleOutlined />}
                    onClick={() => void handleApply()}
                    loading={applying}
                  >
                    Install and restart
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={handleDiscard}
                    loading={discarding}
                  >
                    Discard staged update
                  </Button>
                </Space>
              </Space>
            }
          />
        )}

        {state === 'installer-handoff-pending' && (
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            message="Update installation started"
            description={
              <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 8 }}>
                <Typography.Text type="secondary">
                  Quizzer is closing to install the verified update and restart. On platforms that use a system installer, follow its prompts.
                </Typography.Text>
                <Button
                  size="small"
                  danger
                  onClick={handleDiscard}
                  loading={discarding}
                >
                  Discard staged update
                </Button>
              </Space>
            }
          />
        )}

        {state === 'manual-handoff' && (
          <Alert
            type="info"
            showIcon
            icon={<CheckCircleOutlined />}
            message="Verified staged package — manual opening required"
            description={
              <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 8 }}>
                <Typography.Text type="secondary">
                  The update package has been downloaded and cryptographically verified. The package format requires manual installation. Please locate the package in your updates directory and run it.
                </Typography.Text>
                <Button
                  size="small"
                  danger
                  onClick={handleDiscard}
                  loading={discarding}
                >
                  Discard staged update
                </Button>
              </Space>
            }
          />
        )}

        {state === 'up-to-date' && (
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            message={`Quizzer is up to date on the ${status?.channel} channel.`}
          />
        )}

        {state === 'error' && <Space direction="vertical" style={{ width: '100%' }}>
          <ErrorDisplay error={status?.error || 'Update check failed'} context="updater" />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void handleCheck()}>Retry update</Button>
        </Space>}

        {state === 'unsupported' && <ErrorDisplay
          error={status?.error || `No compatible update is available for ${status?.target.platform}/${status?.target.architecture}.`}
          context="updater" type="warning"
        />}

        {status?.rollbackInfo && (
          <Alert
            type={status.rollbackInfo.available ? 'warning' : 'info'}
            showIcon
            icon={<RollbackOutlined />}
            message={status.rollbackInfo.available
              ? `Signed rollback candidate: Quizzer ${status.rollbackInfo.version}`
              : 'Rollback unavailable'}
            description={status.rollbackInfo.available
              ? `Signed ${status.rollbackInfo.artifactName} metadata is valid; full integrity is reverified immediately before handoff.`
              : status.rollbackInfo.message || 'No previously verified signed installer is retained for this installation.'}
            action={status.rollbackInfo.available ? (
              <Button size="small" onClick={handleRollback} loading={rollingBack} disabled={applying || downloading || discarding}>
                Hand off rollback
              </Button>
            ) : undefined}
          />
        )}

        {/* Environment & Verification Diagnostics */}
        <Divider style={{ margin: '8px 0' }} />
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="Release verification">
            {status?.keyStatus.configured ? (
              <Tag color="green">Ed25519 verified ({status.keyStatus.id})</Tag>
            ) : (
              <Tag color="orange">No production key configured</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Safety guarantee">
            All updates are cryptographically verified with Ed25519 signatures and SHA-256 digests in private staging. The macOS adapter also validates the application bundle identity and version before replacement.
          </Descriptions.Item>
          <Descriptions.Item label="Runtime mode">
            {status?.mechanism === 'manual-handoff'
              ? 'Packaged desktop application (verified staging; manual installation required)'
              : status?.mechanism === 'staged-ready'
                ? 'Packaged desktop application (verified staging; install and restart enabled)'
                : 'Development mode (verified staging; binary replacement simulated)'}
          </Descriptions.Item>
        </Descriptions>
      </Space>
    </Card>
  );
}
