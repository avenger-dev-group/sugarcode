import type { UserInputAnswer, UserInputDraftState } from './types';

export const initialUserInputDraftState = (): UserInputDraftState => ({
  questionIndex: 0,
  decisions: {},
  customAnswers: {},
  submitting: false,
  error: null,
});

export const hasHorizontalOverflow = (
  scrollWidth: number,
  clientWidth: number,
): boolean => scrollWidth > clientWidth + 1;

export const shouldConfirmCustomAnswer = (
  key: string,
  canConfirm: boolean,
  isComposing: boolean,
  keyCode: number,
): boolean =>
  key === 'Enter' && canConfirm && !isComposing && keyCode !== 229;

export const orderedUserInputDecisions = (
  questionIds: readonly string[],
  decisions: Readonly<Record<string, UserInputAnswer>>,
): readonly UserInputAnswer[] =>
  questionIds.flatMap((questionId) => {
    const decision = decisions[questionId];
    return decision ? [decision] : [];
  });

export const nextUserInputQuestionIndex = (
  currentIndex: number,
  questionIds: readonly string[],
  decisions: Readonly<Record<string, UserInputAnswer>>,
): number | null => {
  const unresolvedIndex = questionIds.findIndex(
    (questionId) => !decisions[questionId],
  );
  if (unresolvedIndex < 0) {
    return null;
  }
  return currentIndex < questionIds.length - 1
    ? currentIndex + 1
    : unresolvedIndex;
};
