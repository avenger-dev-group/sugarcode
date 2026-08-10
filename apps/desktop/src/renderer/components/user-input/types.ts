export type UserInputOptionViewModel = Readonly<{
  label: string;
  description: string;
}>;

export type UserInputQuestionViewModel = Readonly<{
  id: string;
  header: string;
  question: string;
  options: readonly UserInputOptionViewModel[];
}>;

export type UserInputRequestViewModel = Readonly<{
  id: string;
  questions: readonly UserInputQuestionViewModel[];
}>;

export type UserInputAnswer = Readonly<{
  questionId: string;
  answer: string;
}>;

export type UserInputSurfaceProps = Readonly<{
  turnId: string;
  request: UserInputRequestViewModel;
  onSubmit: (
    turnId: string,
    inputRequestId: string,
    answers: readonly UserInputAnswer[],
  ) => Promise<boolean>;
}>;

export type UserInputDraftState = Readonly<{
  questionIndex: number;
  answers: Readonly<Record<string, string>>;
  selectedOptions: Readonly<Record<string, string>>;
  submitting: boolean;
  error: string | null;
}>;
