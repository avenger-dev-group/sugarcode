import {
  MAX_CONVERSATION_ATTACHMENTS,
  MAX_FILE_CHANGE_DIFF_BYTES,
  MAX_FILE_CHANGE_DIFF_LINES,
  MAX_USER_INPUT_OPTIONS,
  MAX_USER_INPUT_QUESTIONS,
} from '../limits.ts';
import type {
  ConversationAttachment,
  ConversationCommandApprovalActivity,
  ConversationCommandApprovalDecision,
  ConversationCommandExecutionResultOutcome,
  ConversationFileChangeActivity,
  ConversationFileChangeProposal,
  ConversationFileChangeResultOutcome,
  ConversationMcpActivity,
  ConversationMcpResultReceipt,
  ConversationMessage,
  ConversationMessageStatus,
  ConversationTurnError,
  ConversationUserInputQuestion,
  ConversationUserInputRequest,
  ConversationWorkspaceListActivity,
  ConversationWorkspaceListOutcome,
  ConversationWorkspaceReadActivity,
  ConversationWorkspaceReadOutcome,
  ConversationWorkspaceSearchActivity,
  ConversationWorkspaceSearchOutcome,
} from '../activities.ts';
import { hasBoundedText, isId, isRecord } from './primitives.ts';

const MESSAGE_STATUSES = new Set<ConversationMessageStatus>([
  'inProgress',
  'completed',
]);

const ERROR_KINDS = new Set<ConversationTurnError['kind']>([
  'authentication',
  'contextWindowExceeded',
  'invalidRequest',
  'rateLimited',
  'timeout',
  'transport',
  'disconnected',
  'server',
  'protocol',
  'incomplete',
  'filtered',
  'unsupportedOutput',
  'unsupportedToolArguments',
  'providerRequestTooLarge',
  'providerResponseTooLarge',
  'outputTooLarge',
  'stateUnavailable',
]);

const PROTOCOL_STAGES = new Set<
  NonNullable<ConversationTurnError['protocol']>['stage']
>([
  'streamEvent',
  'responseAssembly',
  'outputNormalization',
  'runtimeClassification',
]);

const PROTOCOL_CODES = new Set<
  NonNullable<ConversationTurnError['protocol']>['code']
>([
  'wireMismatch',
  'invalidEventShape',
  'ambiguousOutputReconciliation',
  'malformedToolCall',
  'terminalLifecycleViolation',
  'continuationOutputMismatch',
  'outputIndexMismatch',
]);
const COMMAND_APPROVAL_DECISIONS = new Set<ConversationCommandApprovalDecision>(
  [
    'approved',
    'denied',
    'timedOut',
    'unsupported',
    'cancelled',
    'clientDisconnected',
  ],
);
const isUserInputQuestion = (
  value: unknown,
): value is ConversationUserInputQuestion =>
  isRecord(value) &&
  Object.keys(value).every((key) =>
    ['id', 'header', 'question', 'options'].includes(key),
  ) &&
  typeof value.id === 'string' &&
  /^[a-z][a-z0-9_]{0,63}$/u.test(value.id) &&
  hasBoundedText(value.header, 48) &&
  Array.from(value.header as string).length <= 12 &&
  hasBoundedText(value.question, 512) &&
  Array.isArray(value.options) &&
  value.options.length >= 2 &&
  value.options.length <= MAX_USER_INPUT_OPTIONS &&
  value.options.every(
    (option) =>
      isRecord(option) &&
      Object.keys(option).every((key) =>
        ['label', 'description'].includes(key),
      ) &&
      hasBoundedText(option.label, 96) &&
      hasBoundedText(option.description, 384),
  ) &&
  new Set(
    value.options.map((option) =>
      isRecord(option) ? option.label : undefined,
    ),
  ).size === value.options.length;

export const isUserInputRequest = (
  value: unknown,
): value is ConversationUserInputRequest =>
  isRecord(value) &&
  Object.keys(value).every((key) => ['id', 'questions'].includes(key)) &&
  isId(value.id) &&
  Array.isArray(value.questions) &&
  value.questions.length >= 1 &&
  value.questions.length <= MAX_USER_INPUT_QUESTIONS &&
  value.questions.every(isUserInputQuestion) &&
  new Set(value.questions.map((question) => question.id)).size ===
    value.questions.length;

