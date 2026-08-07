import {
  acceptConversationSnapshot,
  acceptConversationThreadDelta,
  acceptConversationThreadProjection,
  reportConversationProjectionError,
} from '@/renderer/stores/conversation-projection-store';

import {
  getConversationState,
  getConversationThreadProjection,
  onConversationStateChanged,
  onConversationThreadDelta,
  onConversationThreadProjectionChanged,
} from './conversation';
import type { ConversationProjectionDiagnostic } from '@/shared/conversation';

let stopActiveProjection: (() => void) | null = null;

export const stopConversationProjection = (): void => {
  stopActiveProjection?.();
};

export const startConversationProjection = (): (() => void) => {
  if (stopActiveProjection) {
    return stopConversationProjection;
  }

  let active = true;
  const recoverDiagnostic = (
    diagnostic: ConversationProjectionDiagnostic,
  ): void => {
    if (!active) {
      return;
    }
    if (diagnostic.threadId) {
      void getConversationThreadProjection(diagnostic.threadId)
        .then(acceptConversationThreadProjection)
        .catch(() => {
          reportConversationProjectionError(
            'An invalid Thread update could not be restored.',
          );
        });
      return;
    }
    reportConversationProjectionError(
      'Desktop rejected an invalid Thread update.',
    );
  };
  const unsubscribe = onConversationStateChanged((snapshot) => {
    if (active) {
      acceptConversationSnapshot(snapshot);
    }
  });
  const unsubscribeThreadProjection =
    onConversationThreadProjectionChanged(
      (snapshot) => {
        if (active) {
          acceptConversationThreadProjection(snapshot);
        }
      },
      recoverDiagnostic,
    );
  const unsubscribeThreadDelta = onConversationThreadDelta((delta) => {
    if (!active) {
      return;
    }
    if (acceptConversationThreadDelta(delta) === 'gap') {
      void getConversationThreadProjection(delta.threadId)
        .then(acceptConversationThreadProjection)
        .catch(() => {
          reportConversationProjectionError(
            'A Thread update was missed and could not be restored.',
          );
        });
    }
  }, recoverDiagnostic);
  stopActiveProjection = () => {
    if (!active) {
      return;
    }
    active = false;
    unsubscribe();
    unsubscribeThreadProjection();
    unsubscribeThreadDelta();
    stopActiveProjection = null;
  };

  void getConversationState()
    .then((snapshot) => {
      if (active) {
        acceptConversationSnapshot(snapshot);
        if (snapshot.threadId) {
          return getConversationThreadProjection(snapshot.threadId).then(
            acceptConversationThreadProjection,
          );
        }
      }
      return undefined;
    })
    .catch(() => {
      if (active) {
        reportConversationProjectionError(
          'Desktop could not read the current conversation.',
        );
      }
    });

  return stopConversationProjection;
};
