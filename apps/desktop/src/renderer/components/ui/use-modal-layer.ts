import { useSyncExternalStore } from 'react';

type ModalLayerListener = () => void;

const listeners = new Set<ModalLayerListener>();
let openLayerCount = 0;

const emitChange = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: ModalLayerListener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const hasOpenModalLayer = (): boolean => openLayerCount > 0;

export const acquireModalLayer = (): (() => void) => {
  openLayerCount += 1;
  if (openLayerCount === 1) {
    emitChange();
  }
  let acquired = true;
  return () => {
    if (!acquired) {
      return;
    }
    acquired = false;
    openLayerCount = Math.max(0, openLayerCount - 1);
    if (openLayerCount === 0) {
      emitChange();
    }
  };
};

export const useModalLayerOpen = (): boolean =>
  useSyncExternalStore(subscribe, hasOpenModalLayer, () => false);
