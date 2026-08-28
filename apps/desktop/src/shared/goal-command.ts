import { isGoalObjective } from './goals.ts';

export type GoalCommand =
  | Readonly<{ action: 'view' }>
  | Readonly<{ action: 'create'; objective: string }>
  | Readonly<{ action: 'edit'; objective: string }>
  | Readonly<{ action: 'pause' | 'resume' | 'clear' }>
  | Readonly<{ action: 'invalid'; reason: 'missingObjective' | 'tooLong' }>;

export const parseGoalCommand = (value: string): GoalCommand | null => {
  const match = /^\s*\/goal(?:\s+([\s\S]*?))?\s*$/u.exec(value);
  if (!match) return null;
  const argument = (match[1] ?? '').trim();
  if (!argument) return { action: 'view' };
  if (argument === 'pause' || argument === 'resume' || argument === 'clear') {
    return { action: argument };
  }
  if (argument === 'edit') {
    return { action: 'invalid', reason: 'missingObjective' };
  }
  if (argument.startsWith('edit ')) {
    const objective = argument.slice('edit '.length).trim();
    return isGoalObjective(objective)
      ? { action: 'edit', objective }
      : {
          action: 'invalid',
          reason: objective ? 'tooLong' : 'missingObjective',
        };
  }
  return isGoalObjective(argument)
    ? { action: 'create', objective: argument }
    : { action: 'invalid', reason: 'tooLong' };
};
