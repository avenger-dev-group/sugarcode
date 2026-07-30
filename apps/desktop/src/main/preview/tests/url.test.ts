import { describe, expect, it } from 'vitest';

import {
  isAllowedPreviewRequest,
  parsePreviewLocation,
} from '../url';

describe('preview URL policy', () => {
  it.each([
    [
      'http://127.0.0.1:4173',
      'http://127.0.0.1:4173/',
      'http://127.0.0.1:4173',
    ],
    [
      'http://[::1]:3000/app?q=one#result',
      'http://[::1]:3000/app?q=one#result',
      'http://[::1]:3000',
    ],
  ])('canonicalizes literal loopback URLs', (input, url, origin) => {
    expect(parsePreviewLocation(input)).toEqual({ url, origin });
  });

  it.each([
    'https://127.0.0.1:4173/',
    'http://localhost:4173/',
    'http://127.0.0.2:4173/',
    'http://0.0.0.0:4173/',
    'http://192.168.1.4:4173/',
    'http://example.com:4173/',
    'http://user@127.0.0.1:4173/',
    'http://127.0.0.1/',
    'file:///tmp/index.html',
    'data:text/html,hello',
    'http:\\\\127.0.0.1:4173\\app',
    'http://127.0.0.1:0/',
  ])('rejects authority outside the exact v1 boundary: %s', (url) => {
    expect(parsePreviewLocation(url)).toBeNull();
  });

  it('allows only same-origin GET and HEAD browser requests', () => {
    const location = parsePreviewLocation(
      'http://127.0.0.1:4173/app',
    );
    expect(location).not.toBeNull();
    if (!location) {
      return;
    }
    expect(
      isAllowedPreviewRequest(
        location,
        'http://127.0.0.1:4173/assets/app.js',
        'GET',
        'script',
      ),
    ).toBe(true);
    expect(
      isAllowedPreviewRequest(
        location,
        'http://127.0.0.1:4173/api',
        'HEAD',
        'xhr',
      ),
    ).toBe(true);
    expect(
      isAllowedPreviewRequest(
        location,
        'http://127.0.0.1:4174/',
        'GET',
        'mainFrame',
      ),
    ).toBe(false);
    expect(
      isAllowedPreviewRequest(
        location,
        'http://127.0.0.1:4173/api',
        'POST',
        'xhr',
      ),
    ).toBe(false);
    expect(
      isAllowedPreviewRequest(
        location,
        'ws://127.0.0.1:4173/',
        'GET',
        'webSocket',
      ),
    ).toBe(false);
    expect(
      isAllowedPreviewRequest(
        location,
        'http://127.0.0.1:4173/frame',
        'GET',
        'subFrame',
      ),
    ).toBe(false);
  });
});
