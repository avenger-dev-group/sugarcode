import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  BrowserWindow,
  WebContents,
  WebFrameMain,
} from 'electron';

import {
  getTrustedMainWindow,
  sendToTrustedMainWindow,
} from '../../../src/main/ipc/trusted-sender.ts';

const DISPOSED_FRAME_ERROR =
  'Render frame was disposed before WebFrameMain could be accessed';

const createWindow = (frame: WebFrameMain): BrowserWindow => {
  const webContents = {
    isDestroyed: () => false,
    mainFrame: frame,
  } as unknown as WebContents;
  return {
    isDestroyed: () => false,
    webContents,
  } as unknown as BrowserWindow;
};

test('getTrustedMainWindow rejects a main frame disposed during validation', () => {
  const frame = {
    isDestroyed: () => false,
    get url(): string {
      throw new Error(DISPOSED_FRAME_ERROR);
    },
  } as unknown as WebFrameMain;
  const window = createWindow(frame);

  assert.doesNotThrow(() => {
    assert.equal(getTrustedMainWindow({
      getMainWindow: () => window,
      isAllowedUrl: () => true,
    }), null);
  });
});

test('sendToTrustedMainWindow absorbs disposal between validation and send', () => {
  const frame = {
    isDestroyed: () => false,
    url: 'app://sugarcode/index.html',
    send: () => {
      throw new Error(DISPOSED_FRAME_ERROR);
    },
  } as unknown as WebFrameMain;
  const window = createWindow(frame);

  assert.doesNotThrow(() => {
    assert.equal(sendToTrustedMainWindow(
      {
        getMainWindow: () => window,
        isAllowedUrl: (url) => url.startsWith('app://sugarcode/'),
      },
      'connection:changed',
      { status: 'connecting' },
    ), false);
  });
});

test('sendToTrustedMainWindow sends through a live trusted main frame', () => {
  const messages: unknown[][] = [];
  const frame = {
    isDestroyed: () => false,
    url: 'app://sugarcode/index.html',
    send: (...args: unknown[]) => messages.push(args),
  } as unknown as WebFrameMain;
  const window = createWindow(frame);

  assert.equal(sendToTrustedMainWindow(
    {
      getMainWindow: () => window,
      isAllowedUrl: (url) => url.startsWith('app://sugarcode/'),
    },
    'connection:changed',
    { status: 'ready' },
  ), true);
  assert.deepEqual(messages, [[
    'connection:changed',
    { status: 'ready' },
  ]]);
});
