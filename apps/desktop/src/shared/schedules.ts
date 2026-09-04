import type { WorkspaceSelectResult } from './workspace.ts';

export const SCHEDULES_CHANNEL = 'schedules:request';
export const SCHEDULES_CHANGED_CHANNEL = 'schedules:changed';

export type ScheduleTiming = Readonly<{
  frequency: 'once' | 'daily' | 'weekdays' | 'weekly';
  time: string;
  weekday: number;
  runAt: number;
}>;
export type ScheduleInput = Readonly<{
  name: string;
  prompt: string;
  workspacePath: string;
  modelProfileId: string;
  timing: ScheduleTiming;
  enabled: boolean;
  autoApprove: boolean;
  timeoutMinutes: number;
}>;
export type ScheduledTask = ScheduleInput & Readonly<{
  id: string;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
}>;
export type ScheduledRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'skipped';
export type ScheduledRun = Readonly<{
  id: string;
  scheduleId: string;
  name: string;
  prompt: string;
  workspacePath: string;
  outputPath: string;
  scheduledAt: number;
  startedAt?: number;
  finishedAt?: number;
  threadId?: string;
  turnId?: string;
  status: ScheduledRunStatus;
  summary: string;
  error?: string;
  reviewedAt?: number;
  artifacts: readonly string[];
}>;
export type SchedulesSnapshot = Readonly<{
  revision: number;
  tasks: readonly ScheduledTask[];
  runs: readonly ScheduledRun[];
  error?: string;
}>;
export type SchedulesRequest =
  | { action: 'get' | 'chooseDirectory' }
  | { action: 'save'; id?: string; input: ScheduleInput }
  | { action: 'remove' | 'removeRun' | 'run' | 'open' | 'review' | 'stop'; id: string }
  | { action: 'toggle'; id: string; enabled: boolean };
export type SchedulesResult = Readonly<{
  accepted: boolean;
  error?: string;
  snapshot?: SchedulesSnapshot;
  path?: string;
  navigation?: WorkspaceSelectResult;
}>;
export type SchedulesApi = Readonly<{
  requestSchedules: (request: SchedulesRequest) => Promise<SchedulesResult>;
  onSchedulesChanged: (listener: (snapshot: SchedulesSnapshot) => void) => () => void;
}>;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0');
export const isScheduleInput = (value: unknown): value is ScheduleInput => {
  if (!record(value) || !record(value.timing)) return false;
  const t = value.timing;
  return text(value.name, 120) && value.name.trim().length > 0 &&
    text(value.prompt, 32_000) && new TextEncoder().encode(value.prompt).length <= 60_000 && value.prompt.trim().length > 0 &&
    text(value.workspacePath, 4096) && text(value.modelProfileId, 256) &&
    typeof value.enabled === 'boolean' && typeof value.autoApprove === 'boolean' &&
    Number.isInteger(value.timeoutMinutes) && Number(value.timeoutMinutes) >= 1 && Number(value.timeoutMinutes) <= 1440 &&
    ['once', 'daily', 'weekdays', 'weekly'].includes(String(t.frequency)) &&
    typeof t.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(t.time) &&
    Number.isInteger(t.weekday) && Number(t.weekday) >= 0 && Number(t.weekday) <= 6 &&
    typeof t.runAt === 'number' && Number.isFinite(t.runAt) && t.runAt >= 0 && t.runAt < 8.64e15;
};
export const isSchedulesRequest = (value: unknown): value is SchedulesRequest => {
  if (!record(value)) return false;
  if (value.action === 'get' || value.action === 'chooseDirectory') return true;
  if (value.action === 'save') return (value.id === undefined || text(value.id, 100)) && isScheduleInput(value.input);
  return text(value.id, 100) && value.id.length > 0 &&
    (['remove', 'removeRun', 'run', 'open', 'review', 'stop'].includes(String(value.action)) ||
      (value.action === 'toggle' && typeof value.enabled === 'boolean'));
};
export const isSchedulesSnapshot = (value: unknown): value is SchedulesSnapshot =>
  record(value) && Number.isSafeInteger(value.revision) &&
  Array.isArray(value.tasks) && value.tasks.every((t) =>
    record(t) && text(t.id, 100) &&
    typeof t.createdAt === 'number' && typeof t.updatedAt === 'number' &&
    (t.nextRunAt === null || (typeof t.nextRunAt === 'number' && Number.isFinite(t.nextRunAt))) && isScheduleInput(t)) &&
  Array.isArray(value.runs) && value.runs.every((r) => record(r) &&
    text(r.id, 100) && text(r.scheduleId, 100) && text(r.name, 120) &&
    text(r.prompt, 32_000) && text(r.workspacePath, 4096) && text(r.outputPath, 4096) &&
    typeof r.scheduledAt === 'number' && Number.isFinite(r.scheduledAt) &&
    ['queued', 'running', 'waiting', 'completed', 'failed', 'interrupted', 'skipped'].includes(String(r.status)) &&
    text(r.summary, 64_000) && (r.error === undefined || text(r.error, 4000)) &&
    (r.threadId === undefined || text(r.threadId, 100)) &&
    (r.turnId === undefined || text(r.turnId, 100)) &&
    ['startedAt', 'finishedAt', 'reviewedAt'].every((key) => r[key] === undefined || (typeof r[key] === 'number' && Number.isFinite(r[key]))) &&
    Array.isArray(r.artifacts) && r.artifacts.every((p) => text(p, 4096)));

// Schedules follow the computer's local clock, including daylight-saving changes.
export const nextScheduledTime = (timing: ScheduleTiming, after: number): number | null => {
  if (timing.frequency === 'once') return timing.runAt > after ? timing.runAt : null;
  const [hours, minutes] = timing.time.split(':').map(Number);
  const day = new Date(after);
  for (let offset = 0; offset < 9; offset += 1) {
    const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset, hours, minutes);
    if (candidate.getTime() <= after) continue;
    const weekday = candidate.getDay();
    if (timing.frequency === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
    if (timing.frequency === 'weekly' && weekday !== timing.weekday) continue;
    return candidate.getTime();
  }
  return null;
};
export const isActiveScheduledRun = (run: ScheduledRun): boolean =>
  ['queued', 'running', 'waiting'].includes(run.status);
