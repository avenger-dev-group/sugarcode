import type {
  ConversationActivity,
  ConversationKnowledgeCitation,
} from '@/shared/conversation';

export const collectTurnKnowledgeCitations = (
  activities: readonly ConversationActivity[],
): readonly ConversationKnowledgeCitation[] => {
  const byLabel = new Map<string, ConversationKnowledgeCitation>();
  for (const entry of [...activities].reverse()) {
    if (
      entry.type !== 'knowledge' ||
      entry.activity.result?.outcome.type !== 'success'
    ) {
      continue;
    }
    for (const citation of entry.activity.result.outcome.citations ?? []) {
      if (!byLabel.has(citation.citation)) {
        byLabel.set(citation.citation, citation);
      }
    }
  }
  return [...byLabel.values()].sort((left, right) =>
    left.citation.localeCompare(right.citation),
  );
};

export const mergeConversationKnowledgeCitations = (
  previous: readonly ConversationKnowledgeCitation[],
  current: readonly ConversationKnowledgeCitation[],
): readonly ConversationKnowledgeCitation[] => {
  const byLabel = new Map(
    previous.map((citation) => [citation.citation, citation] as const),
  );
  for (const citation of current) {
    byLabel.set(citation.citation, citation);
  }
  return [...byLabel.values()].sort((left, right) =>
    left.citation.localeCompare(right.citation),
  );
};
