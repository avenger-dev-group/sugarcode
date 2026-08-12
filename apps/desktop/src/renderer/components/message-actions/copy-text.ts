export type ClipboardWriter = Readonly<{
  writeText: (text: string) => Promise<void>;
}>;

export const copyTextToClipboard = (
  text: string,
  clipboard: ClipboardWriter = navigator.clipboard,
): Promise<void> => clipboard.writeText(text);