export const isValidSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

export const isValidFileChangePath = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 1_024 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[a-z]:[\\/]/iu.test(value) ||
    Array.from(value).some((character) => /\p{Cc}/u.test(character))
  ) {
    return false;
  }
  const components = value.split(/[\\/]/u);
  return (
    components.length <= 64 &&
    components.every(
      (component) =>
        component.length > 0 && component !== '.' && component !== '..',
    )
  );
};

export const isValidFileChangeDiff = (
  value: unknown,
  path: string,
  kind: ConversationFileChangeProposal['kind'] = 'update',
): value is string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !value.endsWith('\n') ||
    value.includes('\r') ||
    new TextEncoder().encode(value).byteLength > MAX_FILE_CHANGE_DIFF_BYTES
  ) {
    return false;
  }
  const lines = value.slice(0, -1).split('\n');
  if (
    lines.length > MAX_FILE_CHANGE_DIFF_LINES ||
    lines[0] !== (kind === 'create' ? '--- /dev/null' : `--- a/${path}`) ||
    lines[1] !== (kind === 'delete' ? '+++ /dev/null' : `+++ b/${path}`)
  ) {
    return false;
  }
  let index = 2;
  let hunks = 0;
  while (index < lines.length) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/u.exec(
      lines[index] ?? '',
    );
    if (!header) {
      return false;
    }
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = Number(header[4]);
    if (
      !Number.isSafeInteger(oldStart) ||
      !Number.isSafeInteger(oldCount) ||
      !Number.isSafeInteger(newStart) ||
      !Number.isSafeInteger(newCount) ||
      oldStart > 256 * 1024 + 1 ||
      oldCount > 20_000 ||
      newStart > 256 * 1024 + 1 ||
      newCount > 20_000
    ) {
      return false;
    }
    index += 1;
    let observedOld = 0;
    let observedNew = 0;
    while (index < lines.length && !lines[index]?.startsWith('@@ ')) {
      const line = lines[index] ?? '';
      if (line.startsWith(' ')) {
        observedOld += 1;
        observedNew += 1;
      } else if (line.startsWith('-')) {
        observedOld += 1;
      } else if (line.startsWith('+')) {
        observedNew += 1;
      } else {
        return false;
      }
      index += 1;
    }
    if (observedOld !== oldCount || observedNew !== newCount) {
      return false;
    }
    hunks += 1;
  }
  return hunks > 0 || (lines.length === 2 && kind !== 'update');
};

export const isTurnError = (value: unknown): value is ConversationTurnError =>
  isRecord(value) &&
  typeof value.kind === 'string' &&
  ERROR_KINDS.has(value.kind as ConversationTurnError['kind']) &&
  typeof value.retryable === 'boolean' &&
  (value.protocol === undefined ||
    (isRecord(value.protocol) &&
      typeof value.protocol.stage === 'string' &&
      PROTOCOL_STAGES.has(
        value.protocol.stage as NonNullable<
          ConversationTurnError['protocol']
        >['stage'],
      ) &&
      typeof value.protocol.code === 'string' &&
      PROTOCOL_CODES.has(
        value.protocol.code as NonNullable<
          ConversationTurnError['protocol']
        >['code'],
      ) &&
      (value.protocol.eventType === undefined ||
        (typeof value.protocol.eventType === 'string' &&
          /^[A-Za-z0-9_./-]{1,128}$/.test(value.protocol.eventType))) &&
      typeof value.protocol.shapeSha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(value.protocol.shapeSha256)));

export const isMessage = (value: unknown): value is ConversationMessage =>
  isRecord(value) &&
  isId(value.id) &&
  (value.role === 'user' || value.role === 'agent') &&
  typeof value.text === 'string' &&
  typeof value.status === 'string' &&
  MESSAGE_STATUSES.has(value.status as ConversationMessageStatus) &&
  (value.attachments === undefined ||
    (Array.isArray(value.attachments) &&
      value.attachments.length <= MAX_CONVERSATION_ATTACHMENTS &&
      value.attachments.every(isConversationAttachment)));

