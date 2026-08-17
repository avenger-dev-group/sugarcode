import { useEffect, useRef, useState } from 'react';

import {
  getConnectionState,
  onConnectionStateChanged,
} from '@/renderer/services/connection';
import type {
  ConnectionDiagnosticCode,
  ConnectionStateSnapshot,
} from '@/shared/connection';

import type { ConnectionStore, ConnectionViewModel } from './types';

const VIEW_MODEL_BY_STATUS: Record<
  ConnectionStateSnapshot['status'],
  Omit<ConnectionViewModel, 'status'>
> = {
  idle: {
    label: '空闲',
    detail: '正在等待本地运行时启动。',
    tone: 'neutral',
    isBusy: false,
  },
  connecting: {
    label: '正在连接',
    detail: '正在验证 SugarCode 本地运行时。',
    tone: 'active',
    isBusy: true,
  },
  ready: {
    label: '就绪',
    detail: '桌面端已与本地运行时完成协议握手。',
    tone: 'success',
    isBusy: false,
  },
  failed: {
    label: '连接失败',
    detail: '无法安全连接到本地运行时。',
    tone: 'danger',
    isBusy: false,
  },
  closed: {
    label: '已关闭',
    detail: '本地运行时连接已关闭。',
    tone: 'neutral',
    isBusy: false,
  },
};

const DIAGNOSTIC_DETAIL: Partial<Record<ConnectionDiagnosticCode, string>> = {
  'spawn-failed': 'SugarCode 无法启动本地 TypeScript 运行时。',
  'protocol-invalid': '本地 TypeScript 运行时返回了无效的内部事件。',
  'server-crashed': '本地 TypeScript 运行时已停止，正在重新启动。',
};

export const toConnectionViewModel = (
  snapshot: ConnectionStateSnapshot,
): ConnectionViewModel => ({
  status: snapshot.status,
  ...VIEW_MODEL_BY_STATUS[snapshot.status],
  ...(snapshot.diagnostic
    ? {
        detail:
          DIAGNOSTIC_DETAIL[snapshot.diagnostic.code] ??
          snapshot.diagnostic.summary,
      }
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
          summary: '桌面端无法读取本地连接状态。',
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
