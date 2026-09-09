import { Button, Select, Space, Tag, Typography } from 'antd';
import { UndoOutlined } from '@ant-design/icons';
import { ACCENT_COLORS, DEFAULT_ACCENT_COLOR, type AccentColor } from '../utils/accentColor';
import { changeAccentColor, useAccentColor } from '../utils/useAccentColor';
import { getMessageApi } from '../utils/messageProvider';

export default function AccentColorSetting() {
  const accent = useAccentColor();
  const apply = (color: AccentColor) => {
    try {
      changeAccentColor(color);
    } catch {
      getMessageApi().error('Could not save the accent color. Check that local storage is available and try again.');
    }
  };

  return <div className="settings-row" id="setting-accent-color" tabIndex={-1}>
    <div className="settings-copy">
      <Typography.Text strong>Accent color</Typography.Text>
      <Typography.Text type="secondary">Choose the color of buttons, links, and highlights. Applies immediately and is saved on this device.</Typography.Text>
      <Space size={[4, 4]} wrap><Tag>App preference</Tag></Space>
    </div>
    <div className="settings-control">
      <Select<AccentColor> aria-label="Accent color" value={accent} onChange={apply}
        options={ACCENT_COLORS.map(color => ({ value: color.id, label: color.label }))} />
      <Button type="text" size="small" icon={<UndoOutlined />} disabled={accent === DEFAULT_ACCENT_COLOR}
        aria-label="Reset accent color" onClick={() => apply(DEFAULT_ACCENT_COLOR)}>Reset</Button>
    </div>
  </div>;
}
