import {
  MAX_CONVERSATION_ATTACHMENTS,
  MAX_CONVERSATION_INPUT_BYTES,
  MAX_CONVERSATION_TITLE_BYTES,
  MAX_THREAD_SEARCH_BYTES,
  MAX_USER_INPUT_ANSWER_BYTES,
  MAX_USER_INPUT_QUESTIONS,
} from '../limits.ts';
import type {
  ConversationAttachmentUpload,
  ConversationUserInputResponse,
} from '../activities.ts';
import type {
  ConversationActionResult,
  ConversationReviseTurnRequest,
  ConversationSendRequest,
} from '../api.ts';
import { hasBoundedText, isId, isRecord } from './primitives.ts';

const ACTION_REASONS = new Set<ConversationActionResult['reason']>([
  'accepted',
  'invalidInput',
  'invalidSearch',
  'notLatestTurn',
  'unknownThread',
  'turnActive',
  'unavailable',
  'noActiveTurn',
]);
export const isConversationActionResult = (
  value: unknown,
): value is ConversationActionResult =>
  isRecord(value) &&
  typeof value.accepted === 'boolean' &&
  typeof value.reason === 'string' &&
  ACTION_REASONS.has(value.reason as ConversationActionResult['reason']) &&
  value.accepted === (value.reason === 'accepted');

export const isValidConversationInput = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  new TextEncoder().encode(value).byteLength <= MAX_CONVERSATION_INPUT_BYTES;

export const isConversationSendRequest = (
  value: unknown,
): value is ConversationSendRequest =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['input', 'attachments', 'modelProfileId'].includes(key),
  ) &&
  typeof value.input === 'string' &&
  new TextEncoder().encode(value.input).byteLength <=
    MAX_CONVERSATION_INPUT_BYTES &&
  (value.input.trim().length > 0 ||
    (Array.isArray(value.attachments) && value.attachments.length > 0)) &&
  (value.attachments === undefined ||
    (Array.isArray(value.attachments) &&
      value.attachments.length <= MAX_CONVERSATION_ATTACHMENTS &&
      value.attachments.every(isConversationAttachmentUpload))) &&
  (value.modelProfileId === undefined ||
    (typeof value.modelProfileId === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/u.test(value.modelProfileId)));

export const isConversationReviseTurnRequest = (
  value: unknown,
): value is ConversationReviseTurnRequest =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['threadId', 'turnId', 'text', 'modelProfileId'].includes(key),
  ) &&
  isId(value.threadId) &&
  isId(value.turnId) &&
  typeof value.text === 'string' &&
  new TextEncoder().encode(value.text).byteLength <=
    MAX_CONVERSATION_INPUT_BYTES &&
  (value.modelProfileId === undefined ||
    (typeof value.modelProfileId === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/u.test(value.modelProfileId)));

export const isConversationUserInputResponse = (
  value: unknown,
): value is ConversationUserInputResponse =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['threadId', 'turnId', 'inputRequestId', 'submission'].includes(key),
  ) &&
  isId(value.threadId) &&
  isId(value.turnId) &&
  isId(value.inputRequestId) &&
  isRecord(value.submission) &&
  (value.submission.kind === 'submitted' ||
    value.submission.kind === 'cancelled') &&
  Object.keys(value.submission).every((key) =>
    ['kind', 'decisions'].includes(key),
  ) &&
  Array.isArray(value.submission.decisions) &&
  value.submission.decisions.length <= MAX_USER_INPUT_QUESTIONS &&
  (value.submission.kind === 'cancelled' ||
    value.submission.decisions.length >= 1) &&
  value.submission.decisions.every(
    (decision) =>
      isRecord(decision) &&
      typeof decision.questionId === 'string' &&
      /^[a-z][a-z0-9_]{0,63}$/u.test(decision.questionId) &&
      (decision.kind === 'skipped'
        ? Object.keys(decision).every((key) =>
            ['questionId', 'kind'].includes(key),
          )
        : decision.kind === 'answered' &&
          (decision.source === 'option' || decision.source === 'custom') &&
          hasBoundedText(decision.answer, MAX_USER_INPUT_ANSWER_BYTES) &&
          Object.keys(decision).every((key) =>
            ['questionId', 'kind', 'source', 'answer'].includes(key),
          )),
  ) &&
  new Set(
    value.submission.decisions.map((decision) => decision.questionId),
  ).size === value.submission.decisions.length;

const isConversationAttachmentUpload = (
  value: unknown,
): value is ConversationAttachmentUpload =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['fileName', 'mediaType', 'data'].includes(key),
  ) &&
  typeof value.fileName === 'string' &&
  value.fileName.length > 0 &&
  value.fileName.length <= 255 &&
  !/[\\/\p{Cc}]/u.test(value.fileName) &&
  (value.mediaType === undefined ||
    (typeof value.mediaType === 'string' && value.mediaType.length <= 127)) &&
  typeof value.data === 'string' &&
  value.data.length > 0 &&
  value.data.length <= 27_962_032;

export const isValidThreadSearchInput = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).byteLength > MAX_THREAD_SEARCH_BYTES ||
    Array.from(value).some((character) => /\p{Cc}/u.test(character))
  ) {
    return false;
  }
  const query = value.trim();
  return query.length === 0 || query.split(/\s+/u).length <= 16;
};

export const isValidConversationTitle = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  new TextEncoder().encode(value).byteLength <= MAX_CONVERSATION_TITLE_BYTES &&
  !Array.from(value).some((character) => /\p{Cc}/u.test(character));