const isConversationAttachment = (
  value: unknown,
): value is ConversationAttachment =>
  isRecord(value) &&
  typeof value.assetId === 'string' &&
  typeof value.sha256 === 'string' &&
  typeof value.mediaType === 'string' &&
  typeof value.originalName === 'string' &&
  typeof value.sizeBytes === 'number' &&
  Number.isSafeInteger(value.sizeBytes) &&
  value.sizeBytes > 0 &&
  (value.kind === 'image' || value.kind === 'pdf' || value.kind === 'text') &&
  (value.pdfPages === undefined ||
    (value.kind === 'pdf' &&
      Number.isSafeInteger(value.pdfPages) &&
      Number(value.pdfPages) > 0)) &&
  (value.previewUrl === undefined ||
    (value.kind === 'image' &&
      typeof value.previewUrl === 'string' &&
      value.previewUrl.startsWith(`data:${value.mediaType};base64,`) &&
      value.previewUrl.length <= 12 * 1024 * 1024));

const isWorkspaceReadOutcome = (
  value: unknown,
): value is ConversationWorkspaceReadOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'success') {
    return (
      typeof value.bytes === 'number' &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes >= 0
    );
  }
  return (
    value.type === 'error' &&
    typeof value.kind === 'string' &&
    value.kind.length > 0
  );
};

export const isWorkspaceReadActivity = (
  value: unknown,
): value is ConversationWorkspaceReadActivity => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'result')) {
    return true;
  }
  return (
    value.callStatus === 'completed' &&
    isRecord(value.result) &&
    isId(value.result.id) &&
    value.result.id !== value.id &&
    typeof value.result.status === 'string' &&
    MESSAGE_STATUSES.has(value.result.status as ConversationMessageStatus) &&
    isWorkspaceReadOutcome(value.result.outcome)
  );
};

const isWorkspaceListOutcome = (
  value: unknown,
): value is ConversationWorkspaceListOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'success') {
    return (
      typeof value.entries === 'number' &&
      Number.isSafeInteger(value.entries) &&
      value.entries >= 0 &&
      value.entries <= 1_000
    );
  }
  return (
    value.type === 'error' &&
    typeof value.kind === 'string' &&
    value.kind.length > 0
  );
};

export const isWorkspaceListActivity = (
  value: unknown,
): value is ConversationWorkspaceListActivity => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'result')) {
    return true;
  }
  return (
    value.callStatus === 'completed' &&
    isRecord(value.result) &&
    isId(value.result.id) &&
    value.result.id !== value.id &&
    typeof value.result.status === 'string' &&
    MESSAGE_STATUSES.has(value.result.status as ConversationMessageStatus) &&
    isWorkspaceListOutcome(value.result.outcome)
  );
};

const isWorkspaceSearchOutcome = (
  value: unknown,
): value is ConversationWorkspaceSearchOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'success') {
    return (
      typeof value.matches === 'number' &&
      Number.isSafeInteger(value.matches) &&
      value.matches >= 0 &&
      value.matches <= 200 &&
      typeof value.truncated === 'boolean'
    );
  }
  return (
    value.type === 'error' &&
    typeof value.kind === 'string' &&
    value.kind.length > 0
  );
};

export const isWorkspaceSearchActivity = (
  value: unknown,
): value is ConversationWorkspaceSearchActivity => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    typeof value.query !== 'string' ||
    value.query.length === 0 ||
    new TextEncoder().encode(value.query).byteLength > 256 ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'result')) {
    return true;
  }
  return (
    value.callStatus === 'completed' &&
    isRecord(value.result) &&
    isId(value.result.id) &&
    value.result.id !== value.id &&
    typeof value.result.status === 'string' &&
    MESSAGE_STATUSES.has(value.result.status as ConversationMessageStatus) &&
    isWorkspaceSearchOutcome(value.result.outcome)
  );
};

