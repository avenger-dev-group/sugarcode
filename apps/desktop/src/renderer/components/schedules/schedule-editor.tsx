import { CalendarClock, Check, FolderOpen, LoaderCircle, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/renderer/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { Textarea } from '@/renderer/components/ui/textarea';
import type { ThreadStore } from '@/renderer/components/thread/types';
import type { ScheduleInput } from '@/shared/schedules';
import type { ScheduleCommandMissingField } from '@/shared/schedule-command';
import type { useSchedules } from './use-schedules';

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const fieldClass = 'flex min-w-0 flex-col gap-1.5 text-xs font-medium';
const selectClass = 'h-9 w-full min-w-0 rounded-[10px] border border-border-strong bg-surface-raised px-3 text-sm font-normal text-foreground shadow-[var(--shadow-raised)] outline-none transition-[border-color,box-shadow] hover:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15';
const localDateInput = (time: number): string => {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

type Props = {
  value: { id?: string; input: ScheduleInput; missing?: readonly ScheduleCommandMissingField[] };
  modelOptions: ThreadStore['modelOptions'];
  request: ReturnType<typeof useSchedules>['request'];
  onClose: () => void;
};

export const ScheduleEditor = ({ value, modelOptions, request, onClose }: Props) => {
  const nameInput = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState(value.input);
  const [missing, setMissing] = useState(() => new Set(value.missing ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const update = (patch: Partial<ScheduleInput>): void => setInput((current) => ({ ...current, ...patch }));
  const resolveMissing = (field: ScheduleCommandMissingField): void => {
    setMissing((current) => {
      if (!current.has(field)) return current;
      const next = new Set(current);
      next.delete(field);
      return next;
    });
  };
  const missingLabels: Record<ScheduleCommandMissingField, string> = {
    prompt: '执行指令', frequency: '执行频率', time: '执行时间',
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-[38rem]" onOpenAutoFocus={(event) => { event.preventDefault(); nameInput.current?.focus(); }}>
        <header className="flex shrink-0 items-start gap-3 border-b px-5 py-4 sm:px-6">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border bg-surface text-secondary">
            <CalendarClock className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base font-semibold tracking-tight">
              {value.id ? '编辑定时任务' : '新建定时任务'}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs font-normal leading-5 text-secondary">
              描述任务和预期结果，Agent 将按计划调用所需能力。
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label="关闭定时任务编辑器">
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </header>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true); setError(undefined);
          void request({ action: 'save', id: value.id, input }).then((result) => {
            if (result.accepted) onClose(); else setError(result.error);
          }).finally(() => setBusy(false));
        }}>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6" data-layout="schedule-editor-fields">
            {value.missing ? <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 px-3.5 py-3 text-xs leading-5 text-amber-800">
              {missing.size > 0
                ? `已从对话识别为定时任务，请补充：${[...missing].map((field) => missingLabels[field]).join('、')}。`
                : '所需信息已补充完整，请确认后保存计划。'}
            </div> : null}
            <label className={fieldClass}>
              <span>任务名称</span>
              <Input ref={nameInput} required maxLength={120} className="font-normal" value={input.name} placeholder="例如：每日销售分析" onChange={(e) => update({ name: e.target.value })} />
            </label>
            <label className={fieldClass}>
              <span>执行指令</span>
              <Textarea required maxLength={32_000} rows={3}
                className="min-h-24 rounded-[10px] border border-border-strong bg-surface-raised text-sm shadow-[var(--shadow-raised)] transition-[border-color,box-shadow] hover:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15"
                value={input.prompt} placeholder="读取哪些资料、完成什么工作、输出什么结果？可在指令中指定技能和连接器。"
                onChange={(e) => { update({ prompt: e.target.value }); if (e.target.value.trim()) resolveMissing('prompt'); }}
              />
            </label>
            <div className="space-y-1.5">
              <label htmlFor="schedule-directory" className="block text-xs font-medium">工作目录</label>
              <div className="flex items-center gap-2">
                <Input id="schedule-directory" value={input.workspacePath} placeholder="留空则自动创建独立目录" onChange={(e) => update({ workspacePath: e.target.value })} />
                <Button type="button" variant="outline" size="icon" aria-label="选择工作目录" onClick={() => {
                  void request({ action: 'chooseDirectory' }).then((result) => { if (result.path) update({ workspacePath: result.path }); });
                }}><FolderOpen aria-hidden="true" /></Button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
              <label className={fieldClass}>
                <span>执行频率</span>
                <select required className={selectClass} value={missing.has('frequency') ? '' : input.timing.frequency} onChange={(e) => { update({ timing: { ...input.timing, frequency: e.target.value as ScheduleInput['timing']['frequency'] } }); resolveMissing('frequency'); }}>
                  {missing.has('frequency') ? <option value="">请选择执行频率</option> : null}
                  <option value="daily">每天</option>
                  <option value="weekdays">工作日（周一至周五）</option>
                  <option value="weekly">每周</option>
                  <option value="once">仅执行一次</option>
                </select>
              </label>
              <label className={fieldClass}>
                <span>执行时间</span>
                {input.timing.frequency === 'once' ? (
                  <Input required type="datetime-local" className="font-normal" value={missing.has('time') ? '' : localDateInput(input.timing.runAt)} onChange={(e) => {
                    const runAt = new Date(e.target.value).getTime();
                    if (Number.isFinite(runAt)) { update({ timing: { ...input.timing, runAt } }); resolveMissing('time'); }
                  }} />
                ) : (
                  <Input required type="time" className="font-normal" value={missing.has('time') ? '' : input.timing.time} onChange={(e) => { update({ timing: { ...input.timing, time: e.target.value } }); resolveMissing('time'); }} />
                )}
              </label>
              {input.timing.frequency === 'weekly' ? (
                <label className={fieldClass}>
                  <span>星期</span>
                  <select className={selectClass} value={input.timing.weekday} onChange={(e) => update({ timing: { ...input.timing, weekday: Number(e.target.value) } })}>
                    {weekdays.map((label, index) => <option key={index} value={index}>{label}</option>)}
                  </select>
                </label>
              ) : null}
              <label className={fieldClass}>
                <span>模型</span>
                <select className={selectClass} value={input.modelProfileId} onChange={(e) => update({ modelProfileId: e.target.value })}>
                  <option value="">使用默认模型</option>
                  {modelOptions.map((model) => <option key={model.profileId} value={model.profileId} disabled={!model.available}>{model.label}{model.available ? '' : '（不可用）'}</option>)}
                </select>
              </label>
              <label className={fieldClass}>
                <span>最长执行时间（分钟）</span>
                <Input required type="number" className="font-normal" min={1} max={1440} value={input.timeoutMinutes} onChange={(e) => update({ timeoutMinutes: Number(e.target.value) })} />
              </label>
            </div>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border bg-surface/40 p-3.5 text-xs leading-5">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-brand" checked={input.autoApprove} onChange={(e) => update({ autoApprove: e.target.checked })} />
              <span className="min-w-0"><span className="font-medium">自动批准此任务的工具操作</span><span className="mt-0.5 block text-secondary">适用于无人值守执行；项目环境首次信任仍需确认。</span></span>
            </label>
            <p className="text-[11px] leading-5 text-tertiary">每次运行保留独立结果。请保持电脑开机、不休眠，应用持续运行。错过的计划可手动补跑。</p>
          </div>
          <footer className="shrink-0 space-y-3 border-t bg-surface/25 px-5 py-4 sm:px-6">
            {error ? <p role="alert" className="text-xs leading-5 text-destructive">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
              <Button type="submit" disabled={busy || missing.size > 0}>
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}保存计划
              </Button>
            </div>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
};
