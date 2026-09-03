const MODEL_FACING_FINAL_DIRECTIVES = [
  /\bnow\s+(?:produce|provide|write|craft|present|compose|return|give)\s+(?:the\s+)?final (?:answer|response)\b/iu,
  /\bfinal answer\s+(?:in|to|for)\s+(?:the\s+)?(?:user|chinese|english)\b/iu,
  /\bno files (?:were )?changed\s*,?\s*no preview\b/iu,
  /(?:现在|接下来|然后)[，,\s]*(?:生成|给出|撰写|输出|提供)(?:一份|这个|该)?(?:最终|正式)(?:答案|回复)/u,
] as const;

const INTERNAL_NARRATION_SIGNATURES = [
  {
    requestRecap:
      /^\s*(?:the user(?:'s message)?\s+(?:is|was|asks|asked|wants|wanted|requests|requested|says|said)|the request\s+(?:asks|asked|requires|required))\b/iu,
    planningTransition:
      /\b(?:let me|i (?:need|should|must|will|am going) to|we (?:need|should|must|will) to)\b/iu,
    deliveryPlanning:
      /\b(?:final (?:answer|response)|answer (?:the|this) user|respond to (?:the|this) user)\b/iu,
  },
  {
    requestRecap:
      /^\s*(?:用户的?(?:消息|请求|问题)(?:是|为|要求|想要)|(?:这个|该)?请求(?:要求|需要))/u,
    planningTransition:
      /(?:让我|我(?:需要|应该|必须|将要)|我们(?:需要|应该|必须|将要))/u,
    deliveryPlanning:
      /(?:最终|正式)(?:答案|回复)|(?:回答|回复)(?:这个|该)?用户/u,
  },
] as const;

const MODEL_SELF_DIRECTION_PATTERNS = [
  /^\s*host platform:\s*.+$/imu,
  /^\s*knowledge base:\s*.+$/imu,
  /\bI (?:should|shouldn't|need|needn't|must|will|won't|am going to)\b/iu,
  /\bLet me (?:structure|organize|present|answer|respond|think|check)\b/iu,
  /\b(?:No need for tool calls|This is a simple answer|Keep it scannable|Lead with a one-line summary)\b/iu,
] as const;

const modelSelfDirectionScore = (value: string): number =>
  MODEL_SELF_DIRECTION_PATTERNS.reduce(
    (score, pattern) => score + (pattern.test(value) ? 1 : 0),
    0,
  );

export const hasLikelyModelFacingPreamble = (value: string): boolean => {
  const text = value.trimStart();
  return (
    /^(?:host platform|knowledge base):/iu.test(text) ||
    /^(?:(?:private|internal) reasoning|private chain of thought)\b/iu.test(text) ||
    /^(?:I (?:should|shouldn't|need|must|will)|Let me (?:structure|organize|present|answer|respond|think|check))\b/iu.test(
      text,
    ) ||
    modelSelfDirectionScore(text) >= 2
  );
};

const inlineUserFacingBoundary = (value: string): number | undefined => {
  const transition = /\b(?:Keep it scannable[^\r\n]*?|Lead with a one-line summary[^\r\n]*?)[.!?]\s*(?=\p{Script=Han})/iu.exec(
    value,
  );
  return transition?.index === undefined
    ? undefined
    : transition.index + transition[0].length;
};

const modelFacingPrefixBoundary = (value: string): number | undefined => {
  if (modelSelfDirectionScore(value) < 2) return undefined;
  const candidates = [inlineUserFacingBoundary(value)];
  for (const match of value.matchAll(/\r?\n[\t ]*\r?\n/gu)) {
    candidates.push((match.index ?? 0) + match[0].length);
  }
  return candidates
    .filter((candidate): candidate is number => candidate !== undefined)
    .find((candidate) => {
      const prefix = value.slice(0, candidate).trim();
      const suffix = value.slice(candidate).trim();
      return (
        prefix.length > 0 &&
        suffix.length > 0 &&
        modelSelfDirectionScore(prefix) >= 2 &&
        modelSelfDirectionScore(suffix) === 0
      );
    });
};

const proseOnly = (value: string): string =>
  value
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/`[^`\r\n]+`/gu, '')
    .replace(/^\s{0,3}>.*$/gmu, '');

export const finalResponseCandidateIssue = (
  value: string,
): string | undefined => {
  const text = proseOnly(value.trim());
  if (text.length === 0) {
    return 'The candidate final answer is empty.';
  }
  if (MODEL_FACING_FINAL_DIRECTIVES.some((pattern) => pattern.test(text))) {
    return 'The candidate contains a model-facing instruction for producing the final answer.';
  }
  if (modelFacingPrefixBoundary(text) !== undefined) {
    return 'The candidate begins with internal work narration before the user-facing answer.';
  }
  const containsInternalNarration = INTERNAL_NARRATION_SIGNATURES.some(
    ({ requestRecap, planningTransition, deliveryPlanning }) =>
      requestRecap.test(text) &&
      planningTransition.test(text) &&
      deliveryPlanning.test(text),
  );
  return containsInternalNarration
    ? 'The candidate contains internal work narration instead of only the user-facing answer.'
    : undefined;
};

export type NormalizedFinalResponseCandidate = Readonly<{
  text: string;
  removedPrefix: boolean;
  removedPrefixText?: string;
  diagnostic?: string;
}>;

/**
 * Best-effort cleanup for providers that append the actual answer after a
 * model-facing preamble. Detection is intentionally advisory: when there is
 * no unambiguous paragraph boundary, preserve the model output instead of
 * rejecting an otherwise usable Turn.
 */
export const normalizeFinalResponseCandidate = (
  value: string,
): NormalizedFinalResponseCandidate => {
  const text = value.trim();
  const diagnostic = finalResponseCandidateIssue(text);
  if (!diagnostic || text.length === 0) {
    return { text, removedPrefix: false, diagnostic };
  }

  const detectedBoundary = modelFacingPrefixBoundary(text);
  if (detectedBoundary !== undefined) {
    return {
      text: text.slice(detectedBoundary).trim(),
      removedPrefix: true,
      removedPrefixText: text.slice(0, detectedBoundary).trim(),
      diagnostic,
    };
  }

  const paragraphBoundary = /\r?\n[\t ]*\r?\n/gu;
  for (const match of text.matchAll(paragraphBoundary)) {
    const boundaryEnd = (match.index ?? 0) + match[0].length;
    const prefix = text.slice(0, match.index).trim();
    const suffix = text.slice(boundaryEnd).trim();
    if (
      prefix.length > 0 &&
      suffix.length > 0 &&
      finalResponseCandidateIssue(prefix) !== undefined &&
      finalResponseCandidateIssue(suffix) === undefined
    ) {
      return {
        text: suffix,
        removedPrefix: true,
        removedPrefixText: prefix,
        diagnostic,
      };
    }
  }

  return { text, removedPrefix: false, diagnostic };
};
