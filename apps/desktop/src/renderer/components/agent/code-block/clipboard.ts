export type ClipboardWriter = Readonly<{
  writeText: (text: string) => Promise<void>;
}>;

export const copyCodeToClipboard = (
  code: string,
  clipboard: ClipboardWriter = navigator.clipboard,
): Promise<void> => copyTextToClipboard(code, clipboard);
import { copyTextToClipboard } from '../../message-actions/use-copy-text.ts';
