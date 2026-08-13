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
  type CommandApprovalViewModel,
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
  const [actionPendingIds, setActionPendingIds] = useState<readonly string[]>([]);
  const [modePending, setModePending] = useState<boolean>(false);
  const [selectedModes, setSelectedModes] = useState<
    Readonly<Record<string, CommandApprovalMode>>
  >({});
  const revisionRef = useRef<number>(INITIAL_SNAPSHOT.revision);

  const acceptSnapshot = useCallback(
    (nextSnapshot: CommandApprovalStateSnapshot): void => {
      if (nextSnapshot.revision < revisionRef.current) {
        return;
      }
      revisionRef.current = nextSnapshot.revision;
      setSnapshot(nextSnapshot);
      const nextRequests = nextSnapshot.requests ??
        (nextSnapshot.request ? [nextSnapshot.request] : []);
      setSelectedModes((current) =>
        Object.fromEntries(
          nextRequests.map((request) => [
            request.presentationId,
            current[request.presentationId] ??
              resolveCommandApprovalMode(
                nextSnapshot,
                request.threadId,
                request.workspaceId,
              ),
          ]),
        ),
      );
      setActionPendingIds((current) =>
        current.filter((id) =>
          nextRequests.some((request) => request.presentationId === id),
        ),
      );
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
      !(snapshot.requests ?? (snapshot.request ? [snapshot.request] : []))
        .some((request) => request.actionState === 'awaitingUser')
    ) {
      return;
    }
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [snapshot]);

  const requests = snapshot.status === 'pending'
    ? snapshot.requests ?? (snapshot.request ? [snapshot.request] : [])
    : [];
  const request = requests[0] ?? null;
  const secondsRemaining = useCallback(
    (item: CommandApprovalViewModel): number =>
      Math.max(0, Math.ceil((item.localExpiresAtMs - nowMs) / 1000)),
    [nowMs],
  );
  const canAct = useCallback(
    (item: CommandApprovalViewModel): boolean =>
      item.actionState === 'awaitingUser' &&
      secondsRemaining(item) > 0 &&
      !actionPendingIds.includes(item.presentationId),
    [actionPendingIds, secondsRemaining],
  );
  const selectedMode = useCallback(
    (item: CommandApprovalViewModel): CommandApprovalMode =>
      selectedModes[item.presentationId] ??
      resolveCommandApprovalMode(snapshot, item.threadId, item.workspaceId),
    [selectedModes, snapshot],
  );

  const submit = useCallback(
    async (
      item: CommandApprovalViewModel,
      decision: 'approved' | 'denied',
    ): Promise<void> => {
      if (!canAct(item)) {
        return;
      }
      setActionPendingIds((current) => [...current, item.presentationId]);
      setActionError(null);
      try {
        const result =
          decision === 'approved'
            ? await approveCommand(item.presentationId, selectedMode(item))
            : await denyCommand(item.presentationId);
        if (!result.accepted) {
          setActionError(
            result.reason === 'stale'
              ? 'This command request is no longer active.'
              : 'Command approval is unavailable.',
          );
          setActionPendingIds((current) =>
            current.filter((id) => id !== item.presentationId),
          );
        }
      } catch {
        setActionError('Command approval is unavailable.');
        setActionPendingIds((current) =>
          current.filter((id) => id !== item.presentationId),
        );
      }
    },
    [canAct, selectedMode],
  );

  const changeMode = useCallback(
    async (
      mode: CommandApprovalMode,
      threadId?: string,
      workspaceId?: string,
    ): Promise<void> => {
      if (modePending) {
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
    [modePending],
  );

  return {
    snapshot,
    request,
    requests,
    isOpen: requests.length > 0,
    canAct,
    secondsRemaining,
    selectedMode,
    modePending,
    actionError,
    setSelectedMode: (presentationId, mode) =>
      setSelectedModes((current) => ({ ...current, [presentationId]: mode })),
    changeMode,
    approve: (item) => submit(item, 'approved'),
    deny: (item) => submit(item, 'denied'),
  };
};
