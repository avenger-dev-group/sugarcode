import { useEffect, useState } from 'react';

import { MAX_USER_INPUT_ANSWER_BYTES } from '@/shared/conversation';

import type { UserInputDraftState, UserInputSurfaceProps } from './types';

export const useStore = ({
  turnId,
  request,
  onSubmit,
}: UserInputSurfaceProps) => {
  const [state, setState] = useState<UserInputDraftState>({
    questionIndex: 0,
    answers: {},
    selectedOptions: {},
    submitting: false,
    error: null,
  });

  useEffect(() => {
    setState({
      questionIndex: 0,
      answers: {},
      selectedOptions: {},
      submitting: false,
      error: null,
    });
  }, [request.id]);

  const question = request.questions[state.questionIndex];
  const currentAnswer = question ? state.answers[question.id] ?? '' : '';
  const currentSelection = question
    ? state.selectedOptions[question.id]
    : undefined;
  const answerTooLong =
    new TextEncoder().encode(currentAnswer).byteLength >
    MAX_USER_INPUT_ANSWER_BYTES;
  const canContinue =
    currentAnswer.trim().length > 0 && !answerTooLong && !state.submitting;
  const isLastQuestion =
    state.questionIndex === request.questions.length - 1;

  const selectOption = (answer: string): void => {
    if (!question) {
      return;
    }
    setState((current) => ({
      ...current,
      answers: { ...current.answers, [question.id]: answer },
      selectedOptions: { ...current.selectedOptions, [question.id]: answer },
      error: null,
    }));
  };

  const setCustomAnswer = (answer: string): void => {
    if (!question) {
      return;
    }
    setState((current) => {
      const selectedOptions = { ...current.selectedOptions };
      delete selectedOptions[question.id];
      return {
        ...current,
        answers: { ...current.answers, [question.id]: answer },
        selectedOptions,
        error: null,
      };
    });
  };

  const previous = (): void => {
    setState((current) => ({
      ...current,
      questionIndex: Math.max(0, current.questionIndex - 1),
      error: null,
    }));
  };

  const next = async (): Promise<void> => {
    if (!question || !canContinue) {
      return;
    }
    if (!isLastQuestion) {
      setState((current) => ({
        ...current,
        questionIndex: current.questionIndex + 1,
        error: null,
      }));
      return;
    }
    const answers = request.questions.map((candidate) => ({
      questionId: candidate.id,
      answer: state.answers[candidate.id]?.trim() ?? '',
    }));
    if (answers.some((answer) => answer.answer.length === 0)) {
      setState((current) => ({
        ...current,
        error: '请先完成每一个问题。',
      }));
      return;
    }
    setState((current) => ({ ...current, submitting: true, error: null }));
    const accepted = await onSubmit(turnId, request.id, answers);
    if (!accepted) {
      setState((current) => ({
        ...current,
        submitting: false,
        error: '回答未能提交，请重试。',
      }));
    }
  };

  return {
    question,
    questionIndex: state.questionIndex,
    questionCount: request.questions.length,
    currentAnswer,
    currentSelection,
    canContinue,
    isLastQuestion,
    submitting: state.submitting,
    error: state.error,
    answerTooLong,
    selectOption,
    setCustomAnswer,
    previous,
    next,
  };
};
