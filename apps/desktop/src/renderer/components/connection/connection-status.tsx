import {
  Circle,
  CircleCheck,
  CircleOff,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react';

import type {
  ConnectionStatusViewProps,
  ConnectionViewModel,
} from './types';
import { useStore } from './use-store';

const StatusIcon = ({
  connection,
}: {
  connection: ConnectionViewModel;
}) => {
  const iconClassName =
    connection.tone === 'danger'
      ? 'size-4 text-destructive'
      : 'size-4 text-current';

  switch (connection.status) {
    case 'connecting':
      return (
        <LoaderCircle
          className={`${iconClassName} animate-spin`}
          aria-hidden="true"
        />
      );
    case 'ready':
      return <CircleCheck className={iconClassName} aria-hidden="true" />;
    case 'failed':
      return <TriangleAlert className={iconClassName} aria-hidden="true" />;
    case 'closed':
      return <CircleOff className={iconClassName} aria-hidden="true" />;
    default:
      return <Circle className={iconClassName} aria-hidden="true" />;
  }
};

export const ConnectionStatusView = ({
  connection,
}: ConnectionStatusViewProps) => (
  <div
    className="relative overflow-hidden rounded-xl border bg-surface px-4 py-3.5"
    role={connection.status === 'failed' ? 'alert' : 'status'}
    aria-live="polite"
    aria-label={`本地运行时：${connection.label}`}
  >
    <div
      className={`absolute inset-y-0 left-0 w-0.5 ${
        connection.tone === 'danger' ? 'bg-destructive' : 'bg-primary'
      }`}
      aria-hidden="true"
    />
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-tertiary">
        <StatusIcon connection={connection} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">{connection.label}</p>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-tertiary">
            TS / NATIVE
          </span>
        </div>
        <p className="mt-1 text-sm font-normal leading-normal text-secondary">
          {connection.detail}
        </p>
      </div>
    </div>
  </div>
);

export const ConnectionStatus = () => {
  const { connection } = useStore();
  return <ConnectionStatusView connection={connection} />;
};