const isFileChangeResultOutcome = (
  value: unknown,
): value is ConversationFileChangeResultOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'error') {
    return (
      Object.keys(value).length === 2 &&
      typeof value.kind === 'string' &&
      value.kind.length > 0
    );
  }
  if (
    value.type === 'success' &&
    Object.keys(value).length === 2 &&
    Array.isArray(value.files)
  ) {
    return (
      value.files.length > 0 &&
      value.files.length <= 64 &&
      value.files.every(
        (receipt) =>
          isRecord(receipt) &&
          Object.keys(receipt).length === 6 &&
          isValidFileChangePath(receipt.path) &&
          (receipt.kind === 'create' ||
            receipt.kind === 'update' ||
            receipt.kind === 'delete') &&
          isValidSha256(receipt.beforeSha256) &&
          isValidSha256(receipt.afterSha256) &&
          typeof receipt.beforeBytes === 'number' &&
          Number.isSafeInteger(receipt.beforeBytes) &&
          receipt.beforeBytes >= 0 &&
          receipt.beforeBytes <= 256 * 1024 &&
          typeof receipt.afterBytes === 'number' &&
          Number.isSafeInteger(receipt.afterBytes) &&
          receipt.afterBytes >= 0 &&
          receipt.afterBytes <= 256 * 1024,
      )
    );
  }
  return (
    value.type === 'success' &&
    Object.keys(value).length === 6 &&
    isValidFileChangePath(value.path) &&
    isValidSha256(value.beforeSha256) &&
    isValidSha256(value.afterSha256) &&
    typeof value.beforeBytes === 'number' &&
    Number.isSafeInteger(value.beforeBytes) &&
    value.beforeBytes >= 0 &&
    value.beforeBytes <= 256 * 1024 &&
    typeof value.afterBytes === 'number' &&
    Number.isSafeInteger(value.afterBytes) &&
    value.afterBytes >= 0 &&
    value.afterBytes <= 256 * 1024
  );
};

export const isFileChangeActivity = (
  value: unknown,
): value is ConversationFileChangeActivity => {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    !isValidFileChangePath(value.path) ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  const change = value.change;
  const validProposal = (proposal: unknown): proposal is ConversationFileChangeProposal =>
    isRecord(proposal) &&
    isId(proposal.id) &&
    proposal.id !== value.id &&
    typeof proposal.status === 'string' &&
    MESSAGE_STATUSES.has(proposal.status as ConversationMessageStatus) &&
    isValidFileChangePath(proposal.path) &&
    (proposal.kind === 'create' || proposal.kind === 'update' || proposal.kind === 'delete') &&
    isValidFileChangeDiff(proposal.diff, proposal.path, proposal.kind) &&
    isValidSha256(proposal.beforeSha256) &&
    isValidSha256(proposal.afterSha256) &&
    typeof proposal.beforeBytes === 'number' &&
    Number.isSafeInteger(proposal.beforeBytes) &&
    proposal.beforeBytes >= 0 &&
    proposal.beforeBytes <= 256 * 1024 &&
    typeof proposal.afterBytes === 'number' &&
    Number.isSafeInteger(proposal.afterBytes) &&
    proposal.afterBytes >= 0 &&
    proposal.afterBytes <= 256 * 1024 &&
    (proposal.newlineStyle === 'lf' || proposal.newlineStyle === 'crLf') &&
    typeof proposal.finalNewline === 'boolean';
  if (
    change !== undefined &&
    (!validProposal(change) || change.path !== value.path)
  ) {
    return false;
  }
  const changes = value.changes;
  if (
    changes !== undefined &&
    (!Array.isArray(changes) ||
      changes.length > 64 ||
      changes.some((proposal) => !validProposal(proposal)) ||
      new Set(changes.map((proposal) => (proposal as ConversationFileChangeProposal).path)).size !==
        changes.length)
  ) {
    return false;
  }
  const result = value.result;
  if (
    result !== undefined &&
    (!isRecord(result) ||
      !isId(result.id) ||
      result.id === value.id ||
      result.id ===
        (change as ConversationFileChangeProposal | undefined)?.id ||
      typeof result.status !== 'string' ||
      !MESSAGE_STATUSES.has(result.status as ConversationMessageStatus) ||
      !isFileChangeResultOutcome(result.outcome))
  ) {
    return false;
  }
  const parsedResult = result as
    ConversationFileChangeActivity['result'] | undefined;
  const parsedChange = change as ConversationFileChangeProposal | undefined;
  if (
    parsedResult?.outcome.type === 'success' &&
    !('files' in parsedResult.outcome) &&
    (!parsedChange ||
      parsedResult.outcome.path !== parsedChange.path ||
      parsedResult.outcome.beforeSha256 !== parsedChange.beforeSha256 ||
      parsedResult.outcome.afterSha256 !== parsedChange.afterSha256 ||
      parsedResult.outcome.beforeBytes !== parsedChange.beforeBytes ||
      parsedResult.outcome.afterBytes !== parsedChange.afterBytes)
  ) {
    return false;
  }
  if (
    parsedResult?.outcome.type === 'success' &&
    'files' in parsedResult.outcome &&
    (!Array.isArray(changes) || parsedResult.outcome.files.length !== changes.length)
  ) {
    return false;
  }
  return true;
};

