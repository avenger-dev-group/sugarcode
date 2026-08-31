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
