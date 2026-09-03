import type { RuntimeSupervisor } from '../connection/supervisor.ts';
import type { GoalPowerSaveController } from './goals/power-save-controller.ts';
import {
  type ConversationStateListener,
  type ConversationThreadDeltaListener,
  type ConversationThreadProjectionListener,
} from '../../../shared/conversation.ts';
import { ConversationProjectionPublisher } from './projection/publisher.ts';
import { GoalCoordinator } from './goals/coordinator.ts';
import type { ConversationServices } from './services.ts';
import { ConversationState } from './state.ts';
import { ConversationAttachments } from './attachments.ts';
import { ConversationNavigation } from './navigation/navigation.ts';
import { ConversationThreadMutations } from './navigation/mutations.ts';
import { ConversationTurnStarter } from './turns/starter.ts';
import { ConversationTurnRevision } from './turns/revision.ts';
import { ConversationTurnControls } from './turns/controls.ts';
import { ConversationQueueCommands } from './queue/commands.ts';
import { ConversationQueueCoordinator } from './queue/coordinator.ts';
import { ConversationGoalActions } from './goals/actions.ts';
import { ConversationEvents } from './events.ts';
import { ConversationView } from './projection/view.ts';
import { ConversationProjectionRecovery } from './projection/recovery.ts';

// Composition root and stable IPC-facing API. Business operations live in
// focused services; no service imports this controller.
export class RuntimeConversationController {
  private readonly projections: ConversationProjectionPublisher;
  private readonly attachments: ConversationAttachments;
  private readonly navigation: ConversationNavigation;
  private readonly threadMutations: ConversationThreadMutations;
  private readonly turnStarter: ConversationTurnStarter;
  private readonly turnRevision: ConversationTurnRevision;
  private readonly turnControls: ConversationTurnControls;
  private readonly queueCommands: ConversationQueueCommands;
  private readonly queueCoordinator: ConversationQueueCoordinator;
  private readonly goalActions: ConversationGoalActions;
  private readonly events: ConversationEvents;
  private readonly view: ConversationView;
  private readonly recovery: ConversationProjectionRecovery;

  constructor(runtime: RuntimeSupervisor, powerSave?: GoalPowerSaveController) {
    const state = new ConversationState();
    const goals = new GoalCoordinator(runtime, (goal, reconciliation) =>
      this.goalActions.startGoalTurn(goal, reconciliation));
    this.projections = new ConversationProjectionPublisher({
      buildStateSnapshot: (revision) => this.view.buildStateSnapshot(revision),
      buildThreadSnapshot: (threadId, revision) =>
        this.view.buildThreadProjection(threadId, revision),
      onFault: (fault) => this.recovery.handleProjectionFault(fault),
    });
    const services: ConversationServices = {
      state, runtime, goals, powerSave, projections: this.projections,
      publish: (...args) => this.view.publish(...args),
      publishThreadProjection: (...args) => this.view.publishThreadProjection(...args),
      applyRuntimeQueue: (...args) => this.queueCoordinator.applyRuntimeQueue(...args),
      dispatchQueuedMessage: (...args) => this.queueCoordinator.dispatchQueuedMessage(...args),
      refreshNavigator: (...args) => this.navigation.refreshNavigator(...args),
      acquireQueueOperation: (...args) => this.queueCoordinator.acquireQueueOperation(...args),
      ensureSelectedThread: (...args) => this.navigation.ensureSelectedThread(...args),
      finishQueueAfterTurn: (...args) => this.queueCoordinator.finishQueueAfterTurn(...args),
      publishThreadDelta: (...args) => this.view.publishThreadDelta(...args),
      queueErrorReason: (...args) => this.queueCoordinator.queueErrorReason(...args),
      refreshRuntimeQueue: (...args) => this.queueCoordinator.refreshRuntimeQueue(...args),
      appendSteeredUserMessage: (...args) => this.queueCoordinator.appendSteeredUserMessage(...args),
      reconcileGoalAfterRuntimeRestart: (...args) => this.goalActions.reconcileGoalAfterRuntimeRestart(...args),
    };
    this.attachments = new ConversationAttachments(services);
    this.navigation = new ConversationNavigation(services);
    this.threadMutations = new ConversationThreadMutations(services);
    this.turnStarter = new ConversationTurnStarter(services);
    this.turnRevision = new ConversationTurnRevision(services);
    this.turnControls = new ConversationTurnControls(services);
    this.queueCommands = new ConversationQueueCommands(services);
    this.queueCoordinator = new ConversationQueueCoordinator(services);
    this.goalActions = new ConversationGoalActions(services);
    this.events = new ConversationEvents(services);
    this.view = new ConversationView(services);
    this.recovery = new ConversationProjectionRecovery(services);
    runtime.subscribe(this.events.handleRuntimeEvent);
  }

  getSnapshot = () =>
    this.view.getSnapshot();

  getThreadProjection = (threadId: unknown) =>
    this.view.getThreadProjection(threadId);

  getAttachmentPreview = (request: unknown) =>
    this.attachments.getAttachmentPreview(request);

  switchWorkspace = (workspaceId: string) =>
    this.navigation.switchWorkspace(workspaceId);

  mutateGoal = (input: unknown) =>
    this.goalActions.mutateGoal(input);

  startTurn = (input: unknown) =>
    this.turnStarter.startTurn(input);

  updateQueuedMessage = (input: unknown) =>
    this.queueCommands.updateQueuedMessage(input);

  deleteQueuedMessage = (input: unknown) =>
    this.queueCommands.deleteQueuedMessage(input);

  steerQueuedMessage = (input: unknown) =>
    this.queueCommands.steerQueuedMessage(input);

  resumeQueue = (threadId: unknown) =>
    this.queueCommands.resumeQueue(threadId);

  reviseTurn = (input: unknown) =>
    this.turnRevision.reviseTurn(input);

  stopTurn = (threadId: unknown) =>
    this.turnControls.stopTurn(threadId);

  respondToUserInput = (input: unknown) =>
    this.turnControls.respondToUserInput(input);

  searchThreads = (query: unknown) =>
    this.navigation.searchThreads(query);

  selectThread = (threadId: unknown) =>
    this.navigation.selectThread(threadId);

  startNewThread = () =>
    this.navigation.startNewThread();

  deleteThread = (threadId: unknown) =>
    this.threadMutations.deleteThread(threadId);

  renameThread = (threadId: unknown, title: unknown) =>
    this.threadMutations.renameThread(threadId, title);

  subscribe = (listener: ConversationStateListener): (() => void) => {
    return this.projections.subscribeState(listener);
  };

  subscribeThreadProjection = (
    listener: ConversationThreadProjectionListener,
  ): (() => void) => {
    return this.projections.subscribeThreadSnapshot(listener);
  };

  subscribeThreadDelta = (
    listener: ConversationThreadDeltaListener,
  ): (() => void) => {
    return this.projections.subscribeThreadDelta(listener);
  };
}
