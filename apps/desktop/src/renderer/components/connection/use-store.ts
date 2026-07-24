import { useEffect, useRef, useState } from 'react';

import {
  getConnectionState,
  onConnectionStateChanged,
} from '@/renderer/services/connection';
import type { ConnectionStateSnapshot } from '@/shared/connection';

import type { ConnectionStore, ConnectionViewModel } from './types';

const VIEW_MODEL_BY_STATUS: Record<
  ConnectionStateSnapshot['status'],
  Omit<ConnectionViewModel, 'status'>
> = {
  idle: {
    label: 'Idle',
    detail: 'Waiting to start the local runtime.',
    tone: 'neutral',
    isBusy: false,
  },
  connecting: {
    label: 'Connecting',
    detail: 'Verifying the local SugarCode runtime.',
    tone: 'active',
    isBusy: true,
  },
  ready: {
    label: 'Ready',
    detail: 'Desktop and CLI completed the protocol handshake.',
    tone: 'success',
    isBusy: false,
  },
  failed: {
    label: 'Connection failed',
    detail: 'The local runtime could not be reached safely.',
    tone: 'danger',
    isBusy: false,
  },
  closed: {
    label: 'Closed',
    detail: 'The local runtime connection is closed.',
    tone: 'neutral',
    isBusy: false,
  },
};

export const toConnectionViewModel = (
  snapshot: ConnectionStateSnapshot,
): ConnectionViewModel => ({
  status: snapshot.status,
  ...VIEW_MODEL_BY_STATUS[snapshot.status],
  ...(snapshot.diagnostic
    ? { detail: snapshot.diagnostic.summary }
    : {}),
});

export const shouldAcceptSnapshot = (
  currentRevision: number,
  snapshot: ConnectionStateSnapshot,
): boolean => snapshot.revision > currentRevision;

export const useStore = (): ConnectionStore => {
  const [connection, setConnection] = useState<ConnectionViewModel>(
    toConnectionViewModel({ revision: 0, status: 'idle' }),
  );
  const revision = useRef<number>(-1);

  useEffect(() => {
    let active = true;
    const acceptSnapshot = (snapshot: ConnectionStateSnapshot): void => {
      if (active && shouldAcceptSnapshot(revision.current, snapshot)) {
        revision.current = snapshot.revision;
        setConnection(toConnectionViewModel(snapshot));
      }
    };

    const unsubscribe = onConnectionStateChanged(acceptSnapshot);
    void getConnectionState().then(acceptSnapshot).catch(() => {
      acceptSnapshot({
        revision: revision.current + 1,
        status: 'failed',
        diagnostic: {
          code: 'protocol-invalid',
          summary: 'Desktop could not read the local connection state.',
        },
      });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return { connection };
};
