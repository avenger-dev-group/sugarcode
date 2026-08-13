const USER_INPUT_COMMENTARY_MAX_CHARACTERS = 400;
const STRUCTURED_DELIVERABLE_PATTERN =
  /(?:^|\n)\s*(?:#{1,6}\s+|```|\|[^\n]*\||(?:\d{1,3}|[一二三四五六七八九十]{1,3})[.、．)]\s+|(?:阶段|階段|步骤|步驟|phase|step)\s*\d+)/imu;

export const userInputBoundaryCommentary = (
  value: string,
  languageSource: string,
  questionPrompts: readonly string[],
): string => {
  const text = value.trim();
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const repeatsQuestion = questionPrompts.some(
    (question) => question.length > 0 && text.includes(question),
  );
  if (
    text.length <= USER_INPUT_COMMENTARY_MAX_CHARACTERS &&
    lines.length <= 6 &&
    !STRUCTURED_DELIVERABLE_PATTERN.test(text) &&
    !repeatsQuestion
  ) {
    return text;
  }

  const count = questionPrompts.length;
  if (/\p{Script=Han}/u.test(languageSource)) {
    return count > 0
      ? `已完成当前阶段的分析，发现 ${count} 个需要确认的决策点。`
      : '已完成当前阶段的分析，发现了需要确认的决策点。';
  }
  return count > 0
    ? `I’ve completed this stage of the analysis and found ${count} decision${count === 1 ? '' : 's'} that need confirmation.`
    : 'I’ve completed this stage of the analysis and found a decision that needs confirmation.';
};
