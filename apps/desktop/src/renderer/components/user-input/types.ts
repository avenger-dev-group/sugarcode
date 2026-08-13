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
  kind: 'answered';
  source: 'option' | 'custom';
  answer: string;
}> | Readonly<{
  questionId: string;
  kind: 'skipped';
}>;

export type UserInputSubmission =
  | Readonly<{
      kind: 'submitted';
      decisions: readonly UserInputAnswer[];
    }>
  | Readonly<{
      kind: 'cancelled';
      decisions: readonly UserInputAnswer[];
    }>;

export type UserInputActivityViewModel = Readonly<{
  id: string;
  questions: readonly UserInputQuestionViewModel[];
  state: 'awaiting' | 'submitted' | 'cancelled' | 'interrupted';
  decisions: readonly UserInputAnswer[];
}>;

export type UserInputSurfaceProps = Readonly<{
  turnId: string;
  request: UserInputRequestViewModel;
  onSubmit: (
    turnId: string,
    inputRequestId: string,
    submission: UserInputSubmission,
  ) => Promise<boolean>;
}>;

export type UserInputDraftState = Readonly<{
  questionIndex: number;
  decisions: Readonly<Record<string, UserInputAnswer>>;
  customAnswers: Readonly<Record<string, string>>;
  submitting: boolean;
  error: string | null;
}>;
