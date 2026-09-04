import type { ScheduleInput, ScheduleTiming } from './schedules';

export type ScheduleCommandMissingField = 'prompt' | 'frequency' | 'time';
export type ParsedScheduleCommand = Readonly<{
  input: ScheduleInput;
  missing: readonly ScheduleCommandMissingField[];
}>;

const chineseNumber = (value: string): number | undefined => {
  if (/^\d{1,2}$/u.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (digits[value[1] ?? ''] ?? 0);
  if (value.endsWith('十')) return (digits[value[0] ?? ''] ?? 0) * 10;
  if (value.includes('十')) {
    const [left, right] = value.split('十');
    return (digits[left ?? ''] ?? 0) * 10 + (digits[right ?? ''] ?? 0);
  }
  return digits[value];
};

const timeMatch = (source: string): { time: string; match: string } | undefined => {
  const descriptor = source.match(/(?:凌晨|早上|上午|中午|下午|傍晚|晚上)\s*([零〇一二两三四五六七八九十\d]{1,3})(?:\s*[:：]\s*([零〇一二两三四五六七八九十\d]{1,3}|半)|\s*[点时](?:\s*([零〇一二两三四五六七八九十\d]{1,3}|半)\s*分)?)?/u);
  const plain = source.match(/([零〇一二两三四五六七八九十\d]{1,3})(?:\s*[:：]\s*([零〇一二两三四五六七八九十\d]{1,3}|半)|\s*[点时](?:\s*([零〇一二两三四五六七八九十\d]{1,3}|半)\s*分)?)/u);
  const matched = descriptor ?? plain;
  if (!matched) return undefined;
  let hour = chineseNumber(matched[1] ?? '');
  const minuteSource = matched[2] ?? matched[3] ?? '';
  const minute = minuteSource === '半' ? 30 : chineseNumber(minuteSource) ?? 0;
  if (hour === undefined || minute > 59) return undefined;
  if (/(下午|傍晚|晚上)/u.test(matched[0]) && hour < 12) hour += 12;
  if (/凌晨/u.test(matched[0]) && hour === 12) hour = 0;
  if (/中午/u.test(matched[0]) && hour < 11) hour += 12;
  if (hour > 23) return undefined;
  return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, match: matched[0] };
};

const atLocalTime = (base: Date, time: string, dayOffset = 0): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hours, minutes).getTime();
};

const conciseName = (prompt: string): string => {
  const first = prompt.split(/[。！？!?\n]/u).find((part) => part.trim())?.trim() ?? '';
  return (first || '定时任务').slice(0, 30);
};

const cleanPrompt = (source: string, timingPhrases: readonly string[]): string => {
  let prompt = source
    .replace(/^\s*(?:请|麻烦)?\s*(?:帮我)?\s*(?:创建|新建|添加|设置|安排)\s*(?:一个|一条)?\s*(?:定时|计划|自动)?任务\s*[,，:：]?\s*/u, '')
    .replace(/^\s*(?:请|麻烦)?\s*(?:在)?\s*/u, '');
  for (const phrase of timingPhrases) prompt = prompt.replace(phrase, ' ');
  return prompt.replace(/^[,，。；;:：\s]+|[,，；;:：\s]+$/gu, '').replace(/\s{2,}/gu, ' ').trim();
};

export const parseScheduleCommand = (
  source: string,
  now = Date.now(),
  defaults: Pick<ScheduleInput, 'workspacePath' | 'modelProfileId'> = { workspacePath: '', modelProfileId: '' },
): ParsedScheduleCommand | null => {
  const text = source.trim();
  const explicit = /(?:创建|新建|添加|设置|安排).{0,10}(?:定时任务|计划任务|自动任务)/u.test(text);
  const reminder = /(?:分钟|小时|天)后.{0,12}(?:提醒我|执行|运行)/u.test(text);
  const natural = /^(?:请|麻烦)?\s*(?:帮我)?\s*(?:(?:每天|每日|每周[一二三四五六日天]?|工作日|今天|明天|后天).{0,16}(?:点|时|[:：])|(?:今天|明天|后天).{0,16}提醒我)/u.test(text);
  if (!explicit && !reminder && !natural) return null;

  const base = new Date(now);
  const phrases: string[] = [];
  const missing: ScheduleCommandMissingField[] = [];
  const foundTime = timeMatch(text);
  let timing: ScheduleTiming = { frequency: 'daily', time: foundTime?.time ?? '09:00', weekday: 1, runAt: now + 3_600_000 };
  let frequencyFound = false;
  let timeFound = Boolean(foundTime);
  if (foundTime) phrases.push(foundTime.match);

  const relative = text.match(/(\d+)\s*(分钟|小时|天)后/u);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] === '分钟' ? 60_000 : relative[2] === '小时' ? 3_600_000 : 86_400_000;
    timing = { ...timing, frequency: 'once', runAt: now + amount * unit };
    frequencyFound = true;
    timeFound = true;
    phrases.push(relative[0]);
  } else if (/工作日|每个工作日|周一至周五/u.test(text)) {
    timing = { ...timing, frequency: 'weekdays' };
    frequencyFound = true;
    phrases.push(text.match(/(?:每个)?工作日|周一至周五/u)?.[0] ?? '');
  } else {
    const weekly = text.match(/每(?:周|星期)([一二三四五六日天])/u);
    if (weekly) {
      const weekday = '日一二三四五六'.indexOf(weekly[1] === '天' ? '日' : weekly[1] ?? '');
      timing = { ...timing, frequency: 'weekly', weekday };
      frequencyFound = true;
      phrases.push(weekly[0]);
    } else if (/每天|每日/u.test(text)) {
      timing = { ...timing, frequency: 'daily' };
      frequencyFound = true;
      phrases.push(text.match(/每天|每日/u)?.[0] ?? '');
    }
  }

  if (!relative) {
    const day = text.match(/今天|明天|后天/u);
    const date = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/u);
    if ((day || date) && foundTime) {
      const runAt = date
        ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), ...foundTime.time.split(':').map(Number)).getTime()
        : atLocalTime(base, foundTime.time, day?.[0] === '明天' ? 1 : day?.[0] === '后天' ? 2 : 0);
      timing = { ...timing, frequency: 'once', runAt };
      frequencyFound = true;
      phrases.push(day?.[0] ?? date?.[0] ?? '');
    }
  }

  if (!frequencyFound) missing.push('frequency');
  if (!timeFound) missing.push('time');
  const prompt = cleanPrompt(text, phrases.filter(Boolean));
  if (!prompt) missing.push('prompt');
  return {
    input: {
      name: conciseName(prompt),
      prompt,
      workspacePath: defaults.workspacePath,
      modelProfileId: defaults.modelProfileId,
      enabled: true,
      autoApprove: false,
      timeoutMinutes: 120,
      timing,
    },
    missing,
  };
};
