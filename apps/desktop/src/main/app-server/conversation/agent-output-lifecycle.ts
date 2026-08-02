export type AgentOutputIdentity = Readonly<{
  responseOrdinal: number;
  outputIndex: number;
}>;

export type MutableAgentOutput = {
  responseOrdinal: number;
  outputIndex: number;
  text: string;
};

const matchesOutput = (
  candidate: AgentOutputIdentity,
  output: AgentOutputIdentity,
): boolean =>
  candidate.responseOrdinal === output.responseOrdinal &&
  candidate.outputIndex === output.outputIndex;

export const appendPendingAgentOutput = (
  pendingOutputs: MutableAgentOutput[],
  output: AgentOutputIdentity,
  delta: string,
): void => {
  let pending = pendingOutputs.find((candidate) =>
    matchesOutput(candidate, output),
  );
  if (!pending) {
    if (pendingOutputs.length > 0) {
      throw new Error('Multiple unresolved Agent outputs are unsupported.');
    }
    pending = { ...output, text: '' };
    pendingOutputs.push(pending);
  }
  if (
    new TextEncoder().encode(`${pending.text}${delta}`).byteLength >
    512 * 1024
  ) {
    throw new Error('Agent output preview exceeded its size limit.');
  }
  pending.text += delta;
};

export const removePendingAgentOutput = (
  pendingOutputs: MutableAgentOutput[],
  output: AgentOutputIdentity,
): void => {
  const index = pendingOutputs.findIndex((candidate) =>
    matchesOutput(candidate, output),
  );
  if (index >= 0) {
    pendingOutputs.splice(index, 1);
  }
};
