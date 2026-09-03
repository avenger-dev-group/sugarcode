// Run with Electron, e.g. electron scripts/video-preview-smoke.mjs /path/to/video.mp4.
// Uses an isolated profile and opens the input read-only; no project or model calls.
import { app, BrowserWindow, protocol } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VideoPreviewMedia } from '../apps/desktop/src/main/preview/video-media.ts';
import { VIDEO_PREVIEW_SCHEME } from '../apps/desktop/src/shared/preview.ts';

protocol.registerSchemesAsPrivileged([{
  scheme: VIDEO_PREVIEW_SCHEME,
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
}]);
app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'sugarcode-video-smoke-')));
async function run() {
  let media;
  try {
    const file = await realpath(process.argv[2]);
    const workspace = { generation: 1, workspaceId: 'smoke', threadId: 'smoke', path: path.dirname(file), name: 'smoke' };
    media = new VideoPreviewMedia(() => workspace);
    const grant = media.grant(workspace, path.basename(file), file);
    await app.whenReady();
    const requests = [];
    protocol.handle(VIDEO_PREVIEW_SCHEME, async (request) => {
      const result = await media.respond(request);
      requests.push({ range: request.headers.get('range'), status: result.status });
      return result;
    });
    const window = new BrowserWindow({ show: false, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    } });
    await window.loadURL('data:text/html,<video id="video" controls></video>');
    const result = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const v=document.querySelector('video');
      const timer=setTimeout(()=>reject(new Error('Video playback timed out')),15000);
      v.onerror=()=>reject(new Error('Media error '+v.error?.code+': '+v.error?.message));
      v.onloadedmetadata=async()=>{
        try {
          await v.play();
          v.onseeked=()=>{clearTimeout(timer);v.pause();resolve({duration:v.duration,width:v.videoWidth,height:v.videoHeight,seekTime:v.currentTime,muted:v.muted})};
          v.currentTime=Math.max(0.1,v.duration*0.7);
        } catch(e){reject(e)}
      };
      v.src=${JSON.stringify(grant.url)};
    })`, true);
    assert.ok(result.width > 0 && result.height > 0 && result.duration > 0);
    assert.ok(result.seekTime >= result.duration * 0.69);
    assert.equal(result.muted, false);
    assert.ok(requests.some((request) => request.status === 206));
    console.log(JSON.stringify({ ok: true, ...result, requests }));
    window.destroy();
    media.clear();
    app.exit(0);
  } catch (error) {
    console.error(error);
    media?.clear();
    app.exit(1);
  }
}
void run();
