const FINAL_RESPONSE_OPEN_TAG = '<final_response>';
const FINAL_RESPONSE_CLOSE_TAG = '</final_response>';
const REASONING_CLOSE_TAG = '</think>';

const withoutPartialClosingTag = (value: string, tag: string): string => {
  const maximum = Math.min(value.length, tag.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(tag.slice(0, length))) {
      return value.slice(0, -length);
    }
  }
  return value;
};

export const extractDelimitedFinalResponse = (
  value: string,
): string | undefined => {
  const explicitStart = value.lastIndexOf(FINAL_RESPONSE_OPEN_TAG);
  if (explicitStart >= 0) {
    const contentStart = explicitStart + FINAL_RESPONSE_OPEN_TAG.length;
    const explicitEnd = value.indexOf(
      FINAL_RESPONSE_CLOSE_TAG,
      contentStart,
    );
    if (
      explicitEnd >= contentStart &&
      value.slice(explicitEnd + FINAL_RESPONSE_CLOSE_TAG.length).trim()
        .length === 0
    ) {
      const content = value.slice(contentStart, explicitEnd).trim();
      return content.length > 0 ? content : undefined;
    }
  }

  const reasoningEnd = value.lastIndexOf(REASONING_CLOSE_TAG);
  if (reasoningEnd < 0) return undefined;
  const content = value.slice(reasoningEnd + REASONING_CLOSE_TAG.length).trim();
  return content.length > 0 ? content : undefined;
};

export const streamableDelimitedFinalResponse = (
  value: string,
): string | undefined => {
  const explicitStart = value.lastIndexOf(FINAL_RESPONSE_OPEN_TAG);
  if (explicitStart >= 0) {
    const contentStart = explicitStart + FINAL_RESPONSE_OPEN_TAG.length;
    const explicitEnd = value.indexOf(
      FINAL_RESPONSE_CLOSE_TAG,
      contentStart,
    );
    if (explicitEnd >= contentStart) {
      return value.slice(contentStart, explicitEnd);
    }
    return withoutPartialClosingTag(
      value.slice(contentStart),
      FINAL_RESPONSE_CLOSE_TAG,
    );
  }

  const reasoningEnd = value.lastIndexOf(REASONING_CLOSE_TAG);
  return reasoningEnd < 0
    ? undefined
    : value.slice(reasoningEnd + REASONING_CLOSE_TAG.length);
};
