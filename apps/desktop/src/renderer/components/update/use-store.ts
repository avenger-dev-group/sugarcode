import { useEffect, useRef, useState } from 'react';

import {
  getUpdateState,
  onUpdateStateChanged,
} from '@/renderer/services/update';
import type { UpdateStateSnapshot } from '@/shared/update';

const INITIAL_STATE: UpdateStateSnapshot = { revision: 0, status: 'idle' };

export const useStore = (): UpdateStateSnapshot => {
  const [snapshot, setSnapshot] = useState<UpdateStateSnapshot>(INITIAL_STATE);
  const revision = useRef(-1);

  useEffect(() => {
    let active = true;
    const accept = (next: UpdateStateSnapshot): void => {
      if (active && next.revision > revision.current) {
        revision.current = next.revision;
        setSnapshot(next);
      }
    };
    const unsubscribe = onUpdateStateChanged(accept);
    void getUpdateState().then(accept).catch(() => {
      accept({ revision: revision.current + 1, status: 'fallback' });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return snapshot;
};
