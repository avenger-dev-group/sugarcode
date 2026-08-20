import { useState } from 'react';
import { Cpu, Plus } from 'lucide-react';
import { Tabs } from 'radix-ui';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog';
import { Button } from '@/renderer/components/ui/button';

import { ModelConfigSaveBar } from './model-config-save-bar';
import { ModelGlobalSettings } from './model-global-settings';
import { ModelProfileSettings } from './model-profile-settings';
import type { ModelConfigSettingsPanelProps } from './types';
import { useStore } from './use-store';

type SettingsSection = 'models' | 'global';

const SETTINGS_SECTIONS: ReadonlyArray<
  Readonly<{ id: SettingsSection; label: string }>
> = [
  { id: 'models', label: '基础模型' },
  { id: 'global', label: '全局设置' },
];

export const ModelConfigSettingsPanel = (
  props: ModelConfigSettingsPanelProps,
) => {
  const store = useStore(props);
  const [section, setSection] = useState<SettingsSection>('models');

  return (
    <>
      <Tabs.Root
        className="flex h-full min-h-0 flex-col"
        value={section}
        onValueChange={(value) => setSection(value as SettingsSection)}
      >
        <header className="flex h-[4.25rem] shrink-0 items-center gap-3 border-b px-6">
          <Cpu className="size-4 text-secondary" aria-hidden="true" />
          <h2 className="text-sm font-medium">模型配置</h2>
          {section === 'models' ? (
            <Button
              className="ml-auto"
              type="button"
              size="lg"
              variant="outline"
              disabled={store.busy}
              onClick={store.addConfiguration}
            >
              <Plus aria-hidden="true" />
              新建
            </Button>
          ) : null}
        </header>

        <Tabs.List
          className="flex shrink-0 gap-1 border-b bg-surface/25 px-5 pt-2 lg:px-6"
          aria-label="模型配置分类"
        >
          {SETTINGS_SECTIONS.map((item) => {
            const selected = section === item.id;

            return (
              <Tabs.Trigger
                key={item.id}
                value={item.id}
                className={`relative min-h-10 px-3 text-sm outline-none transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? 'text-primary after:bg-brand'
                    : 'text-secondary after:bg-transparent hover:text-primary'
                }`}
              >
                {item.label}
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>

        <Tabs.Content value="models" className="flex min-h-0 flex-1 flex-col">
          <ModelProfileSettings store={store} />
        </Tabs.Content>
        <Tabs.Content value="global" className="flex min-h-0 flex-1 flex-col">
          <ModelGlobalSettings store={store} />
        </Tabs.Content>

        <ModelConfigSaveBar
          store={store}
          showCloseAction={props.showCloseAction}
        />
      </Tabs.Root>

      <AlertDialog
        open={store.deleteCredentialOpen}
        onOpenChange={store.setDeleteCredentialOpen}
      >
        <AlertDialogContent className="max-w-md p-5">
          <AlertDialogHeader>
            <AlertDialogTitle>删除已保存的 API 密钥？</AlertDialogTitle>
            <AlertDialogDescription>
              模型配置和接口地址会保留，正在进行的回合不会受到影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-5">
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline">
                取消
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                onClick={store.deleteCredential}
              >
                删除 API 密钥
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
