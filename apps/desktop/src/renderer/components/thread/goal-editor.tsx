import { Check, Gauge, Save, Target } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { Textarea } from '@/renderer/components/ui/textarea';
import {
  isGoalObjective,
  MAX_GOAL_OBJECTIVE_CHARACTERS,
  type ConversationGoalMutation,
  type GoalBudget,
  type GoalSnapshot,
} from '@/shared/conversation';
import type {
  ModelReasoningEffort,
  ModelServiceTier,
} from '@/shared/model-config';

import { formatGoalUsage, goalStatusLabel } from './goal-format';

type GoalEditorProps = Readonly<{
  goal: GoalSnapshot;
  modelOptions: readonly Readonly<{
    profileId: string;
    label: string;
    available: boolean;
    providerFamily?: 'openai' | 'anthropic';
  }>[];
  onMutate: (mutation: ConversationGoalMutation) => Promise<boolean>;
}>;

const positiveInteger = (value: string): number | undefined => {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const validOptionalInteger = (value: string): boolean =>
  !value.trim() || positiveInteger(value) !== undefined;

const durationMilliseconds = (value: string): number | undefined => {
  if (!value.trim()) return undefined;
  const minutes = Number(value);
  const milliseconds = minutes * 60_000;
  return Number.isFinite(minutes) &&
    minutes > 0 &&
    Number.isSafeInteger(milliseconds)
    ? milliseconds
    : undefined;
};

const configurationKey = (goal: GoalSnapshot): string =>
  JSON.stringify({
    objective: goal.objective.trim(),
    model: {
      profileId: goal.model.profileId,
      request: {
        reasoningEffort: goal.model.request.reasoningEffort ?? 'auto',
        serviceTier: goal.model.request.serviceTier ?? 'auto',
      },
    },
    budget: {
      ...(goal.budget.maxTurns ? { maxTurns: goal.budget.maxTurns } : {}),
      ...(goal.budget.maxDurationMs
        ? { maxDurationMs: goal.budget.maxDurationMs }
        : {}),
      ...(goal.budget.maxTokens ? { maxTokens: goal.budget.maxTokens } : {}),
    },
  });

export const GoalEditor = ({ goal, modelOptions, onMutate }: GoalEditorProps) => {
  const [objective, setObjective] = useState(goal.objective);
  const [modelProfileId, setModelProfileId] = useState(goal.model.profileId);
  const [reasoningEffort, setReasoningEffort] = useState<ModelReasoningEffort>(
    goal.model.request.reasoningEffort ?? 'auto',
  );
  const [serviceTier, setServiceTier] = useState<ModelServiceTier>(
    goal.model.request.serviceTier ?? 'auto',
  );
  const [maxTurns, setMaxTurns] = useState(String(goal.budget.maxTurns ?? ''));
  const [maxDurationMinutes, setMaxDurationMinutes] = useState(
    goal.budget.maxDurationMs === undefined
      ? ''
      : String(goal.budget.maxDurationMs / 60_000),
  );
  const [maxTokens, setMaxTokens] = useState(String(goal.budget.maxTokens ?? ''));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const configKey = configurationKey(goal);
  const sourceObjective = goal.objective;
  const sourceProfileId = goal.model.profileId;
  const sourceReasoningEffort = goal.model.request.reasoningEffort;
  const sourceServiceTier = goal.model.request.serviceTier;
  const sourceMaxTurns = goal.budget.maxTurns;
  const sourceMaxDurationMs = goal.budget.maxDurationMs;
  const sourceMaxTokens = goal.budget.maxTokens;

  useEffect(() => {
    setObjective(sourceObjective);
    setModelProfileId(sourceProfileId);
    setReasoningEffort(sourceReasoningEffort ?? 'auto');
    setServiceTier(sourceServiceTier ?? 'auto');
    setMaxTurns(String(sourceMaxTurns ?? ''));
    setMaxDurationMinutes(
      sourceMaxDurationMs === undefined
        ? ''
        : String(sourceMaxDurationMs / 60_000),
    );
    setMaxTokens(String(sourceMaxTokens ?? ''));
    setSaved(false);
  }, [
    sourceMaxDurationMs,
    sourceMaxTokens,
    sourceMaxTurns,
    sourceObjective,
    sourceProfileId,
    sourceReasoningEffort,
    sourceServiceTier,
  ]);

  const providerFamily =
    modelOptions.find((model) => model.profileId === modelProfileId)
      ?.providerFamily ?? 'openai';
  const objectiveLength = Array.from(objective).length;
  const durationMs = durationMilliseconds(maxDurationMinutes);
  const budgetValid =
    validOptionalInteger(maxTurns) &&
    (!maxDurationMinutes.trim() || durationMs !== undefined) &&
    validOptionalInteger(maxTokens) &&
    (durationMs === undefined || Number.isSafeInteger(durationMs));
  const dirty = useMemo(
    () => JSON.stringify({
      objective: objective.trim(),
      model: {
        profileId: modelProfileId,
        request: { reasoningEffort, serviceTier },
      },
      budget: {
        ...(positiveInteger(maxTurns) ? { maxTurns: positiveInteger(maxTurns) } : {}),
        ...(durationMs ? { maxDurationMs: durationMs } : {}),
        ...(positiveInteger(maxTokens) ? { maxTokens: positiveInteger(maxTokens) } : {}),
      },
    }) !== configKey,
    [configKey, durationMs, maxTokens, maxTurns, modelProfileId, objective, reasoningEffort, serviceTier],
  );

  const save = async (): Promise<void> => {
    const budget: GoalBudget = {
      ...(positiveInteger(maxTurns) ? { maxTurns: positiveInteger(maxTurns) } : {}),
      ...(durationMs ? { maxDurationMs: durationMs } : {}),
      ...(positiveInteger(maxTokens) ? { maxTokens: positiveInteger(maxTokens) } : {}),
    };
    setSaving(true);
    setSaved(false);
    try {
      const accepted = await onMutate({
        action: 'edit',
        threadId: goal.threadId,
        goalId: goal.id,
        expectedRevision: goal.revision,
        objective: objective.trim(),
        modelProfileId,
        modelRequest: { reasoningEffort, serviceTier },
        budget,
      });
      setSaved(accepted);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex h-full min-h-0 flex-col bg-background"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7">
        <div className="mx-auto max-w-2xl space-y-8">
          <header className="border-b border-border-subtle pb-5">
            <div className="flex items-center gap-2 text-xs font-medium text-secondary">
              <Target className="size-3.5 text-process" aria-hidden="true" />
              {goalStatusLabel(goal.status)}
            </div>
            <h2 className="mt-2 text-lg font-semibold tracking-tight">编辑目标</h2>
            <p className="mt-1 text-xs leading-5 text-tertiary">
              修改会在下一次 Goal Turn 生效，不会中断当前正在执行的工具。
            </p>
          </header>

          <section className="space-y-2.5">
            <div className="flex items-baseline justify-between gap-4">
              <label htmlFor="goal-objective" className="text-sm font-medium">目标描述</label>
              <span className={`font-mono text-[11px] tabular-nums ${objectiveLength > MAX_GOAL_OBJECTIVE_CHARACTERS ? 'text-destructive' : 'text-tertiary'}`}>
                {objectiveLength} / {MAX_GOAL_OBJECTIVE_CHARACTERS}
              </span>
            </div>
            <Textarea
              id="goal-objective"
              value={objective}
              onChange={(event) => {
                setObjective(event.target.value);
                setSaved(false);
              }}
              className="min-h-72 resize-y rounded-xl px-4 py-3 text-sm leading-6"
              autoFocus
            />
          </section>

          <section className="space-y-3 border-t border-border-subtle pt-6">
            <div>
              <h3 className="text-sm font-medium">运行配置</h3>
              <p className="mt-1 text-xs text-tertiary">模型在目标创建时固定，只有在这里显式保存后才会改变。</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Select value={modelProfileId} onValueChange={(value) => {
                setModelProfileId(value);
                setSaved(false);
                const family = modelOptions.find((model) => model.profileId === value)?.providerFamily;
                if (family === 'anthropic' && ['none', 'minimal', 'xhigh'].includes(reasoningEffort)) setReasoningEffort('auto');
              }}>
                <SelectTrigger aria-label="Goal 固定模型"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {modelOptions.map((model) => (
                    <SelectItem key={model.profileId} value={model.profileId} disabled={!model.available}>{model.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={reasoningEffort} onValueChange={(value) => {
                setReasoningEffort(value as ModelReasoningEffort);
                setSaved(false);
              }}>
                <SelectTrigger aria-label="Goal 推理强度"><Gauge className="size-3.5" /><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['auto', ...(providerFamily === 'openai' ? ['none', 'minimal'] : []), 'low', 'medium', 'high', ...(providerFamily === 'openai' ? ['xhigh'] : []), 'max'].map((value) => (
                    <SelectItem key={value} value={value}>推理：{value}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={serviceTier} onValueChange={(value) => {
                setServiceTier(value as ModelServiceTier);
                setSaved(false);
              }}>
                <SelectTrigger aria-label="Goal 服务速度"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">速度：自动</SelectItem>
                  <SelectItem value="standard">速度：标准</SelectItem>
                  <SelectItem value="fast">速度：Fast</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </section>

          <section className="space-y-3 border-t border-border-subtle pt-6">
            <div>
              <h3 className="text-sm font-medium">本周期预算</h3>
              <p className="mt-1 text-xs text-tertiary">留空表示不限；恢复目标时会开启新的预算周期。</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1.5 text-xs text-secondary">自动 Turns
                <Input inputMode="numeric" placeholder="不限" value={maxTurns} onChange={(event) => { setMaxTurns(event.target.value); setSaved(false); }} />
              </label>
              <label className="space-y-1.5 text-xs text-secondary">活跃分钟
                <Input inputMode="numeric" placeholder="不限" value={maxDurationMinutes} onChange={(event) => { setMaxDurationMinutes(event.target.value); setSaved(false); }} />
              </label>
              <label className="space-y-1.5 text-xs text-secondary">Tokens
                <Input inputMode="numeric" placeholder="不限" value={maxTokens} onChange={(event) => { setMaxTokens(event.target.value); setSaved(false); }} />
              </label>
            </div>
            {!budgetValid ? <p className="text-xs text-destructive">Turns 和 Tokens 必须为正整数；分钟可填写能精确换算为毫秒的正数。</p> : null}
          </section>

          <section className="grid gap-3 border-t border-border-subtle pt-6 text-xs sm:grid-cols-2">
            <div><p className="text-tertiary">当前周期</p><p className="mt-1 text-secondary">{formatGoalUsage(goal.activationUsage)}</p></div>
            <div><p className="text-tertiary">生命周期累计</p><p className="mt-1 text-secondary">{formatGoalUsage(goal.lifetimeUsage)}</p></div>
          </section>
        </div>
      </div>

      <footer className="shrink-0 border-t bg-background/95 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
          <span className="text-xs text-tertiary" role="status" aria-live="polite">
            {saved ? <span className="inline-flex items-center gap-1.5 text-success"><Check className="size-3.5" />已保存</span> : dirty ? '有未保存的修改' : '当前配置已同步'}
          </span>
          <Button type="submit" disabled={saving || !dirty || !isGoalObjective(objective) || !budgetValid}>
            <Save className="size-3.5" />{saving ? '保存中…' : '保存修改'}
          </Button>
        </div>
      </footer>
    </form>
  );
};
