import { isGoalObjective } from './goals.ts';
import { findComposerReferences } from './composer.ts';

export type GoalCommand =
  | Readonly<{ action: 'view' }>
  | Readonly<{ action: 'create'; objective: string }>
  | Readonly<{ action: 'edit'; objective: string }>
  | Readonly<{ action: 'pause' | 'resume' | 'clear' }>
  | Readonly<{ action: 'invalid'; reason: 'missingObjective' | 'tooLong' }>;

export const parseGoalCommand = (value: string): GoalCommand | null => {
  const references = findComposerReferences(value);
  const goalReferences = references.filter(
    (reference) =>
      reference.kind === 'command' && reference.target === 'goal',
  );
  if (
    goalReferences.length !== 1 ||
    references.some(
      (reference) =>
        reference.kind === 'command' && reference.target !== 'goal',
    )
  ) {
    return null;
  }
  const reference = goalReferences[0];
  if (!reference) return null;
  const argument = `${value.slice(0, reference.start)}${value.slice(reference.end)}`.trim();
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
