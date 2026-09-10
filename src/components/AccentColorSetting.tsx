import { CheckOutlined } from '@ant-design/icons';
import { Button, Popover, Space, Tag, Typography } from 'antd';
import { ACCENT_COLORS, type AccentColor } from '../utils/accentColor';
import { changeAccentColor, useAccentColor } from '../utils/useAccentColor';
import { getMessageApi } from '../utils/messageProvider';

export default function AccentColorSetting() {
  const accent = useAccentColor();
  const selected = ACCENT_COLORS.find(color => color.id === accent) ?? ACCENT_COLORS[0];
  const apply = (color: AccentColor) => {
    try {
      changeAccentColor(color);
    } catch {
      getMessageApi().error('Could not save the accent color. Check that local storage is available and try again.');
    }
  };

  const palette = (
    <div className="accent-color-palette" role="listbox" aria-label="Accent colors">
      {ACCENT_COLORS.map(color => (
        <button key={color.id} type="button" role="option" aria-selected={accent === color.id}
          className={`accent-color-swatch${accent === color.id ? ' is-selected' : ''}`}
          aria-label={color.label} title={color.label} onClick={() => apply(color.id)}>
          <span className="accent-color-dot" style={{ backgroundColor: color.light.primary }} aria-hidden="true">
            {accent === color.id ? <CheckOutlined /> : null}
          </span>
        </button>
      ))}
    </div>
  );

  return <div className="settings-row" id="setting-accent-color" tabIndex={-1}>
    <div className="settings-copy">
      <Typography.Text strong>Accent color</Typography.Text>
      <Typography.Text type="secondary">Choose the color of buttons, links, and highlights. Applies immediately and is saved on this device.</Typography.Text>
      <Space size={[4, 4]} wrap><Tag>App preference</Tag></Space>
    </div>
    <div className="settings-control settings-control-single">
      <Popover content={palette} trigger="click" placement="bottomRight">
        <Button className="accent-color-trigger" aria-label={`Accent color: ${selected.label}`} title={`Accent color: ${selected.label}`}>
          <span className="accent-color-dot" style={{ backgroundColor: selected.light.primary }} aria-hidden="true" />
        </Button>
      </Popover>
    </div>
  </div>;
}
