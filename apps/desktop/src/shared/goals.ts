import {
  isModelRequestOptions,
  type ModelRequestOptions,
} from './model-config.ts';

export const MAX_GOAL_OBJECTIVE_CHARACTERS = 4_000;
export const MAX_GOAL_PROGRESS_CHARACTERS = 2_000;
export const MAX_GOAL_EVIDENCE_ITEMS = 20;

export type GoalStatus = 'active' | 'paused' | 'completed';

export type GoalPauseReason =
  | 'user'
  | 'blocked'
  | 'budget'
  | 'failure'
  | 'restart'
  | 'modelUnavailable'
  | 'queueBlocked'
  | 'protocolViolation';

export type GoalBudget = Readonly<{
  maxTurns?: number;
  maxDurationMs?: number;
  maxTokens?: number;
}>;

export type GoalUsage = Readonly<{
  turns: number;
  activeDurationMs: number;
  tokens: number;
}>;

export type GoalEvidence = Readonly<{
  kind: 'command' | 'artifact' | 'observation';
  label: string;
  result: string;
}>;

export type GoalProgress = Readonly<{
  summary: string;
  nextStep?: string;
  blocker?: string;
  evidence?: readonly GoalEvidence[];
}>;

export type GoalModelSelection = Readonly<{
  profileId: string;
  request: ModelRequestOptions;
}>;

export type GoalSnapshot = Readonly<{
  id: string;
  threadId: string;
  objective: string;
  status: GoalStatus;
  pauseReason?: GoalPauseReason;
  revision: number;
  model: GoalModelSelection;
  budget: GoalBudget;
  activationUsage: GoalUsage;
  lifetimeUsage: GoalUsage;
  progress?: GoalProgress;
  activeTurnId?: string;
  createdAt: number;
  updatedAt: number;
}>;

export type GoalCreateMutation = Readonly<{
  action: 'create';
  objective: string;
  modelProfileId: string;
  modelRequest: ModelRequestOptions;
  budget?: GoalBudget;
}>;

export type GoalEditMutation = Readonly<{
  action: 'edit';
  threadId: string;
  goalId: string;
  expectedRevision: number;
  objective?: string;
  modelProfileId?: string;
  modelRequest?: ModelRequestOptions;
  budget?: GoalBudget;
}>;

export type GoalStateMutation = Readonly<{
  action: 'pause' | 'resume' | 'clear';
  threadId: string;
  goalId: string;
  expectedRevision: number;
  pauseReason?: GoalPauseReason;
  preserveActivation?: boolean;
}>;

export type ConversationGoalMutation =
  | GoalCreateMutation
  | GoalEditMutation
  | GoalStateMutation;

export type GoalUpdate =
  | Readonly<{
      status: 'in_progress';
      summary: string;
      nextStep: string;
      evidence?: readonly GoalEvidence[];
    }>
  | Readonly<{
      status: 'blocked';
      summary: string;
      blocker: string;
      evidence?: readonly GoalEvidence[];
    }>
  | Readonly<{
      status: 'complete';
      summary: string;
      evidence: readonly GoalEvidence[];
    }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const characterCount = (value: string): number => Array.from(value).length;

export const isGoalObjective = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  characterCount(value) <= MAX_GOAL_OBJECTIVE_CHARACTERS;

const isPositiveSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

export const isGoalBudget = (value: unknown): value is GoalBudget =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['maxTurns', 'maxDurationMs', 'maxTokens'].includes(key),
  ) &&
  (value.maxTurns === undefined || isPositiveSafeInteger(value.maxTurns)) &&
  (value.maxDurationMs === undefined ||
    isPositiveSafeInteger(value.maxDurationMs)) &&
  (value.maxTokens === undefined || isPositiveSafeInteger(value.maxTokens));

const isBoundedProgressText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  characterCount(value) <= MAX_GOAL_PROGRESS_CHARACTERS;

export const isGoalEvidence = (value: unknown): value is GoalEvidence =>
  isRecord(value) &&
  Object.keys(value).every((key) => ['kind', 'label', 'result'].includes(key)) &&
  ['command', 'artifact', 'observation'].includes(String(value.kind)) &&
  typeof value.label === 'string' &&
  value.label.trim().length > 0 &&
  characterCount(value.label) <= 200 &&
  typeof value.result === 'string' &&
  value.result.trim().length > 0 &&
  characterCount(value.result) <= 4_000;

