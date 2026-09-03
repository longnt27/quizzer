import { Modal } from 'antd';
import { useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';

interface Props {
    rawJson: string;
    errorMessage: string;
    onFixed: (fixed: string) => void;
    onClose: () => void;
}

const JsonFixerModal: React.FC<Props> = ({ rawJson, errorMessage, onFixed, onClose }) => {
    const [text, setText] = useState(rawJson);

    return (
        <Modal
            open
            title="JSON Parsing Failed"
            onCancel={onClose}
            onOk={() => onFixed(text)}
            okText="Try Again"
        >
            <p>Error: {errorMessage}</p>
            <CodeMirror
                value={rawJson}
                height="400px"
                extensions={[json()]}
                onChange={(val) => setText(val)}
                theme="light"
            />
        </Modal>

    );
};

export default JsonFixerModal;
