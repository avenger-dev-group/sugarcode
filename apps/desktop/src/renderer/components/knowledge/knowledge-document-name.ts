export type KnowledgeDocumentExtension = 'md' | 'txt';

export const stripKnowledgeDocumentExtension = (value: string): string =>
  value.replace(/\.(?:md|txt)$/iu, '');

export const buildKnowledgeDocumentFileName = (
  baseName: string,
  extension: KnowledgeDocumentExtension,
): string => `${stripKnowledgeDocumentExtension(baseName)}.${extension}`;

export const isValidKnowledgeDocumentBaseName = (
  baseName: string,
  extension: KnowledgeDocumentExtension,
): boolean => {
  const normalized = stripKnowledgeDocumentExtension(baseName);
  const fileName = buildKnowledgeDocumentFileName(normalized, extension);
  return (
    normalized === baseName &&
    normalized.trim() === normalized &&
    normalized.length > 0 &&
    fileName.length <= 255 &&
    !normalized.includes('/') &&
    !normalized.includes('\\') &&
    ![...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
};
