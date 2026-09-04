import { useCallback, useEffect, useState } from 'react';
import type { SchedulesRequest, SchedulesResult, SchedulesSnapshot } from '@/shared/schedules';

export const useSchedules = () => {
  const [snapshot, setSnapshot] = useState<SchedulesSnapshot>({ revision: -1, tasks: [], runs: [] });
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const accept = useCallback((next: SchedulesSnapshot) => {
    setSnapshot((current) => next.revision > current.revision ? next : current);
  }, []);
  useEffect(() => {
    let active = true;
    const unsubscribe = window.sugarcode.onSchedulesChanged((next) => { if (active) accept(next); });
    void window.sugarcode.requestSchedules({ action: 'get' }).then((result) => {
      if (!active) return;
      if (result.snapshot) accept(result.snapshot);
      if (!result.accepted) setError(result.error);
    }).catch(() => { if (active) setError('无法加载定时任务。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; unsubscribe(); };
  }, [accept]);
  const request = useCallback(async (input: SchedulesRequest): Promise<SchedulesResult> => {
    setError(undefined);
    try {
      const result = await window.sugarcode.requestSchedules(input);
      if (result.snapshot) accept(result.snapshot);
      if (!result.accepted && result.error) setError(result.error);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : '定时任务操作失败。';
      setError(message);
      return { accepted: false, error: message };
    }
  }, [accept]);
  return { snapshot, loading, error: error ?? snapshot.error, request };
};
