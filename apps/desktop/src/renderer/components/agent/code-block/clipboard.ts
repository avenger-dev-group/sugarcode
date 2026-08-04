export type ClipboardWriter = Readonly<{
  writeText: (text: string) => Promise<void>;
}>;

export const copyCodeToClipboard = (
  code: string,
  clipboard: ClipboardWriter = navigator.clipboard,
): Promise<void> => clipboard.writeText(code);
