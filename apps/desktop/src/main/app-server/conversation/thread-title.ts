const isControlCharacter = (character: string): boolean => {
  const code = character.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
};

export const isThreadTitle = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  !Array.from(value).some(isControlCharacter) &&
  new TextEncoder().encode(value).byteLength <= 256;
