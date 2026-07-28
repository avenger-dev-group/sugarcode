import type {
  BrowserWindow,
  IpcMainInvokeEvent,
} from 'electron';

export type IpcSenderValidationOptions = Readonly<{
  getMainWindow: () => BrowserWindow | null;
  isAllowedUrl: (url: string) => boolean;
}>;

export const isTrustedIpcSender = (
  event: IpcMainInvokeEvent,
  options: IpcSenderValidationOptions,
): boolean => {
  const window = options.getMainWindow();
  return (
    window !== null &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    options.isAllowedUrl(event.senderFrame.url)
  );
};

export const getTrustedMainWindow = (
  options: IpcSenderValidationOptions,
): BrowserWindow | null => {
  const window = options.getMainWindow();
  if (
    !window ||
    window.isDestroyed() ||
    !options.isAllowedUrl(window.webContents.mainFrame.url)
  ) {
    return null;
  }
  return window;
};
