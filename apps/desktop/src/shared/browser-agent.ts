export const MAX_BROWSER_AGENT_TEXT_BYTES = 32 * 1_024;
export const MAX_BROWSER_AGENT_ELEMENTS = 120;

export type BrowserAgentAction =
  | Readonly<{ action: 'open'; url: string }>
  | Readonly<{ action: 'snapshot'; sessionId: string }>
  | Readonly<{ action: 'click'; sessionId: string; selector: string }>
  | Readonly<{
      action: 'type';
      sessionId: string;
      selector: string;
      text: string;
    }>
  | Readonly<{ action: 'wait'; sessionId: string; milliseconds: number }>
  | Readonly<{
      action: 'screenshot';
      sessionId: string;
      path?: string;
    }>
  | Readonly<{ action: 'close'; sessionId: string }>;

export type BrowserAgentElement = Readonly<{
  selector: string;
  tag: string;
  label: string;
  role?: string;
  disabled?: boolean;
}>;

export type BrowserAgentSnapshot = Readonly<{
  sessionId: string;
  url: string;
  title: string;
  text: string;
  elements: readonly BrowserAgentElement[];
}>;

export type BrowserAgentResult =
  | Readonly<{
      ok: true;
      snapshot?: BrowserAgentSnapshot;
      screenshotPath?: string;
    }>
  | Readonly<{
      ok: false;
      error: string;
    }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f-]{16,64}$/iu.test(value);

const isBoundedString = (value: unknown, maxBytes: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  utf8ByteLength(value) <= maxBytes;

export const isBrowserAgentAction = (
  value: unknown,
): value is BrowserAgentAction => {
  if (!isRecord(value) || typeof value.action !== 'string') return false;
  if (value.action === 'open') {
    return isBoundedString(value.url, 8_192);
  }
  if (!isSessionId(value.sessionId)) return false;
  switch (value.action) {
    case 'snapshot':
    case 'close':
      return true;
    case 'click':
      return isBoundedString(value.selector, 1_024);
    case 'type':
      return (
        isBoundedString(value.selector, 1_024) &&
        typeof value.text === 'string' &&
        utf8ByteLength(value.text) <= 16 * 1_024
      );
    case 'wait':
      return (
        Number.isSafeInteger(value.milliseconds) &&
        Number(value.milliseconds) >= 0 &&
        Number(value.milliseconds) <= 10_000
      );
    case 'screenshot':
      return (
        value.path === undefined ||
        (isBoundedString(value.path, 2_048) &&
          /^[\p{L}\p{N}_.-]+\.png$/iu.test(value.path) &&
          value.path !== '..')
      );
    default:
      return false;
  }
};

const isBrowserAgentElement = (value: unknown): value is BrowserAgentElement =>
  isRecord(value) &&
  isBoundedString(value.selector, 1_024) &&
  isBoundedString(value.tag, 64) &&
  typeof value.label === 'string' &&
  utf8ByteLength(value.label) <= 2_048 &&
  (value.role === undefined || isBoundedString(value.role, 128)) &&
  (value.disabled === undefined || typeof value.disabled === 'boolean');

const isBrowserAgentSnapshot = (
  value: unknown,
): value is BrowserAgentSnapshot =>
  isRecord(value) &&
  isSessionId(value.sessionId) &&
  isBoundedString(value.url, 8_192) &&
  typeof value.title === 'string' &&
  utf8ByteLength(value.title) <= 2_048 &&
  typeof value.text === 'string' &&
  utf8ByteLength(value.text) <= MAX_BROWSER_AGENT_TEXT_BYTES &&
  Array.isArray(value.elements) &&
  value.elements.length <= MAX_BROWSER_AGENT_ELEMENTS &&
  value.elements.every(isBrowserAgentElement);

export const isBrowserAgentResult = (
  value: unknown,
): value is BrowserAgentResult => {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (!value.ok) {
    return isBoundedString(value.error, 4_096);
  }
  return (
    (value.snapshot === undefined || isBrowserAgentSnapshot(value.snapshot)) &&
    (value.screenshotPath === undefined ||
      isBoundedString(value.screenshotPath, 2_048))
  );
};
