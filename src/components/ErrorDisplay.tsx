import type { CSSProperties } from 'react';
import { Alert } from 'antd';
import { formatError, type ErrorContext } from '../utils/errorFormatting';

interface ErrorDisplayProps {
  error: unknown;
  context?: ErrorContext;
  type?: 'error' | 'warning' | 'info';
  style?: CSSProperties;
  className?: string;
}

export function ErrorDisplay({ error, context = 'generic', type = 'error', style, className }: ErrorDisplayProps) {
  if (!error) return null;
  const formatted = formatError(error, context);
  return <Alert className={className} type={type} showIcon message={formatted.problem} description={formatted.nextStep} style={style} />;
}
