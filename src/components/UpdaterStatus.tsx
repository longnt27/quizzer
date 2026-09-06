import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Descriptions, Divider, Modal, Progress, Radio, Space, Tag, Typography } from 'antd';
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
      const next = await window.quizzerDesktop.updater.checkForUpdates({
        channel: channelOverride || status?.channel,
      });
      setStatus(next);
      if (next.state === 'available') {
        message.info(`Update ${next.updateInfo?.version} is available`);
      } else if (next.state === 'up-to-date') {
        message.success('Quizzer is up to date');
      } else if (next.state === 'error') {
        message.error(next.error || 'Failed to check for updates');
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Update check failed');
    } finally {
      setLoading(false);
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
      message.error(err instanceof Error ? err.message : 'Download failed');
      await refreshStatus();
    } finally {
      setDownloading(false);
    }
  };

  const handleApply = async () => {
    if (!window.quizzerDesktop?.updater) return;
    setApplying(true);
    try {
      const result = await window.quizzerDesktop.updater.applyUpdate();
      setStatus(result.status);
      message.success(result.message || 'Update applied');
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Apply failed');
      await refreshStatus();
    } finally {
      setApplying(false);
    }
  };

  const handleRollback = () => {
    Modal.confirm({
      title: 'Roll back to prior version?',
      icon: <RollbackOutlined />,
      content: `This will restore version ${status?.rollbackInfo?.version || 'previous'} and replace the currently staged version.`,
      okText: 'Roll back',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!window.quizzerDesktop?.updater) return;
        setRollingBack(true);
        try {
          const result = await window.quizzerDesktop.updater.rollbackUpdate();
          setStatus(result.status);
          message.success(`Rolled back to version ${result.restoredVersion}`);
        } catch (err) {
          message.error(err instanceof Error ? err.message : 'Rollback failed');
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
              disabled={loading || downloading || applying || rollingBack}
            >
              <Radio.Button value="stable">Stable</Radio.Button>
              <Radio.Button value="beta">Beta</Radio.Button>
            </Radio.Group>

            <Button
              size="small"
              icon={loading ? <LoadingOutlined /> : <SyncOutlined />}
              onClick={() => void handleCheck()}
              loading={loading}
              disabled={downloading || applying}
            >
              Check for updates
            </Button>
          </Space>
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
            <Progress percent={status?.downloadProgress?.percent || 0} status="active" />
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
            message="Update verified and ready to apply"
            description={
              <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 8 }}>
                <Typography.Text type="secondary">
                  SHA-256 and Ed25519 signature verified in scoped staging.
                </Typography.Text>
                <Button
                  type="primary"
                  size="small"
                  icon={<CheckCircleOutlined />}
                  onClick={() => void handleApply()}
                  loading={applying}
                >
                  Apply update
                </Button>
              </Space>
            }
          />
        )}

        {state === 'applied' && (
          <Alert
            type="success"
            showIcon
            message="Update applied"
            description="The update has been safely staged. A recoverable prior version has been preserved in rollback metadata."
          />
        )}

        {state === 'rolled-back' && (
          <Alert
            type="warning"
            showIcon
            message="Rolled back to prior version"
            description={`Restored prior version ${status?.rollbackInfo?.version || ''}.`}
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

        {state === 'error' && (
          <Alert
            type="error"
            showIcon
            icon={<ExclamationCircleOutlined />}
            message="Update check or download failed"
            description={status?.error}
            action={
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void handleCheck()}>
                Retry
              </Button>
            }
          />
        )}

        {state === 'unsupported' && (
          <Alert
            type="warning"
            showIcon
            message="No supported update artifact"
            description={status?.error || `No compatible update is available for ${status?.target.platform}/${status?.target.architecture}.`}
          />
        )}

        {/* Rollback Section */}
        {status?.rollbackInfo?.available && (
          <div>
            <Divider style={{ margin: '8px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <Typography.Text strong>
                  <RollbackOutlined /> Rollback to Prior Version
                </Typography.Text>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Recoverable backup version: <Tag>{status.rollbackInfo.version}</Tag>
                    {status.rollbackInfo.timestamp && ` (replaced ${new Date(status.rollbackInfo.timestamp).toLocaleDateString()})`}
                  </Typography.Text>
                </div>
              </div>
              <Button
                danger
                size="small"
                icon={<RollbackOutlined />}
                onClick={handleRollback}
                loading={rollingBack}
              >
                Roll back
              </Button>
            </div>
          </div>
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
            All updates are verified with Ed25519 signatures and SHA-256 digests in scoped staging before installation.
          </Descriptions.Item>
          <Descriptions.Item label="Runtime mode">
            {status?.mechanism === 'staged-development'
              ? 'Development mode (staged files verified; binary replacement simulated)'
              : 'Packaged desktop application'}
          </Descriptions.Item>
        </Descriptions>
      </Space>
    </Card>
  );
}
