import { randomUUID } from 'node:crypto';
import {
  isConversationUserInputResponse,
  type ConversationActionResult,
  type ConversationUserInputResponse,
} from '../../../../shared/conversation.ts';
import type { ConversationServices } from '../services.ts';
import type { ConversationState } from '../state.ts';
import {
  accepted,
  rejected,
} from '../action-result.ts';

type Context = Pick<
  ConversationServices,
  | 'state'
  | 'goals'
  | 'runtime'
  | 'publishThreadDelta'
  | 'publish'
>;

export class ConversationTurnControls {
  private readonly state: ConversationState;
  private readonly context: Context;

  constructor(context: Context) {
    this.state = context.state;
    this.context = context;
  }

  stopTurn = async (threadId: unknown): Promise<ConversationActionResult> => {
    if (typeof threadId !== 'string' || threadId !== this.state.threadId) {
      return rejected('unknownThread');
    }
    const activeTurn = this.state.activeTurnsByThread.get(threadId);
    if (!this.state.workspaceId || !activeTurn) {
      return rejected('noActiveTurn');
    }
    this.state.activeTurnsByThread.set(threadId, {
      ...activeTurn,
      phase: 'stopping',
    });
    if (activeTurn.goalId) {
      try {
        await this.context.goals.pause(
          activeTurn.workspaceId,
          threadId,
          'user',
        );
      } catch {
        return rejected('goalRevisionMismatch');
      }
    }
    this.context.runtime.send({
      type: 'turn.cancel',
      requestId: randomUUID(),
      workspaceId: activeTurn.workspaceId,
      threadId,
      turnId: activeTurn.turnId,
      source: 'stopButton',
    });
    this.context.publishThreadDelta(threadId, activeTurn.turnId);
    this.context.publish();
    return accepted();
  };

  respondToUserInput = async (
    input: unknown,
  ): Promise<ConversationActionResult> => {
    if (!isConversationUserInputResponse(input)) {
      return rejected('invalidInput');
    }
    const activeTurn = this.state.activeTurnsByThread.get(input.threadId);
    const turn = this.state.turnsByThread
      .get(input.threadId)
      ?.find((candidate) => candidate.id === input.turnId);
    if (
      !activeTurn ||
      activeTurn.turnId !== input.turnId ||
      turn?.userInputRequest?.id !== input.inputRequestId
    ) {
      return rejected('noActiveTurn');
    }
    const questions = turn.userInputRequest.questions;
    const questionIds = questions.map((question) => question.id);
    const decisionIds = new Set(
      input.submission.decisions.map((decision) => decision.questionId),
    );
    const questionById = new Map(
      questions.map((question) => [question.id, question]),
    );
    const decisionsValid = input.submission.decisions.every((decision) => {
      const question = questionById.get(decision.questionId);
      return Boolean(
        question &&
        (decision.kind !== 'answered' ||
          decision.source !== 'option' ||
          question.options.some((option) => option.label === decision.answer)),
      );
    });
    if (
      !decisionsValid ||
      (input.submission.kind === 'submitted' &&
        (questionIds.length !== input.submission.decisions.length ||
          !questionIds.every((id) => decisionIds.has(id))))
    ) {
      return rejected('invalidInput');
    }
    const response: ConversationUserInputResponse = input;
    this.context.runtime.send({
      type: 'turn.userInputResponse',
      requestId: randomUUID(),
      workspaceId: activeTurn.workspaceId,
      threadId: response.threadId,
      turnId: response.turnId,
      inputRequestId: response.inputRequestId,
      submission: response.submission,
    });
    return accepted();
  };
}
