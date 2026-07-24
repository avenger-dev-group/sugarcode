import type { ConnectionStatus } from '@/shared/connection';

export type ConnectionTone = 'neutral' | 'active' | 'success' | 'danger';

export type ConnectionViewModel = Readonly<{
  status: ConnectionStatus;
  label: string;
  detail: string;
  tone: ConnectionTone;
  isBusy: boolean;
}>;

export type ConnectionStore = Readonly<{
  connection: ConnectionViewModel;
}>;

export type ConnectionStatusViewProps = Readonly<{
  connection: ConnectionViewModel;
}>;
