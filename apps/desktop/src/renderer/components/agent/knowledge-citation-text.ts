export type KnowledgeCitationTextSegment =
  | Readonly<{ type: 'text'; value: string }>
  | Readonly<{ type: 'citation'; label: string }>;

export const splitKnowledgeCitationText = (
  text: string,
  availableLabels: Readonly<{ has: (label: string) => boolean }>,
): readonly KnowledgeCitationTextSegment[] => {
  const pattern = /\[(K[1-8])\]/gu;
  const segments: KnowledgeCitationTextSegment[] = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    const label = match[1];
    if (index === undefined || !label || !availableLabels.has(label)) continue;
    if (index > start) {
      segments.push({ type: 'text', value: text.slice(start, index) });
    }
    segments.push({ type: 'citation', label });
    start = index + match[0].length;
  }
  if (start < text.length) {
    segments.push({ type: 'text', value: text.slice(start) });
  }
  return segments.length > 0 ? segments : [{ type: 'text', value: text }];
};
