import type {
  ConnectionDiagnostic,
  ConnectionStateListener,
  ConnectionStateSnapshot,
} from '../../../shared/connection.ts';
import type {
  RuntimeLifecycleSnapshot,
  RuntimeSupervisor,
} from './supervisor.ts';

const diagnosticFromLifecycle = (
  lifecycle: RuntimeLifecycleSnapshot,
): ConnectionDiagnostic | undefined => {
  if (!lifecycle.failure) {
    return undefined;
  }
  switch (lifecycle.failure) {
    case 'spawnFailed':
      return {
        code: 'spawn-failed',
        summary: 'SugarCode could not start its local TypeScript runtime.',
      };
    case 'protocolInvalid':
      return {
        code: 'protocol-invalid',
        summary: 'The local TypeScript runtime returned an invalid internal event.',
      };
    case 'crashed':
      return {
        code: 'server-crashed',
        summary: 'The local TypeScript runtime stopped and is restarting.',
      };
  }
};

export class RuntimeConnectionController {
  private readonly listeners = new Set<ConnectionStateListener>();
  private snapshot: ConnectionStateSnapshot;

  constructor(runtime: RuntimeSupervisor) {
    this.snapshot = this.project(runtime.getLifecycleSnapshot());
    runtime.subscribeLifecycle((lifecycle) => {
      this.snapshot = this.project(lifecycle);
      for (const listener of this.listeners) {
        listener(this.snapshot);
      }
    });
  }

  getSnapshot = (): ConnectionStateSnapshot => this.snapshot;

  subscribe = (listener: ConnectionStateListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private project = (
    lifecycle: RuntimeLifecycleSnapshot,
  ): ConnectionStateSnapshot => {
    const diagnostic = diagnosticFromLifecycle(lifecycle);
    return {
      revision: lifecycle.revision,
      status: lifecycle.status,
      ...(diagnostic ? { diagnostic } : {}),
    };
  };
}
