type PowerSaveBlockerBoundary = Readonly<{
  start: (type: 'prevent-app-suspension') => number;
  stop: (id: number) => void;
  isStarted: (id: number) => boolean;
}>;

/** Holds one Electron blocker only while an enabled Goal-owned Turn is running. */
export class GoalPowerSaveController {
  private readonly blocker: PowerSaveBlockerBoundary;
  private readonly activeTurns = new Set<string>();
  private enabled = false;
  private blockerId: number | undefined;

  constructor(blocker: PowerSaveBlockerBoundary) {
    this.blocker = blocker;
  }

  setEnabled = (enabled: boolean): void => {
    this.enabled = enabled;
    this.reconcile();
  };

  startTurn = (turnId: string): void => {
    this.activeTurns.add(turnId);
    this.reconcile();
  };

  finishTurn = (turnId: string): void => {
    this.activeTurns.delete(turnId);
    this.reconcile();
  };

  dispose = (): void => {
    this.enabled = false;
    this.activeTurns.clear();
    this.reconcile();
  };

  private reconcile = (): void => {
    const shouldHold = this.enabled && this.activeTurns.size > 0;
    if (shouldHold && this.blockerId === undefined) {
      this.blockerId = this.blocker.start('prevent-app-suspension');
      return;
    }
    if (!shouldHold && this.blockerId !== undefined) {
      if (this.blocker.isStarted(this.blockerId)) this.blocker.stop(this.blockerId);
      this.blockerId = undefined;
    }
  };
}
