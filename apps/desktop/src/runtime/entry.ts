import { RuntimeHost } from './host.ts';
import { isRuntimeCommand } from './contracts/protocol.ts';

const runtimePort = process.parentPort;
if (!runtimePort) {
  throw new Error('The SugarCode runtime must run as an Electron utility process.');
}

const host = new RuntimeHost({
  postEvent: (event) => runtimePort.postMessage(event),
});

runtimePort.on('message', (messageEvent) => {
  if (!isRuntimeCommand(messageEvent.data)) {
    runtimePort.postMessage({
      type: 'runtime.log',
      sequence: 0,
      requestId: 'invalid',
      level: 'error',
      message: 'Rejected an invalid runtime command.',
    });
    return;
  }
  try {
    host.handle(messageEvent.data);
  } catch (error) {
    runtimePort.postMessage({
      type: 'runtime.log',
      sequence: 0,
      requestId: messageEvent.data.requestId,
      level: 'error',
      message: error instanceof Error ? error.message : 'Runtime command failed.',
    });
  }
});