const isOptionalGoalEvidence = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length <= MAX_GOAL_EVIDENCE_ITEMS &&
    value.every(isGoalEvidence));

export const isGoalUpdate = (value: unknown): value is GoalUpdate => {
  if (!isRecord(value) || !isBoundedProgressText(value.summary)) return false;
  if (value.status === 'in_progress') {
    return (
      Object.keys(value).every((key) =>
        ['status', 'summary', 'nextStep', 'evidence'].includes(key),
      ) &&
      isBoundedProgressText(value.nextStep) &&
      isOptionalGoalEvidence(value.evidence)
    );
  }
  if (value.status === 'blocked') {
    return (
      Object.keys(value).every((key) =>
        ['status', 'summary', 'blocker', 'evidence'].includes(key),
      ) &&
      isBoundedProgressText(value.blocker) &&
      isOptionalGoalEvidence(value.evidence)
    );
  }
  return (
    value.status === 'complete' &&
    Object.keys(value).every((key) =>
      ['status', 'summary', 'evidence'].includes(key),
    ) &&
    Array.isArray(value.evidence) &&
    value.evidence.length >= 1 &&
    value.evidence.length <= MAX_GOAL_EVIDENCE_ITEMS &&
    value.evidence.every(isGoalEvidence)
  );
};

const GOAL_PAUSE_REASONS = new Set<GoalPauseReason>([
  'user',
  'blocked',
  'budget',
  'failure',
  'restart',
  'modelUnavailable',
  'queueBlocked',
  'protocolViolation',
]);

const isGoalUsage = (value: unknown): value is GoalUsage =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['turns', 'activeDurationMs', 'tokens'].includes(key),
  ) &&
  [value.turns, value.activeDurationMs, value.tokens].every(
    (sample) => Number.isSafeInteger(sample) && Number(sample) >= 0,
  );

const isGoalProgress = (value: unknown): value is GoalProgress =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['summary', 'nextStep', 'blocker', 'evidence'].includes(key),
  ) &&
  isBoundedProgressText(value.summary) &&
  (value.nextStep === undefined || isBoundedProgressText(value.nextStep)) &&
  (value.blocker === undefined || isBoundedProgressText(value.blocker)) &&
  (value.evidence === undefined ||
    (Array.isArray(value.evidence) &&
      value.evidence.length <= MAX_GOAL_EVIDENCE_ITEMS &&
      value.evidence.every(isGoalEvidence)));

export const isGoalSnapshot = (value: unknown): value is GoalSnapshot =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    [
      'id',
      'threadId',
      'objective',
      'status',
      'pauseReason',
      'revision',
      'model',
      'budget',
      'activationUsage',
      'lifetimeUsage',
      'progress',
      'activeTurnId',
      'createdAt',
      'updatedAt',
    ].includes(key),
  ) &&
  typeof value.id === 'string' &&
  value.id.length > 0 &&
  typeof value.threadId === 'string' &&
  value.threadId.length > 0 &&
  isGoalObjective(value.objective) &&
  ['active', 'paused', 'completed'].includes(String(value.status)) &&
  (value.pauseReason === undefined ||
    GOAL_PAUSE_REASONS.has(value.pauseReason as GoalPauseReason)) &&
  (value.status === 'paused') === (value.pauseReason !== undefined) &&
  Number.isSafeInteger(value.revision) &&
  Number(value.revision) >= 1 &&
  isRecord(value.model) &&
  Object.keys(value.model).every((key) => ['profileId', 'request'].includes(key)) &&
  typeof value.model.profileId === 'string' &&
  /^[A-Za-z0-9_-]{1,64}$/u.test(value.model.profileId) &&
  isModelRequestOptions(value.model.request) &&
  isGoalBudget(value.budget) &&
  isGoalUsage(value.activationUsage) &&
  isGoalUsage(value.lifetimeUsage) &&
  (value.progress === undefined || isGoalProgress(value.progress)) &&
  (value.activeTurnId === undefined ||
    (typeof value.activeTurnId === 'string' && value.activeTurnId.length > 0)) &&
  Number.isSafeInteger(value.createdAt) &&
  Number.isSafeInteger(value.updatedAt);
