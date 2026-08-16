import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  createArtifactPreviewLocation,
  isAllowedPreviewRequest,
  isLoopbackPreviewLocation,
  parsePreviewLocation,
} from '../../../src/main/preview/url.ts';

test('browser locations accept ordinary HTTP and HTTPS addresses', () => {
  assert.deepEqual(parsePreviewLocation('https://example.com/docs?q=1'), {
    kind: 'web',
    url: 'https://example.com/docs?q=1',
    origin: 'https://example.com',
  });
  assert.ok(parsePreviewLocation('http://localhost/'));
  assert.ok(parsePreviewLocation('http://127.0.0.1:3000/'));
  assert.ok(parsePreviewLocation('http://[::1]:8080/'));
  assert.equal(parsePreviewLocation('file:///tmp/index.html'), null);
  assert.equal(parsePreviewLocation('ftp://example.com/file'), null);
  assert.equal(parsePreviewLocation('https://user:pass@example.com/'), null);
});

test('loopback locations remain identifiable for local-service confirmation', () => {
  const local = parsePreviewLocation('http://localhost:5173/');
  const remote = parsePreviewLocation('https://example.com/');
  assert.ok(local && isLoopbackPreviewLocation(local));
  assert.ok(remote && !isLoopbackPreviewLocation(remote));
});

test('browser traffic supports cross-origin web pages but blocks unsafe schemes', () => {
  const location = parsePreviewLocation('https://example.com/app');
  assert.ok(location);

  assert.equal(
    isAllowedPreviewRequest(location, 'https://cdn.example.net/app.js', 'GET', 'script'),
    true,
  );
  assert.equal(
    isAllowedPreviewRequest(location, 'https://accounts.example.net/login', 'GET', 'mainFrame'),
    true,
  );
  assert.equal(
    isAllowedPreviewRequest(location, 'wss://socket.example.net/live', 'GET', 'webSocket'),
    true,
  );
  assert.equal(
    isAllowedPreviewRequest(location, 'file:///tmp/private.txt', 'GET', 'mainFrame'),
    false,
  );
  assert.equal(
    isAllowedPreviewRequest(location, 'https://example.com/plugin', 'GET', 'object'),
    false,
  );
});

test('artifact previews can read adjacent files without escaping their directory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sugarcode-preview-policy-'));
  const outsideRoot = mkdtempSync(path.join(os.tmpdir(), 'sugarcode-preview-outside-'));
  try {
    const entry = path.join(root, 'index.html');
    const style = path.join(root, 'style.css');
    const outside = path.join(outsideRoot, 'secret.css');
    const escape = path.join(root, 'escape.css');
    writeFileSync(entry, '<link rel="stylesheet" href="style.css">');
    writeFileSync(style, 'body {}');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, escape);
    const location = createArtifactPreviewLocation(
      pathToFileURL(entry).toString(),
      realpathSync(root),
    );

    assert.equal(
      isAllowedPreviewRequest(location, pathToFileURL(entry).toString(), 'GET', 'mainFrame'),
      true,
    );
    assert.equal(
      isAllowedPreviewRequest(location, pathToFileURL(style).toString(), 'GET', 'stylesheet'),
      true,
    );
    assert.equal(
      isAllowedPreviewRequest(location, pathToFileURL(escape).toString(), 'GET', 'stylesheet'),
      false,
    );
    assert.equal(
      isAllowedPreviewRequest(location, pathToFileURL(outside).toString(), 'GET', 'stylesheet'),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});
