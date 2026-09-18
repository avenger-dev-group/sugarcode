import { Check, ChevronDown, ChevronLeft, ChevronRight, Server } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/renderer/components/ui/popover';
import { cn } from '@/renderer/utils/class-name';

import type { ModelOptionViewModel } from './types';

type ModelProfilePickerProps = Readonly<{
  options: readonly ModelOptionViewModel[];
  value: string;
  onValueChange: (profileId: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  ariaLabel: string;
  side?: 'top' | 'bottom';
}>;

type ProviderGroup = Readonly<{
  id: string;
  label: string;
  models: readonly ModelOptionViewModel[];
}>;

export const ModelProfilePicker = ({
  options,
  value,
  onValueChange,
  disabled = false,
  className,
  placeholder = '未配置模型',
  ariaLabel,
  side = 'top',
}: ModelProfilePickerProps) => {
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState<string | null>(null);
  const groups = useMemo<readonly ProviderGroup[]>(() => {
    const byProvider = new Map<string, ModelOptionViewModel[]>();
    for (const option of options) {
      const group = byProvider.get(option.connectionId);
      if (group) group.push(option);
      else byProvider.set(option.connectionId, [option]);
    }
    return [...byProvider.entries()].map(([id, models]) => ({
      id,
      label: models[0]?.providerLabel ?? '未知提供商',
      models,
    }));
  }, [options]);
  const selected = options.find((option) => option.profileId === value);
  const activeGroup = groups.find((group) => group.id === providerId);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setProviderId(null);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs text-secondary outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          disabled={disabled}
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <ChevronDown
            className={cn('size-3.5 shrink-0 text-tertiary transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align="start"
        className="w-72 overflow-hidden rounded-2xl p-1"
        role="menu"
        aria-label={activeGroup ? `${activeGroup.label} 模型` : '模型提供商'}
      >
        {activeGroup ? (
          <>
            <button
              type="button"
              className="flex h-10 w-full items-center gap-2 rounded-xl px-2 text-left text-sm font-medium text-primary outline-none hover:bg-surface-hover focus-visible:bg-surface-hover"
              onClick={() => setProviderId(null)}
            >
              <ChevronLeft className="size-4 text-tertiary" aria-hidden="true" />
              <span className="truncate">{activeGroup.label}</span>
            </button>
            <div className="mx-2 h-px bg-border" />
            <div className="max-h-72 overflow-y-auto py-1">
              {activeGroup.models.map((model) => {
                const checked = model.profileId === value;
                return (
                  <button
                    key={model.profileId}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    disabled={!model.available}
                    className="flex min-h-10 w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-primary outline-none hover:bg-surface-hover focus-visible:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
                    onClick={() => {
                      onValueChange(model.profileId);
                      setOpen(false);
                      setProviderId(null);
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{model.label}</span>
                      {model.modelId && model.modelId !== model.label ? (
                        <span className="block truncate text-[11px] text-tertiary">{model.modelId}</span>
                      ) : null}
                    </span>
                    {checked ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-tertiary uppercase">
              模型提供商
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {groups.map((group) => {
                const availableCount = group.models.filter((model) => model.available).length;
                return (
                  <button
                    key={group.id}
                    type="button"
                    role="menuitem"
                    className="flex h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left outline-none hover:bg-surface-hover focus-visible:bg-surface-hover"
                    onClick={() => setProviderId(group.id)}
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface text-secondary">
                      <Server className="size-3.5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-primary">{group.label}</span>
                      <span className="block text-[11px] text-tertiary">{availableCount} 个可用模型</span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
                  </button>
                );
              })}
              {groups.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-tertiary">暂无可用提供商</p>
              ) : null}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
};
