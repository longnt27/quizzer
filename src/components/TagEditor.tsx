import { useState } from 'react';
import { Button, Input, Space, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  subject: string;
}

export default function TagEditor({ tags, onChange, subject }: Props) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const addLabel = `Add tag to ${subject}`;

  const commit = () => {
    const next = value.trim();
    if (next && !tags.includes(next)) onChange([...tags, next]);
    setValue('');
    setAdding(false);
  };

  return <div className="document-tag-editor">
    <Typography.Text type="secondary">Tags</Typography.Text>
    <Space size={[6, 6]} wrap>
      {tags.map(tag => <Tag key={tag} closable onClose={event => {
        event.preventDefault();
        onChange(tags.filter(item => item !== tag));
      }}>{tag}</Tag>)}
      {adding ? <Input autoFocus size="small" value={value} aria-label={addLabel} placeholder="Tag name"
        onChange={event => setValue(event.target.value)} onBlur={commit} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === 'Escape') { setValue(''); setAdding(false); }
        }} />
        : <Button size="small" type="dashed" icon={<PlusOutlined />} aria-label={addLabel} onClick={() => setAdding(true)}>Add tag</Button>}
    </Space>
  </div>;
}
