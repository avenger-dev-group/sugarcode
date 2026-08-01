const MAX_THREAD_TITLE_CHARACTERS = 48;

const GENERIC_GREETINGS = new Set([
  '你好',
  '您好',
  '嗨',
  '哈喽',
  'hello',
  'hi',
  'hey',
]);

export const deriveThreadTitle = (
  text: string,
  attachmentName?: string,
): string | undefined => {
  const normalized = normalizeTitle(text);
  if (normalized.length > 0 && !isGenericGreeting(normalized)) {
    return boundTitle(normalized);
  }
  return attachmentName
    ? boundTitle(normalizeTitle(`处理 ${attachmentName}`))
    : undefined;
};

const isGenericGreeting = (text: string): boolean =>
  GENERIC_GREETINGS.has(
    text.replace(/[!,.?，。！？]+$/u, '').toLocaleLowerCase(),
  );

const isControlCharacter = (character: string): boolean => {
  const code = character.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
};

const normalizeTitle = (value: string): string =>
  Array.from(value)
    .map((character) => (isControlCharacter(character) ? ' ' : character))
    .join('')
    .trim()
    .replace(/\s+/gu, ' ');

const boundTitle = (value: string): string | undefined => {
  if (!value) {
    return undefined;
  }
  const characters = Array.from(value);
  return characters.length > MAX_THREAD_TITLE_CHARACTERS
    ? `${characters.slice(0, MAX_THREAD_TITLE_CHARACTERS).join('')}…`
    : value;
};

export const isThreadTitle = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  !Array.from(value).some(isControlCharacter) &&
  new TextEncoder().encode(value).byteLength <= 256;