const isCommandExecutionResultOutcome = (
  value: unknown,
): value is ConversationCommandExecutionResultOutcome => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'error') {
    return (
      Object.keys(value).length >= 2 &&
      Object.keys(value).length <= 4 &&
      typeof value.kind === 'string' &&
      value.kind.length > 0 &&
      (!Object.hasOwn(value, 'message') ||
        (typeof value.message === 'string' && value.message.length > 0)) &&
      (!Object.hasOwn(value, 'failedPath') ||
        (typeof value.failedPath === 'string' && value.failedPath.length > 0))
    );
  }
  if (value.type === 'workspacePatch') {
    const files = value.files;
    return (
      [2, 3].includes(Object.keys(value).length) &&
      typeof value.filesChanged === 'number' &&
      Number.isSafeInteger(value.filesChanged) &&
      value.filesChanged >= 1 &&
      (!Object.hasOwn(value, 'files') ||
        (Array.isArray(files) &&
          files.length === value.filesChanged &&
          files.every((file) => {
            if (
              !isRecord(file) ||
              ![6, 9].includes(Object.keys(file).length) ||
              typeof file.path !== 'string' ||
              file.path.length === 0 ||
              !['create', 'update', 'delete'].includes(String(file.kind)) ||
              typeof file.beforeSha256 !== 'string' ||
              typeof file.afterSha256 !== 'string' ||
              !Number.isSafeInteger(file.beforeBytes) ||
              (file.beforeBytes as number) < 0 ||
              !Number.isSafeInteger(file.afterBytes) ||
              (file.afterBytes as number) < 0
            ) {
              return false;
            }
            const hasReview = Object.hasOwn(file, 'diff');
            return (
              hasReview === Object.hasOwn(file, 'newlineStyle') &&
              hasReview === Object.hasOwn(file, 'finalNewline') &&
              (!hasReview ||
                (typeof file.diff === 'string' &&
                  (file.newlineStyle === 'lf' ||
                    file.newlineStyle === 'crLf') &&
                  typeof file.finalNewline === 'boolean'))
            );
          })))
    );
  }
  if (
    value.type !== 'process' ||
    ![8, 10].includes(Object.keys(value).length) ||
    typeof value.stdoutBytes !== 'number' ||
    !Number.isSafeInteger(value.stdoutBytes) ||
    value.stdoutBytes < 0 ||
    typeof value.stderrBytes !== 'number' ||
    !Number.isSafeInteger(value.stderrBytes) ||
    value.stderrBytes < 0 ||
    typeof value.stdoutTruncated !== 'boolean' ||
    typeof value.stderrTruncated !== 'boolean' ||
    value.encoding !== 'utf8Lossy' ||
    typeof value.durationMs !== 'number' ||
    !Number.isSafeInteger(value.durationMs) ||
    value.durationMs < 0 ||
    ((Object.hasOwn(value, 'sandboxPolicy') ||
      Object.hasOwn(value, 'networkPolicy')) &&
      (value.sandboxPolicy !== 'filesystemReadOnlyV1' ||
        value.networkPolicy !== 'networkDeniedV1')) ||
    Object.hasOwn(value, 'sandboxPolicy') !==
      Object.hasOwn(value, 'networkPolicy') ||
    !isRecord(value.outcome)
  ) {
    return false;
  }
  if (value.outcome.type === 'timedOut') {
    return Object.keys(value.outcome).length === 1;
  }
  if (value.outcome.type === 'exitCode') {
    return (
      Object.keys(value.outcome).length === 2 &&
      typeof value.outcome.code === 'number' &&
      Number.isSafeInteger(value.outcome.code)
    );
  }
  return (
    value.outcome.type === 'signal' &&
    Object.keys(value.outcome).length === 2 &&
    typeof value.outcome.signal === 'number' &&
    Number.isSafeInteger(value.outcome.signal)
  );
};

