import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeConnectionController } from '../../../src/main/runtime/connection/controller.ts';
import type {
  RuntimeLifecycleSnapshot,
  RuntimeSupervisor,
} from '../../../src/main/runtime/connection/supervisor.ts';

class FixtureRuntime {
  private readonly listeners = new Set<(
    snapshot: RuntimeLifecycleSnapshot,
  ) => void>();
  private snapshot: RuntimeLifecycleSnapshot = {
    revision: 1,
    status: 'connecting',
  };

  getLifecycleSnapshot = (): RuntimeLifecycleSnapshot => this.snapshot;

  subscribeLifecycle = (
    listener: (snapshot: RuntimeLifecycleSnapshot) => void,
  ): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publish(snapshot: RuntimeLifecycleSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

test('RuntimeConnectionController projects utility-process lifecycle without CLI diagnostics', () => {
  const runtime = new FixtureRuntime();
  const controller = new RuntimeConnectionController(
    runtime as unknown as RuntimeSupervisor,
  );
  const snapshots = [controller.getSnapshot()];
  controller.subscribe((snapshot) => snapshots.push(snapshot));

  runtime.publish({ revision: 2, status: 'ready' });
  runtime.publish({
    revision: 3,
    status: 'connecting',
    failure: 'crashed',
    detail: 'exit 9',
  });
  runtime.publish({ revision: 4, status: 'ready' });

  assert.deepEqual(
    snapshots.map(({ status }) => status),
    ['connecting', 'ready', 'connecting', 'ready'],
  );
  assert.equal(snapshots[2]?.diagnostic?.code, 'server-crashed');
  assert.match(snapshots[2]?.diagnostic?.summary ?? '', /TypeScript runtime/u);
});
