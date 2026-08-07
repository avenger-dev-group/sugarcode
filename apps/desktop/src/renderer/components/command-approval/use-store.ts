import { useCallback, useEffect, useRef, useState } from 'react';

import {
  approveCommand,
  denyCommand,
  getCommandApprovalState,
  onCommandApprovalStateChanged,
  setCommandApprovalMode,
} from '@/renderer/services/command-approval';
import {
  resolveCommandApprovalMode,
  type CommandApprovalMode,
  type CommandApprovalStateSnapshot,
} from '@/shared/command-approval';

import type { CommandApprovalStore } from './types';

const INITIAL_SNAPSHOT: CommandApprovalStateSnapshot = {
  revision: 0,
  status: 'idle',
  mode: 'ask',
};

export const useStore = (): CommandApprovalStore => {
  const [snapshot, setSnapshot] =
    useState<CommandApprovalStateSnapshot>(INITIAL_SNAPSHOT);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<boolean>(false);
  const [modePending, setModePending] = useState<boolean>(false);
  const [selectedMode, setSelectedMode] =
    useState<CommandApprovalMode>('ask');
  const revisionRef = useRef<number>(INITIAL_SNAPSHOT.revision);

  const acceptSnapshot = useCallback(
    (nextSnapshot: CommandApprovalStateSnapshot): void => {
      if (nextSnapshot.revision < revisionRef.current) {
        return;
      }
      revisionRef.current = nextSnapshot.revision;
      setSnapshot(nextSnapshot);
      setSelectedMode(
        nextSnapshot.request
          ? resolveCommandApprovalMode(
              nextSnapshot,
              nextSnapshot.request.threadId,
              nextSnapshot.request.workspaceId,
            )
          : nextSnapshot.mode,
      );
      setActionPending(false);
      setModePending(false);
      setActionError(null);
      setNowMs(Date.now());
    },
    [],
  );

  useEffect(() => {
    const unsubscribe = onCommandApprovalStateChanged(acceptSnapshot);
    void getCommandApprovalState()
      .then(acceptSnapshot)
      .catch(() => {
        setActionError('Command approval is unavailable.');
      });
    return unsubscribe;
  }, [acceptSnapshot]);

  useEffect(() => {
    if (
      snapshot.status !== 'pending' ||
      snapshot.request?.actionState !== 'awaitingUser'
    ) {
      return;
    }
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 250);
    return () => window.clearInterval(interval);
  }, [snapshot]);

  const request =
    snapshot.status === 'pending' && snapshot.request
      ? snapshot.request
      : null;
  const secondsRemaining = request
    ? Math.max(0, Math.ceil((request.localExpiresAtMs - nowMs) / 1000))
    : 0;
  const canAct =
    request?.actionState === 'awaitingUser' &&
    secondsRemaining > 0 &&
    !actionPending;

  const submit = useCallback(
    async (decision: 'approved' | 'denied'): Promise<void> => {
      if (!request || !canAct) {
        return;
      }
      setActionPending(true);
      setActionError(null);
      try {
        const result =
          decision === 'approved'
            ? await approveCommand(request.presentationId, selectedMode)
            : await denyCommand(request.presentationId);
        if (!result.accepted) {
          setActionError(
            result.reason === 'stale'
              ? 'This command request is no longer active.'
              : 'Command approval is unavailable.',
          );
          setActionPending(false);
        }
      } catch {
        setActionError('Command approval is unavailable.');
        setActionPending(false);
      }
    },
    [canAct, request, selectedMode],
  );

  const changeMode = useCallback(
    async (
      mode: CommandApprovalMode,
      threadId?: string,
      workspaceId?: string,
    ): Promise<void> => {
      if (modePending || snapshot.status === 'pending') {
        return;
      }
      setModePending(true);
      setActionError(null);
      try {
        const result = await setCommandApprovalMode(
          mode,
          threadId,
          workspaceId,
        );
        if (!result.accepted) {
          setActionError('Permission mode could not be changed.');
          setModePending(false);
        }
      } catch {
        setActionError('Permission mode could not be changed.');
        setModePending(false);
      }
    },
    [modePending, snapshot.status],
  );

  return {
    snapshot,
    request,
    isOpen: request !== null,
    canAct,
    secondsRemaining,
    selectedMode,
    modePending,
    actionError,
    setSelectedMode,
    changeMode,
    approve: () => submit('approved'),
    deny: () => submit('denied'),
  };
};
