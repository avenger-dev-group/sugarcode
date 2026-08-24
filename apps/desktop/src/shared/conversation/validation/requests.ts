import {
  MAX_CONVERSATION_ATTACHMENTS,
  MAX_CONVERSATION_ATTACHMENT_BASE64_LENGTH,
  MAX_CONVERSATION_ATTACHMENT_PREVIEW_URL_LENGTH,
  MAX_CONVERSATION_INPUT_BYTES,
  MAX_CONVERSATION_TITLE_BYTES,
  MAX_CONVERSATION_VIDEO_BYTES,
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
  ConversationAttachmentPreviewRequest,
  ConversationAttachmentPreviewResult,
  ConversationReviseTurnRequest,
  ConversationQueuedMessageMutationRequest,
  ConversationQueuedMessageUpdateRequest,
  ConversationSteerQueuedMessageRequest,
  ConversationSendRequest,
} from '../api.ts';
import { hasBoundedText, isId, isRecord } from './primitives.ts';
import { isModelRequestOptions } from '../../model-config.ts';

const ACTION_REASONS = new Set<ConversationActionResult['reason']>([
  'accepted',
  'invalidInput',
  'invalidSearch',
  'notLatestTurn',
  'unknownThread',
  'turnActive',
  'queueFull',
  'queueItemNotFound',
  'queueRevisionMismatch',
  'turnMismatch',
  'notSteerable',
  'modelUnavailable',
  'attachmentUnavailable',
  'unavailable',
  'noActiveTurn',
]);
const ATTACHMENT_FAILURES = new Set<
  NonNullable<ConversationActionResult['attachmentFailure']>
>([
  'sourceUnavailable',
  'unsupportedFormat',
  'mediaTypeMismatch',
  'tooLarge',
  'runtimeOutdated',
  'storageUnavailable',
  'unknown',
]);
export const isConversationActionResult = (
  value: unknown,
): value is ConversationActionResult =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    [
      'accepted',
      'reason',
      'disposition',
      'queueItemId',
      'attachmentFailure',
    ].includes(key),
  ) &&
  typeof value.accepted === 'boolean' &&
  typeof value.reason === 'string' &&
  ACTION_REASONS.has(value.reason as ConversationActionResult['reason']) &&
  value.accepted === (value.reason === 'accepted') &&
  (value.disposition === undefined ||
    value.disposition === 'started' ||
    value.disposition === 'queued') &&
  (value.queueItemId === undefined || isId(value.queueItemId)) &&
  (value.disposition !== 'queued' || isId(value.queueItemId)) &&
  (value.attachmentFailure === undefined ||
    (value.reason === 'attachmentUnavailable' &&
      typeof value.attachmentFailure === 'string' &&
      ATTACHMENT_FAILURES.has(
        value.attachmentFailure as NonNullable<
          ConversationActionResult['attachmentFailure']
        >,
      )));

export const isConversationAttachmentPreviewRequest = (
  value: unknown,
): value is ConversationAttachmentPreviewRequest =>
  isRecord(value) &&
  Object.keys(value).every((key) => ['threadId', 'assetId'].includes(key)) &&
  isId(value.threadId) &&
  typeof value.assetId === 'string' &&
  /^ast_[0-9a-f]{64}$/u.test(value.assetId);

export const isConversationAttachmentPreviewResult = (
  value: unknown,
): value is ConversationAttachmentPreviewResult =>
  isRecord(value) &&
  typeof value.available === 'boolean' &&
  (value.available
    ? Object.keys(value).every((key) =>
        ['available', 'assetId', 'previewUrl'].includes(key),
      ) &&
      typeof value.assetId === 'string' &&
      /^ast_[0-9a-f]{64}$/u.test(value.assetId) &&
      typeof value.previewUrl === 'string' &&
      /^data:image\/[A-Za-z0-9.+-]+;base64,/u.test(value.previewUrl) &&
      value.previewUrl.length <= MAX_CONVERSATION_ATTACHMENT_PREVIEW_URL_LENGTH
    : Object.keys(value).every((key) =>
        ['available', 'reason'].includes(key),
      ) &&
      [
        'invalid',
        'notFound',
        'unsupported',
        'tooLarge',
        'unavailable',
      ].includes(String(value.reason)));

