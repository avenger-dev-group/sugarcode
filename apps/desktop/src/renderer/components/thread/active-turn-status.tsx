import { CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type {
  ActiveTurnProgressViewModel,
  ProcessLanguage,
} from './types';
import {
  formatProcessDuration,
  uuidV7TimestampMs,
} from './activity-disclosure';

const LONG_RUNNING_THRESHOLD_MS = 30_000;

export const ActiveTurnStatus = ({
  progress,
  language,
}: Readonly<{
  progress: ActiveTurnProgressViewModel;
  language: ProcessLanguage;
}>) => {
  const fallbackStartedAtMs = useRef(Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const startedAtMs =
    uuidV7TimestampMs(progress.turnId) ?? fallbackStartedAtMs.current;
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  const elapsedLabel = formatProcessDuration(elapsedMs, language);
  const animated =
    progress.state !== 'uncertain' &&
    progress.state !== 'waitingForApproval' &&
    progress.state !== 'waitingForInput';
  const longRunningDetail =
    animated && elapsedMs >= LONG_RUNNING_THRESHOLD_MS && !progress.detail
      ? language === 'zh'
        ? '这一步比预期更久，Agent 仍在运行'
        : 'This step is taking longer than expected. The agent is still running.'
      : undefined;
  const detail = progress.detail ?? longRunningDetail;

  return (
    <div
      className="flex min-w-0 items-start gap-2.5 text-sm font-normal text-process"
      role="status"
      aria-live="polite"
      aria-label={detail ? `${progress.label}，${detail}` : progress.label}
    >
      {progress.state === 'uncertain' ? (
        <CircleAlert
          className="mt-0.5 size-3.5 shrink-0"
          aria-hidden="true"
        />
      ) : (
        <span
          className="agent-activity-beacon mt-[0.45rem]"
          data-active={animated ? 'true' : 'false'}
          aria-hidden="true"
        />
      )}
      <div className="min-w-0">
        <p aria-hidden="true">
          <span className={animated ? 'agent-status-shimmer' : undefined}>
            {progress.label}
          </span>
          <span className="ml-1.5 tabular-nums text-tertiary">
            · {elapsedLabel}
          </span>
        </p>
        {detail ? (
          <p
            className="mt-1 max-w-xl truncate text-xs leading-normal text-secondary"
            title={detail}
            aria-hidden="true"
          >
            {detail}
          </p>
        ) : null}
      </div>
    </div>
  );
};
