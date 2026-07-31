import { useEffect, useRef, useState } from 'react';
import { useStore as useZustandStore } from 'zustand';

import {
  createTerminal,
  getTerminalSnapshot,
  onTerminalStateChanged,
  resizeTerminal,
  terminateTerminal,
  writeTerminalInput,
} from '@/renderer/services/terminal';
import { workspaceProjectionStore } from '@/renderer/stores/workspace-projection-store';
import type {
  TerminalActionResult,
  TerminalSessionRequest,
  TerminalStateSignal,
  TerminalStateSnapshot,
} from '@/shared/terminal';

import type { TerminalWorkbenchStore } from './types';

const INITIAL_TERMINAL_STATE: TerminalStateSnapshot = {
  revision: 0,
  generation: 0,
  status: 'closed',
  acknowledgedThrough: 0,
  output: [],
};
const messageForResult = (
  result: TerminalActionResult,
): string | null => {
  if (result.accepted || result.reason === 'cancelled') {
    return null;
  }
  switch (result.reason) {
    case 'stale':
      return 'The workspace changed. Open a terminal for the current workspace.';
    case 'busy':
      return 'Terminal input is paused or another local operation is in progress.';
    case 'unavailable':
      return 'The local terminal is unavailable in the current workspace state.';
    case 'invalid':
      return 'Desktop Main rejected an invalid terminal request.';
    case 'failed':
      return 'The local terminal bridge could not be started.';
    default:
      return 'The local terminal action failed.';
  }
};

const failureMessage = (
  snapshot: Extract<TerminalStateSnapshot, { status: 'failed' }>,
): string => {
  switch (snapshot.error) {
    case 'protocolInvalid':
      return 'The terminal bridge sent an invalid protocol event and was closed.';
    case 'bridgeCrashed':
      return 'The terminal bridge stopped unexpectedly and its process tree was closed.';
    case 'outputOverload':
      return 'Terminal output exceeded the bounded Main queue and the session was closed.';
    case 'spawnFailed':
    default:
      return 'The packaged terminal bridge could not be started.';
  }
};

export const useStore = (): TerminalWorkbenchStore => {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TerminalStateSnapshot>(
    INITIAL_TERMINAL_STATE,
  );
  const workspace = useZustandStore(
    workspaceProjectionStore,
    (projection) => projection.snapshot,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  const workspaceRef = useRef(workspace);
  const targetRef = useRef<Readonly<{
    generation: number;
    sessionId?: string;
  }>>({ generation: 0 });
  const acknowledgementRef = useRef(0);
  const pullingRef = useRef(false);
  const pendingPullRef = useRef(false);

  stateRef.current = state;
  workspaceRef.current = workspace;

  const pull = async (): Promise<void> => {
    if (pullingRef.current) {
      pendingPullRef.current = true;
      return;
    }
    pullingRef.current = true;
    try {
      do {
        pendingPullRef.current = false;
        const target = targetRef.current;
        const snapshot = await getTerminalSnapshot({
          generation: target.generation,
          ...(target.sessionId ? { sessionId: target.sessionId } : {}),
          acknowledgeThrough: acknowledgementRef.current,
        });
        stateRef.current = snapshot;
        setState(snapshot);
        targetRef.current = {
          generation: snapshot.generation,
          ...(snapshot.status !== 'closed'
            ? { sessionId: snapshot.sessionId }
            : {}),
        };
        if (snapshot.status === 'failed') {
          setError(failureMessage(snapshot));
        }
      } while (pendingPullRef.current);
    } catch {
      setError('Terminal state could not be read from Desktop Main.');
    } finally {
      pullingRef.current = false;
    }
  };

  useEffect(() => {
    let active = true;
    void pull();
    const unsubscribeTerminal = onTerminalStateChanged(
      (signal: TerminalStateSignal) => {
        if (!active) {
          return;
        }
        if (signal.sessionId !== targetRef.current.sessionId) {
          acknowledgementRef.current = 0;
        }
        targetRef.current = {
          generation: signal.generation,
          ...(signal.sessionId ? { sessionId: signal.sessionId } : {}),
        };
        void pull();
      },
    );
    return () => {
      active = false;
      unsubscribeTerminal();
    };
  }, []);

  useEffect(() => {
    workspaceRef.current = workspace;
    if (workspace.generation === targetRef.current.generation) {
      return;
    }
    acknowledgementRef.current = 0;
    targetRef.current = { generation: workspace.generation };
    void pull();
  }, [workspace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.code === 'Backquote'
      ) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const run = async (
    action: () => Promise<TerminalActionResult>,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setError(messageForResult(result));
    } catch {
      setError('The terminal action could not reach Desktop Main.');
    } finally {
      setBusy(false);
    }
  };

  const sessionRequest = (): TerminalSessionRequest | null => {
    const current = stateRef.current;
    return current.status === 'closed'
      ? null
      : {
          generation: current.generation,
          sessionId: current.sessionId,
        };
  };

  return {
    open,
    state,
    workspace,
    busy,
    error,
    setOpen,
    refresh: pull,
    acknowledge: async (sequence) => {
      if (sequence <= acknowledgementRef.current) {
        return;
      }
      acknowledgementRef.current = sequence;
      await pull();
    },
    create: async (columns, rows) => {
      const currentWorkspace = workspaceRef.current;
      await run(() =>
        createTerminal({
          generation: currentWorkspace.generation,
          columns,
          rows,
        }),
      );
    },
    input: async (data) => {
      const request = sessionRequest();
      if (!request) {
        return;
      }
      try {
        const result = await writeTerminalInput({ ...request, data });
        if (!result.accepted && result.reason !== 'busy') {
          setError(messageForResult(result));
        }
      } catch {
        setError('Terminal input could not reach Desktop Main.');
      }
    },
    resize: async (columns, rows) => {
      const request = sessionRequest();
      if (!request) {
        return;
      }
      try {
        const result = await resizeTerminal({
          ...request,
          columns,
          rows,
        });
        if (!result.accepted && result.reason !== 'busy') {
          setError(messageForResult(result));
        }
      } catch {
        setError('Terminal resize could not reach Desktop Main.');
      }
    },
    terminate: async () => {
      const request = sessionRequest();
      if (!request) {
        return;
      }
      await run(() => terminateTerminal(request));
    },
  };
};
