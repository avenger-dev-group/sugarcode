import { describe, expect, it } from 'vitest';

import {
  isPreviewActionResult,
  isPreviewOpenRequest,
  isPreviewSessionRequest,
  isPreviewStateSnapshot,
} from '../preview';

const sessionId = '12345678-1234-4123-8123-123456789abc';

describe('preview shared contract', () => {
  it('accepts only a bounded generation and URL open request', () => {
    expect(
      isPreviewOpenRequest({
        generation: 7,
        url: 'http://127.0.0.1:4173/',
      }),
    ).toBe(true);
    expect(
      isPreviewOpenRequest({
        generation: 7,
        url: `http://127.0.0.1:4173/${'a'.repeat(2_048)}`,
      }),
    ).toBe(false);
    expect(
      isPreviewOpenRequest({
        generation: 7,
        url: 'http://127.0.0.1:4173/',
        partition: 'persist:unsafe',
      }),
    ).toBe(false);
  });

  it('requires an opaque v4 session identifier for actions', () => {
    expect(isPreviewSessionRequest({ generation: 7, sessionId })).toBe(
      true,
    );
    expect(
      isPreviewSessionRequest({ generation: 7, sessionId: 'preview' }),
    ).toBe(false);
  });

  it('validates each closed preview state exactly', () => {
    expect(
      isPreviewStateSnapshot({ revision: 3, status: 'closed' }),
    ).toBe(true);
    expect(
      isPreviewStateSnapshot({
        revision: 3,
        status: 'closed',
        url: 'http://127.0.0.1:4173/',
      }),
    ).toBe(false);
  });

  it('validates ready and failed snapshots without extra authority', () => {
    expect(
      isPreviewStateSnapshot({
        revision: 4,
        status: 'ready',
        generation: 7,
        sessionId,
        url: 'http://127.0.0.1:4173/app',
        origin: 'http://127.0.0.1:4173',
        visible: true,
        canGoBack: false,
        canGoForward: true,
      }),
    ).toBe(true);
    expect(
      isPreviewStateSnapshot({
        revision: 5,
        status: 'failed',
        generation: 7,
        url: 'http://127.0.0.1:4173/app',
        origin: 'http://127.0.0.1:4173',
        error: 'loadFailed',
      }),
    ).toBe(true);
    expect(
      isPreviewStateSnapshot({
        revision: 5,
        status: 'failed',
        generation: 7,
        url: 'http://127.0.0.1:4173/app',
        origin: 'http://127.0.0.1:4173',
        error: 'networkOpen',
      }),
    ).toBe(false);
  });

  it('keeps accepted receipts exactly correlated with accepted reason', () => {
    expect(
      isPreviewActionResult({ accepted: true, reason: 'accepted' }),
    ).toBe(true);
    expect(
      isPreviewActionResult({ accepted: false, reason: 'cancelled' }),
    ).toBe(true);
    expect(
      isPreviewActionResult({ accepted: true, reason: 'failed' }),
    ).toBe(false);
  });
});
