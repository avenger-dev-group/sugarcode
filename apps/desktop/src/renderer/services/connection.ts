import type {
  ConnectionStateListener,
  ConnectionStateSnapshot,
} from '@/shared/connection';

export const getConnectionState = (): Promise<ConnectionStateSnapshot> =>
  window.sugarcode.getConnectionState();

export const onConnectionStateChanged = (
  listener: ConnectionStateListener,
): (() => void) => window.sugarcode.onConnectionStateChanged(listener);
