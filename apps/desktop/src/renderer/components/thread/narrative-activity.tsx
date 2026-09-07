import { AgentCommentary } from '@/renderer/components/agent/agent-commentary';
import type { AgentCommentaryViewModel } from '@/renderer/components/agent/types';

export const NarrativeActivity = ({
  activity,
}: Readonly<{
  activity: AgentCommentaryViewModel;
}>) => <AgentCommentary commentary={activity} />;
