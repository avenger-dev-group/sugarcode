import { useCallback, useEffect, useRef, useState } from 'react';

import {
  approveMcpCall,
  denyMcpCall,
  disableMcpSession,
  enableMcpSession,
  getMcpApprovalState,
  getMcpSessionState,
  onMcpApprovalStateChanged,
  onMcpSessionStateChanged,
  toggleMcpServer,
} from '@/renderer/services/mcp';
import type {
  McpApprovalStateSnapshot,
  McpApprovalViewModel,
  McpSessionActionResult,
  McpSessionStateSnapshot,
} from '@/shared/mcp';

import type { McpStore } from './types';

const INITIAL_SESSION: McpSessionStateSnapshot = {
  revision: 0,
  status: 'loading',
  servers: [],
  selectedServerIds: [],
  activeServerIds: [],
};
const INITIAL_APPROVAL: McpApprovalStateSnapshot = {
  revision: 0,
  status: 'idle',
};

const sessionFailure = (reason: McpSessionActionResult['reason']): string => {
  switch (reason) {
    case 'incompatibleSelection':
      return '最多选择 2 个本地命令服务，或单独选择 1 个本地 HTTP 服务。';
    case 'turnActive':
      return '请等待当前任务结束或停止后再更改 MCP 服务。';
    case 'approvalPending':
      return '请先处理正在等待的 MCP 调用授权。';
    case 'busy':
      return '本地智能体正在切换连接，请稍后重试。';
    case 'connectionFailed':
      return '无法连接本地 MCP 服务。请确认服务已启动；使用 Figma Desktop 时，请打开设计文件、进入 Dev Mode 并启用 MCP Server 后重试。';
    case 'invalid':
      return '请至少选择一个可用且兼容的服务。';
    case 'unavailable':
      return 'MCP 运行时暂不可用，请稍后重试。';
    case 'accepted':
      return '';
  }
};

export const useStore = (): McpStore => {
  const [session, setSession] =
    useState<McpSessionStateSnapshot>(INITIAL_SESSION);
  const [approval, setApproval] =
    useState<McpApprovalStateSnapshot>(INITIAL_APPROVAL);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [actionError, setActionError] = useState<string | null>(null);
  const [sessionActionPending, setSessionActionPending] =
    useState<boolean>(false);
  const [approvalActionPendingIds, setApprovalActionPendingIds] = useState<
    readonly string[]
  >([]);
  const sessionRevision = useRef<number>(0);
  const approvalRevision = useRef<number>(0);

  const acceptSession = useCallback((next: McpSessionStateSnapshot): void => {
    if (next.revision < sessionRevision.current) {
      return;
    }
    sessionRevision.current = next.revision;
    setSession(next);
    setSessionActionPending(false);
  }, []);
  const acceptApproval = useCallback(
    (next: McpApprovalStateSnapshot): void => {
      if (next.revision < approvalRevision.current) {
        return;
      }
      approvalRevision.current = next.revision;
      setApproval(next);
      const nextRequests = next.requests ?? (next.request ? [next.request] : []);
      setApprovalActionPendingIds((current) =>
        current.filter((id) =>
          nextRequests.some((request) => request.presentationId === id),
        ),
      );
      setNowMs(Date.now());
    },
    [],
  );

  useEffect(() => {
    const unsubscribeSession = onMcpSessionStateChanged(acceptSession);
    const unsubscribeApproval = onMcpApprovalStateChanged(acceptApproval);
    void getMcpSessionState().then(acceptSession).catch(() => {
      setActionError('无法读取 MCP 连接状态。');
    });
    void getMcpApprovalState().then(acceptApproval).catch(() => {
      setActionError('无法读取 MCP 授权状态。');
    });
    return () => {
      unsubscribeSession();
      unsubscribeApproval();
    };
  }, [acceptApproval, acceptSession]);

  useEffect(() => {
    if (
      approval.status !== 'pending' ||
      !(approval.requests ?? (approval.request ? [approval.request] : []))
        .some((request) => request.actionState === 'awaitingUser')
    ) {
      return;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [approval]);

  const runSessionAction = useCallback(
    async (
      action: () => Promise<McpSessionActionResult>,
    ): Promise<void> => {
      setSessionActionPending(true);
      setActionError(null);
      try {
        const response = await action();
        if (!response.accepted) {
          setActionError(sessionFailure(response.reason));
          setSessionActionPending(false);
        }
      } catch {
        setActionError('SugarCode 无法提交 MCP 连接请求，请重启应用后重试。');
        setSessionActionPending(false);
      }
    },
    [],
  );

  const approvalRequests = approval.status === 'pending'
    ? approval.requests ?? (approval.request ? [approval.request] : [])
    : [];
  const approvalRequest = approvalRequests[0] ?? null;
  const secondsRemaining = useCallback(
    (request: McpApprovalViewModel): number =>
      Math.max(
        0,
        Math.ceil((request.localExpiresAtMs - nowMs) / 1_000),
      ),
    [nowMs],
  );
  const canApprove = useCallback(
    (request: McpApprovalViewModel): boolean =>
      request.actionState === 'awaitingUser' &&
      secondsRemaining(request) > 0 &&
      !approvalActionPendingIds.includes(request.presentationId),
    [approvalActionPendingIds, secondsRemaining],
  );

  const respond = useCallback(
    async (
      request: McpApprovalViewModel,
      decision: 'approved' | 'denied',
    ): Promise<void> => {
      if (!canApprove(request)) {
        return;
      }
      setApprovalActionPendingIds((current) => [
        ...current,
        request.presentationId,
      ]);
      setActionError(null);
      try {
        const response =
          decision === 'approved'
            ? await approveMcpCall(request.presentationId)
            : await denyMcpCall(request.presentationId);
        if (!response.accepted) {
          setActionError(
            response.reason === 'stale'
              ? '这次 MCP 调用已经失效。'
              : 'MCP 授权暂不可用。',
          );
          setApprovalActionPendingIds((current) =>
            current.filter((id) => id !== request.presentationId),
          );
        }
      } catch {
        setActionError('MCP 授权暂不可用。');
        setApprovalActionPendingIds((current) =>
          current.filter((id) => id !== request.presentationId),
        );
      }
    },
    [canApprove],
  );

  return {
    session,
    approval,
    approvalRequest,
    approvalRequests,
    secondsRemaining,
    canApprove,
    sessionBusy:
      sessionActionPending ||
      ['loading', 'enabling', 'disabling', 'rollingBack'].includes(
        session.status,
      ),
    actionError,
    toggleServer: async (serverId) => {
      await runSessionAction(() => toggleMcpServer(serverId));
    },
    enable: async () => {
      await runSessionAction(enableMcpSession);
    },
    disable: async () => {
      await runSessionAction(disableMcpSession);
    },
    approve: (request) => respond(request, 'approved'),
    deny: (request) => respond(request, 'denied'),
  };
};
