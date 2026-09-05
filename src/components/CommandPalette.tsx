import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Empty, Input, List, Modal, Tag, Typography, type InputRef } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

export interface PaletteCommand {
  id: string;
  label: string;
  description: string;
  keywords?: string[];
  shortcut?: string;
  icon?: ReactNode;
  run: () => void | Promise<void>;
}

interface Props {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}

export default function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState('');
  const input = useRef<InputRef>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const timer = window.setTimeout(() => input.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [open]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return commands;
    return commands.filter(command => [command.label, command.description, ...(command.keywords ?? [])]
      .some(value => value.toLowerCase().includes(normalized)));
  }, [commands, query]);

  const run = async (command: PaletteCommand) => {
    onClose();
    await command.run();
  };

  return (
    <Modal open={open} width={590} title="Command palette" footer={null} onCancel={onClose}
      styles={{ body: { paddingTop: 8 } }}>
      <Input ref={input} size="large" allowClear prefix={<SearchOutlined />} value={query}
        onChange={event => setQuery(event.target.value)} onPressEnter={() => { if (visible[0]) void run(visible[0]); }}
        aria-label="Search Quizzer commands" placeholder="Type a command…" />
      <List className="command-palette-list" dataSource={visible}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No matching commands" /> }}
        renderItem={command => <List.Item>
          <button type="button" className="command-palette-command" onClick={() => void run(command)}>
            <span className="command-palette-icon" aria-hidden="true">{command.icon}</span>
            <span>
              <Typography.Text strong>{command.label}</Typography.Text>
              <Typography.Text type="secondary">{command.description}</Typography.Text>
            </span>
            {command.shortcut && <Tag>{command.shortcut}</Tag>}
          </button>
        </List.Item>} />
    </Modal>
  );
}
