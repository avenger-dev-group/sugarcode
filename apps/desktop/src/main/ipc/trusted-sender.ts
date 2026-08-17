import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  WebFrameMain,
} from 'electron';

export type IpcSenderValidationOptions = Readonly<{
  getMainWindow: () => BrowserWindow | null;
  isAllowedUrl: (url: string) => boolean;
}>;

type TrustedMainTarget = Readonly<{
  window: BrowserWindow;
  frame: WebFrameMain;
}>;

const getTrustedMainTarget = (
  options: IpcSenderValidationOptions,
): TrustedMainTarget | null => {
  try {
    const window = options.getMainWindow();
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    ) {
      return null;
    }
    const frame = window.webContents.mainFrame;
    if (frame.isDestroyed() || !options.isAllowedUrl(frame.url)) {
      return null;
    }
    return { window, frame };
  } catch {
    // A frame can be disposed between any two WebFrameMain accesses while its
    // page is navigating or its renderer is exiting. Treat it as unavailable.
    return null;
  }
};

export const isTrustedIpcSender = (
  event: IpcMainInvokeEvent,
  options: IpcSenderValidationOptions,
): boolean => {
  const target = getTrustedMainTarget(options);
  if (!target) {
    return false;
  }
  try {
    return (
      event.sender === target.window.webContents &&
      event.senderFrame === target.frame &&
      !event.senderFrame.isDestroyed()
    );
  } catch {
    return false;
  }
};

export const getTrustedMainWindow = (
  options: IpcSenderValidationOptions,
): BrowserWindow | null => getTrustedMainTarget(options)?.window ?? null;

export const sendToTrustedMainWindow = (
  options: IpcSenderValidationOptions,
  channel: string,
  ...args: unknown[]
): boolean => {
  const target = getTrustedMainTarget(options);
  if (!target) {
    return false;
  }
  try {
    target.frame.send(channel, ...args);
    return true;
  } catch {
    // Sending notifications is best-effort. The renderer may disappear after
    // validation but before Electron accesses the underlying RenderFrameHost.
    return false;
  }
};
