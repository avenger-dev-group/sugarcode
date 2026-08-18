import {
  parseComposerSubmission,
  type ComposerReference,
} from '../../../shared/composer.ts';

type KnowledgeReferenceMessage = Readonly<{
  text: string;
  knowledgeReferences?: readonly Readonly<{
    knowledgeBaseId: string;
    name: string;
  }>[];
}>;

export const knowledgeMessagePresentation = (
  message: KnowledgeReferenceMessage,
): Readonly<{
  text: string;
  references: readonly ComposerReference[];
}> => {
  const submission = parseComposerSubmission(message.text);
  const inherited = (message.knowledgeReferences ?? []).flatMap((reference) => {
    if (
      submission.references.some(
        (candidate) =>
          candidate.kind === 'knowledge' && candidate.target === reference.name,
      )
    ) {
      return [];
    }
    const value = /\s/u.test(reference.name)
      ? `@知识库\`${reference.name}\``
      : `@知识库${reference.name}`;
    return [{
      kind: 'knowledge' as const,
      value,
      target: reference.name,
      start: 0,
      end: value.length,
    }];
  });
  return {
    text: submission.text,
    references: [...submission.references, ...inherited],
  };
};