export const isCommandApprovalActivity = (
  value: unknown,
): value is ConversationCommandApprovalActivity => {
  const fullAccess =
    isRecord(value) && value.fullAccess === true;
  const liveOutputValid =
    !isRecord(value) ||
    !Object.hasOwn(value, 'liveOutput') ||
    (isRecord(value.liveOutput) &&
      typeof value.liveOutput.stdout === 'string' &&
      new TextEncoder().encode(value.liveOutput.stdout).byteLength <= 65_536 &&
      typeof value.liveOutput.stderr === 'string' &&
      new TextEncoder().encode(value.liveOutput.stderr).byteLength <= 65_536);
  if (
    !isRecord(value) ||
    !isId(value.callItemId) ||
    !isId(value.id) ||
    value.callItemId === value.id ||
    !isId(value.callId) ||
    !isId(value.approvalId) ||
    (Object.hasOwn(value, 'operationKind') &&
      value.operationKind !== 'workspacePatch' &&
      value.operationKind !== 'shell' &&
      value.operationKind !== 'projectEnvironment') ||
    typeof value.command !== 'string' ||
    value.command.length === 0 ||
    new TextEncoder().encode(value.command).byteLength >
      (fullAccess ? 32_768 : 1_024) ||
    (fullAccess
      ? value.command.includes('\0')
      : Array.from(value.command).some((character) => /\p{Cc}/u.test(character))) ||
    (Object.hasOwn(value, 'fullAccess') && typeof value.fullAccess !== 'boolean') ||
    !liveOutputValid ||
    typeof value.argumentCount !== 'number' ||
    !Number.isSafeInteger(value.argumentCount) ||
    value.argumentCount < 0 ||
    value.argumentCount > 64 ||
    typeof value.requestStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.requestStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (!Object.hasOwn(value, 'decision')) {
    return (
      !Object.hasOwn(value, 'executionAttempt') &&
      !Object.hasOwn(value, 'executionResult')
    );
  }
  if (!(
    value.requestStatus === 'completed' &&
    isRecord(value.decision) &&
    isId(value.decision.id) &&
    value.decision.id !== value.id &&
    value.decision.id !== value.callItemId &&
    typeof value.decision.status === 'string' &&
    MESSAGE_STATUSES.has(value.decision.status as ConversationMessageStatus) &&
    typeof value.decision.value === 'string' &&
    COMMAND_APPROVAL_DECISIONS.has(
      value.decision.value as ConversationCommandApprovalDecision,
    ) &&
    (value.decision.source === undefined ||
      ['user', 'policy', 'system'].includes(String(value.decision.source)))
  )) {
    return false;
  }
  if (!Object.hasOwn(value, 'executionAttempt')) {
    return !Object.hasOwn(value, 'executionResult');
  }
  if (!(
    value.decision.value === 'approved' &&
    value.decision.status === 'completed' &&
    isRecord(value.executionAttempt) &&
    isId(value.executionAttempt.id) &&
    value.executionAttempt.id !== value.id &&
    value.executionAttempt.id !== value.callItemId &&
    value.executionAttempt.id !== value.decision.id &&
    typeof value.executionAttempt.status === 'string' &&
    MESSAGE_STATUSES.has(
      value.executionAttempt.status as ConversationMessageStatus,
    )
  )) {
    return false;
  }
  if (!Object.hasOwn(value, 'executionResult')) {
    return true;
  }
  return (
    value.executionAttempt.status === 'completed' &&
    isRecord(value.executionResult) &&
    isId(value.executionResult.id) &&
    value.executionResult.id !== value.id &&
    value.executionResult.id !== value.callItemId &&
    value.executionResult.id !== value.decision.id &&
    value.executionResult.id !== value.executionAttempt.id &&
    typeof value.executionResult.status === 'string' &&
    MESSAGE_STATUSES.has(
      value.executionResult.status as ConversationMessageStatus,
    ) &&
    isCommandExecutionResultOutcome(value.executionResult.outcome)
  );
};

const isMcpResultReceipt = (
  value: unknown,
): value is ConversationMcpResultReceipt => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'error') {
    return (
      typeof value.kind === 'string' &&
      value.kind.length > 0 &&
      typeof value.requestState === 'string' &&
      value.requestState.length > 0
    );
  }
  return (
    value.type === 'completed' &&
    typeof value.isError === 'boolean' &&
    [value.observedBytes, value.canonicalBytes, value.retainedBytes].every(
      (count) =>
        typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
    ) &&
    typeof value.truncated === 'boolean' &&
    isValidSha256(value.sha256) &&
    typeof value.contentBlocks === 'number' &&
    Number.isSafeInteger(value.contentBlocks) &&
    value.contentBlocks >= 0 &&
    value.contentBlocks <= 32 &&
    typeof value.structuredContent === 'boolean'
  );
};

