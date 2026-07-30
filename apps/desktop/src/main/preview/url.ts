import { PREVIEW_URL_MAX_BYTES } from '@/shared/preview';

export type PreviewLocation = Readonly<{
  url: string;
  origin: string;
}>;

const hasForbiddenCodePoint = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

export const parsePreviewLocation = (
  value: string,
): PreviewLocation | null => {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > PREVIEW_URL_MAX_BYTES ||
    value.includes('\\') ||
    hasForbiddenCodePoint(value)
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') ||
    parsed.port.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    return null;
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return null;
  }
  return {
    url: parsed.toString(),
    origin: parsed.origin,
  };
};

export const isAllowedPreviewRequest = (
  location: PreviewLocation,
  url: string,
  method: string,
  resourceType: string,
): boolean => {
  if (Buffer.byteLength(url, 'utf8') > PREVIEW_URL_MAX_BYTES) {
    return false;
  }
  if (
    url.startsWith('data:') &&
    ['image', 'font', 'media'].includes(resourceType) &&
    (method === 'GET' || method === 'HEAD')
  ) {
    return true;
  }
  if (
    (method !== 'GET' && method !== 'HEAD') ||
    resourceType === 'subFrame' ||
    resourceType === 'webSocket' ||
    resourceType === 'object' ||
    resourceType === 'ping' ||
    resourceType === 'cspReport'
  ) {
    return false;
  }
  try {
    return new URL(url).origin === location.origin;
  } catch {
    return false;
  }
};
