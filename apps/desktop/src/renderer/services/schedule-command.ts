import type { ParsedScheduleCommand } from '@/shared/schedule-command';

export const SCHEDULE_COMMAND_EVENT = 'sugarcode:schedule-command';

export const requestScheduleFromConversation = (command: ParsedScheduleCommand): void => {
  window.dispatchEvent(new CustomEvent<ParsedScheduleCommand>(SCHEDULE_COMMAND_EVENT, { detail: command }));
};