export const isMcpActivity = (value: unknown): value is ConversationMcpActivity => {
  if (
    !isRecord(value) ||
    !isId(value.callItemId) ||
    !isId(value.id) ||
    !isId(value.callId) ||
    !isId(value.approvalId) ||
    typeof value.serverId !== 'string' ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value.serverId) ||
    typeof value.name !== 'string' ||
    !value.name.startsWith(`mcp__${value.serverId}__`) ||
    typeof value.argumentsBytes !== 'number' ||
    !Number.isSafeInteger(value.argumentsBytes) ||
    value.argumentsBytes < 0 ||
    value.argumentsBytes > 32 * 1024 ||
    !isValidSha256(value.argumentsSha256) ||
    !isValidSha256(value.inventorySha256) ||
    typeof value.callStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.callStatus as ConversationMessageStatus) ||
    typeof value.requestStatus !== 'string' ||
    !MESSAGE_STATUSES.has(value.requestStatus as ConversationMessageStatus)
  ) {
    return false;
  }
  if (
    Object.hasOwn(value, 'decision') &&
    (!isRecord(value.decision) ||
      !isId(value.decision.id) ||
      typeof value.decision.status !== 'string' ||
      !MESSAGE_STATUSES.has(
        value.decision.status as ConversationMessageStatus,
      ) ||
      typeof value.decision.value !== 'string' ||
      !COMMAND_APPROVAL_DECISIONS.has(
        value.decision.value as ConversationCommandApprovalDecision,
      ))
  ) {
    return false;
  }
  if (
    Object.hasOwn(value, 'executionAttempt') &&
    (!isRecord(value.executionAttempt) ||
      !isId(value.executionAttempt.id) ||
      typeof value.executionAttempt.status !== 'string' ||
      !MESSAGE_STATUSES.has(
        value.executionAttempt.status as ConversationMessageStatus,
      ))
  ) {
    return false;
  }
  return (
    !Object.hasOwn(value, 'result') ||
    (isRecord(value.result) &&
      isId(value.result.id) &&
      typeof value.result.status === 'string' &&
      MESSAGE_STATUSES.has(value.result.status as ConversationMessageStatus) &&
      isMcpResultReceipt(value.result.receipt))
  );
};
