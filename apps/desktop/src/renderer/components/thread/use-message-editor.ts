import { useEffect, useMemo, useState } from 'react';

import { reviseConversationTurn } from '@/renderer/services/conversation';
import type {
  ConversationPhase,
  ConversationTurn,
} from '@/shared/conversation';
import type { ModelRequestOptions } from '@/shared/model-config';

import {
  isSameEditableMessageTarget,
  latestEditableMessageTarget,
} from './message-edit';
import type { ThreadStore, ThreadViewModel } from './types';

type UseMessageEditorOptions = Readonly<{
  threadId?: string;
  turns: readonly ConversationTurn[];
  thread: ThreadViewModel;
  phase: ConversationPhase;
  isSending: boolean;
  selectedModelProfileId: string;
  selectedModelRequest: ModelRequestOptions;
}>;

export const useMessageEditor = ({
  threadId,
  turns,
  thread,
  phase,
  isSending,
  selectedModelProfileId,
  selectedModelRequest,
}: UseMessageEditorOptions): Readonly<{
  editableMessageTarget: ThreadStore['editableMessageTarget'];
  messageEditor: ThreadStore['messageEditor'];
  active: boolean;
  beginMessageEdit: ThreadStore['beginMessageEdit'];
  setMessageEditDraft: ThreadStore['setMessageEditDraft'];
  cancelMessageEdit: ThreadStore['cancelMessageEdit'];
  submitMessageEdit: ThreadStore['submitMessageEdit'];
}> => {
  const [turnId, setTurnId] = useState<string | null>(null);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editableMessageTarget = useMemo(
    () => latestEditableMessageTarget(thread.turns, phase, isSending),
    [isSending, phase, thread.turns],
  );

  useEffect(() => {
    setTurnId(null);
    setMessageId(null);
    setDraft('');
    setPending(false);
    setError(null);
  }, [threadId]);

  useEffect(() => {
    if (!turnId || !messageId || pending) {
      return;
    }
    if (
      isSameEditableMessageTarget(
        { turnId, messageId },
        editableMessageTarget,
      )
    ) {
      return;
    }
    setTurnId(null);
    setMessageId(null);
    setDraft('');
    setError(null);
  }, [editableMessageTarget, messageId, pending, turnId]);

  const beginMessageEdit: ThreadStore['beginMessageEdit'] = (
    nextTurnId,
    nextMessageId,
    text,
  ) => {
    if (
      !isSameEditableMessageTarget(
        { turnId: nextTurnId, messageId: nextMessageId },
        editableMessageTarget,
      )
    ) {
      return;
    }
    setTurnId(nextTurnId);
    setMessageId(nextMessageId);
    setDraft(text);
    setError(null);
  };

  const setMessageEditDraft = (value: string): void => {
    setDraft(value);
    setError(null);
  };

  const cancelMessageEdit = (): void => {
    if (pending) {
      return;
    }
    setTurnId(null);
    setMessageId(null);
    setDraft('');
    setError(null);
  };

  const submitMessageEdit = async (): Promise<void> => {
    if (
      !threadId ||
      !turnId ||
      !messageId ||
      pending ||
      !isSameEditableMessageTarget(
        { turnId, messageId },
        editableMessageTarget,
      )
    ) {
      return;
    }
    const targetTurn = turns.find((turn) => turn.id === turnId);
    const userMessage = targetTurn?.messages.find(
      (message) => message.role === 'user' && message.id === messageId,
    );
    if (
      !userMessage ||
      (draft.trim().length === 0 &&
        (userMessage.attachments?.length ?? 0) === 0)
    ) {
      setError('消息不能为空。');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await reviseConversationTurn({
        threadId,
        turnId,
        text: draft,
        ...(selectedModelProfileId
          ? { modelProfileId: selectedModelProfileId }
          : {}),
        modelRequest: selectedModelRequest,
      });
      if (result.accepted) {
        setTurnId(null);
        setMessageId(null);
        setDraft('');
        return;
      }
      setError(
        result.reason === 'notLatestTurn'
          ? '这条消息已不是最后一轮，无法重新发送。'
          : result.reason === 'turnActive'
            ? 'Agent 正在运行，请等待当前任务结束。'
            : result.reason === 'invalidInput'
              ? '消息内容无效，请调整后重试。'
              : '消息未能重新发送，请重试。',
      );
    } catch {
      setError('消息未能安全地重新发送，请重试。');
    } finally {
      setPending(false);
    }
  };

  return {
    editableMessageTarget,
    messageEditor: { turnId, messageId, draft, pending, error },
    active: turnId !== null,
    beginMessageEdit,
    setMessageEditDraft,
    cancelMessageEdit,
    submitMessageEdit,
  };
};