export const isValidConversationInput = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  new TextEncoder().encode(value).byteLength <= MAX_CONVERSATION_INPUT_BYTES;

export const isConversationSendRequest = (
  value: unknown,
): value is ConversationSendRequest =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['input', 'attachments', 'modelProfileId', 'modelRequest'].includes(key),
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
      /^[A-Za-z0-9_-]{1,64}$/u.test(value.modelProfileId))) &&
  (value.modelRequest === undefined ||
    isModelRequestOptions(value.modelRequest));

export const isConversationReviseTurnRequest = (
  value: unknown,
): value is ConversationReviseTurnRequest =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['threadId', 'turnId', 'text', 'modelProfileId', 'modelRequest'].includes(key),
  ) &&
  isId(value.threadId) &&
  isId(value.turnId) &&
  typeof value.text === 'string' &&
  new TextEncoder().encode(value.text).byteLength <=
    MAX_CONVERSATION_INPUT_BYTES &&
  (value.modelProfileId === undefined ||
    (typeof value.modelProfileId === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/u.test(value.modelProfileId))) &&
  (value.modelRequest === undefined ||
    isModelRequestOptions(value.modelRequest));

export const isConversationQueuedMessageMutationRequest = (
  value: unknown,
): value is ConversationQueuedMessageMutationRequest =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['threadId', 'queueItemId', 'expectedRevision'].includes(key),
  ) &&
  isId(value.threadId) &&
  isId(value.queueItemId) &&
  Number.isSafeInteger(value.expectedRevision) &&
  Number(value.expectedRevision) >= 1;

export const isConversationQueuedMessageUpdateRequest = (
  value: unknown,
): value is ConversationQueuedMessageUpdateRequest =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    [
      'threadId',
      'queueItemId',
      'expectedRevision',
      'input',
      'modelProfileId',
      'modelRequest',
    ].includes(key),
  ) &&
  isId(value.threadId) &&
  isId(value.queueItemId) &&
  Number.isSafeInteger(value.expectedRevision) &&
  Number(value.expectedRevision) >= 1 &&
  isValidConversationInput(value.input) &&
  (value.modelProfileId === undefined ||
    (typeof value.modelProfileId === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/u.test(value.modelProfileId))) &&
  (value.modelRequest === undefined ||
    isModelRequestOptions(value.modelRequest));

export const isConversationSteerQueuedMessageRequest = (
  value: unknown,
): value is ConversationSteerQueuedMessageRequest =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['threadId', 'queueItemId', 'expectedRevision', 'expectedTurnId'].includes(
      key,
    ),
  ) &&
  isId(value.threadId) &&
  isId(value.queueItemId) &&
  isId(value.expectedTurnId) &&
  Number.isSafeInteger(value.expectedRevision) &&
  Number(value.expectedRevision) >= 1;

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
  new Set(value.submission.decisions.map((decision) => decision.questionId))
    .size === value.submission.decisions.length;

const isConversationAttachmentUpload = (
  value: unknown,
): value is ConversationAttachmentUpload =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['fileName', 'mediaType', 'data', 'localPath', 'sizeBytes'].includes(key),
  ) &&
  typeof value.fileName === 'string' &&
  value.fileName.length > 0 &&
  value.fileName.length <= 255 &&
  !/[\\/\p{Cc}]/u.test(value.fileName) &&
  (value.mediaType === undefined ||
    (typeof value.mediaType === 'string' && value.mediaType.length <= 127)) &&
  ((typeof value.data === 'string' &&
    value.data.length > 0 &&
    value.data.length <= MAX_CONVERSATION_ATTACHMENT_BASE64_LENGTH &&
    value.localPath === undefined &&
    value.sizeBytes === undefined) ||
    (typeof value.localPath === 'string' &&
      value.localPath.length > 0 &&
      value.localPath.length <= 32_768 &&
      !/[\p{Cc}]/u.test(value.localPath) &&
      typeof value.sizeBytes === 'number' &&
      Number.isSafeInteger(value.sizeBytes) &&
      value.sizeBytes > 0 &&
      value.sizeBytes <= MAX_CONVERSATION_VIDEO_BYTES &&
      value.data === undefined &&
      typeof value.mediaType === 'string' &&
      value.mediaType.startsWith('video/')));

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
