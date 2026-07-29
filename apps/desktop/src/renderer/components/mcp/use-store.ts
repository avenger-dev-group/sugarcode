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
      return 'Select up to two stdio servers or one loopback HTTP server.';
    case 'turnActive':
      return 'Finish or stop the active Turn before changing MCP servers.';
    case 'approvalPending':
      return 'Resolve the pending approval before changing MCP servers.';
    case 'busy':
      return 'The local Agent is already changing sessions.';
    case 'invalid':
      return 'Choose at least one compatible configured server.';
    case 'unavailable':
      return 'The MCP session could not be changed safely.';
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
  const [actionPending, setActionPending] = useState<boolean>(false);
  const sessionRevision = useRef<number>(0);
  const approvalRevision = useRef<number>(0);

  const acceptSession = useCallback((next: McpSessionStateSnapshot): void => {
    if (next.revision < sessionRevision.current) {
      return;
    }
    sessionRevision.current = next.revision;
    setSession(next);
    setActionPending(false);
  }, []);
  const acceptApproval = useCallback(
    (next: McpApprovalStateSnapshot): void => {
      if (next.revision < approvalRevision.current) {
        return;
      }
      approvalRevision.current = next.revision;
      setApproval(next);
      setActionPending(false);
      setNowMs(Date.now());
    },
    [],
  );

  useEffect(() => {
    const unsubscribeSession = onMcpSessionStateChanged(acceptSession);
    const unsubscribeApproval = onMcpApprovalStateChanged(acceptApproval);
    void getMcpSessionState().then(acceptSession).catch(() => {
      setActionError('MCP session state is unavailable.');
    });
    void getMcpApprovalState().then(acceptApproval).catch(() => {
      setActionError('MCP approval is unavailable.');
    });
    return () => {
      unsubscribeSession();
      unsubscribeApproval();
    };
  }, [acceptApproval, acceptSession]);

  useEffect(() => {
    if (
      approval.status !== 'pending' ||
      approval.request?.actionState !== 'awaitingUser'
    ) {
      return;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [approval]);

  const runSessionAction = useCallback(
    async (
      action: () => Promise<McpSessionActionResult>,
    ): Promise<void> => {
      setActionPending(true);
      setActionError(null);
      try {
        const response = await action();
        if (!response.accepted) {
          setActionError(sessionFailure(response.reason));
          setActionPending(false);
        }
      } catch {
        setActionError('The MCP session could not be changed safely.');
        setActionPending(false);
      }
    },
    [],
  );

  const approvalRequest =
    approval.status === 'pending' && approval.request
      ? approval.request
      : null;
  const secondsRemaining = approvalRequest
    ? Math.max(
        0,
        Math.ceil((approvalRequest.localExpiresAtMs - nowMs) / 1_000),
      )
    : 0;
  const canApprove =
    approvalRequest?.actionState === 'awaitingUser' &&
    secondsRemaining > 0 &&
    !actionPending;

  const respond = useCallback(
    async (decision: 'approved' | 'denied'): Promise<void> => {
      if (!approvalRequest || !canApprove) {
        return;
      }
      setActionPending(true);
      setActionError(null);
      try {
        const response =
          decision === 'approved'
            ? await approveMcpCall(approvalRequest.presentationId)
            : await denyMcpCall(approvalRequest.presentationId);
        if (!response.accepted) {
          setActionError(
            response.reason === 'stale'
              ? 'This MCP request is no longer active.'
              : 'MCP approval is unavailable.',
          );
          setActionPending(false);
        }
      } catch {
        setActionError('MCP approval is unavailable.');
        setActionPending(false);
      }
    },
    [approvalRequest, canApprove],
  );

  return {
    session,
    approval,
    approvalRequest,
    secondsRemaining,
    canApprove,
    sessionBusy:
      actionPending ||
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
    approve: () => respond('approved'),
    deny: () => respond('denied'),
  };
};
