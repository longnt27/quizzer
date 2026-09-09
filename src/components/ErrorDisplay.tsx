import React from 'react';
import { Alert } from 'antd';
import { formatError } from '../utils/errorFormatting';

interface ErrorDisplayProps {
  error: unknown;
  context?: string;
  type?: 'error' | 'warning' | 'info';
  style?: React.CSSProperties;
}

export const ErrorDisplay: React.FC<ErrorDisplayProps> = ({ error, context = 'Error', type = 'error', style }) => {
  if (!error) return null;
  const formatted = formatError(error, context);

  return (
    <Alert
      type={type}
      showIcon
      message={formatted.problem}
      description={formatted.nextStep}
      style={style}
    />
  );
};
