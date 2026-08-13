import { useEffect, useState } from 'react';

import { MAX_USER_INPUT_ANSWER_BYTES } from '@/shared/conversation';

import type {
  UserInputAnswer,
  UserInputDraftState,
  UserInputSubmission,
  UserInputSurfaceProps,
} from './types';
import {
  initialUserInputDraftState,
  nextUserInputQuestionIndex,
  orderedUserInputDecisions,
} from './state';

export const useStore = ({
  turnId,
  request,
  onSubmit,
}: UserInputSurfaceProps) => {
  const [state, setState] = useState<UserInputDraftState>(
    initialUserInputDraftState,
  );

  useEffect(() => {
    setState(initialUserInputDraftState());
  }, [request.id]);

  const question = request.questions[state.questionIndex];
  const currentDecision = question
    ? state.decisions[question.id]
    : undefined;
  const currentSelection = currentDecision?.kind === 'answered' &&
      currentDecision.source === 'option'
    ? currentDecision.answer
    : undefined;
  const customAnswer = question
    ? state.customAnswers[question.id] ??
      (currentDecision?.kind === 'answered' &&
        currentDecision.source === 'custom'
        ? currentDecision.answer
        : '')
    : '';
  const answerTooLong =
    new TextEncoder().encode(customAnswer).byteLength >
    MAX_USER_INPUT_ANSWER_BYTES;
  const canConfirmCustom =
    customAnswer.trim().length > 0 && !answerTooLong && !state.submitting;

  const submit = async (
    submission: UserInputSubmission,
  ): Promise<void> => {
    setState((current) => ({ ...current, submitting: true, error: null }));
    const accepted = await onSubmit(turnId, request.id, submission);
    if (!accepted) {
      setState((current) => ({
        ...current,
        submitting: false,
        error: '回答未能提交，请重试。',
      }));
    }
  };

  const settle = async (decision: UserInputAnswer): Promise<void> => {
    if (!question || state.submitting) {
      return;
    }
    const decisions = { ...state.decisions, [question.id]: decision };
    const questionIds = request.questions.map((candidate) => candidate.id);
    const nextIndex = nextUserInputQuestionIndex(
      state.questionIndex,
      questionIds,
      decisions,
    );
    if (nextIndex === null) {
      setState((current) => ({ ...current, decisions, error: null }));
      await submit({
        kind: 'submitted',
        decisions: orderedUserInputDecisions(questionIds, decisions),
      });
      return;
    }
    setState((current) => ({
      ...current,
      decisions,
      questionIndex: nextIndex,
      error: null,
    }));
  };

  const selectOption = (answer: string): void => {
    if (!question) {
      return;
    }
    void settle({
      questionId: question.id,
      kind: 'answered',
      source: 'option',
      answer,
    });
  };

  const setCustomAnswer = (answer: string): void => {
    if (!question) {
      return;
    }
    setState((current) => {
      const decisions = { ...current.decisions };
      delete decisions[question.id];
      return {
        ...current,
        decisions,
        customAnswers: {
          ...current.customAnswers,
          [question.id]: answer,
        },
        error: null,
      };
    });
  };

  const confirmCustomAnswer = (): void => {
    if (!question || !canConfirmCustom) {
      return;
    }
    void settle({
      questionId: question.id,
      kind: 'answered',
      source: 'custom',
      answer: customAnswer.trim(),
    });
  };

  const skip = (): void => {
    if (!question || state.submitting) {
      return;
    }
    void settle({ questionId: question.id, kind: 'skipped' });
  };

  const cancel = (): void => {
    if (state.submitting) {
      return;
    }
    void submit({
      kind: 'cancelled',
      decisions: orderedUserInputDecisions(
        request.questions.map((candidate) => candidate.id),
        state.decisions,
      ),
    });
  };

  const previous = (): void => {
    setState((current) => ({
      ...current,
      questionIndex: Math.max(0, current.questionIndex - 1),
      error: null,
    }));
  };

  const next = (): void => {
    setState((current) => ({
      ...current,
      questionIndex: Math.min(
        request.questions.length - 1,
        current.questionIndex + 1,
      ),
      error: null,
    }));
  };

  return {
    question,
    questionIndex: state.questionIndex,
    questionCount: request.questions.length,
    currentSelection,
    customAnswer,
    canConfirmCustom,
    submitting: state.submitting,
    error: state.error,
    answerTooLong,
    selectOption,
    setCustomAnswer,
    confirmCustomAnswer,
    skip,
    cancel,
    previous,
    next,
  };
};
