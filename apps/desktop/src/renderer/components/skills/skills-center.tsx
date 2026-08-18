import { FileArchive, RefreshCw, Sparkles, Upload, UserRound } from 'lucide-react';

import { MainSurfaceHeader } from '@/renderer/components/foundation/main-surface-header';
import { SkillsSettingsPanel } from '@/renderer/components/skills/skills-settings-panel';
import { useStore } from '@/renderer/components/skills/use-store';
import { Button } from '@/renderer/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/renderer/components/ui/popover';

export const SkillsCenter = ({
  initialSkillId,
  onInitialSkillHandled,
}: Readonly<{
  initialSkillId?: string;
  onInitialSkillHandled?: () => void;
}> = {}) => {
  const store = useStore(true);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <MainSurfaceHeader
        icon={<Sparkles className="size-5" aria-hidden="true" />}
        title="技能"
        description="管理本地 Skills，可查看、启停，并通过目录或 ZIP 导入和导出。"
        actions={(
          <>
            <Popover
              open={store.importMenuOpen}
              onOpenChange={store.setImportMenuOpen}
            >
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={store.actionPending}
                >
                  <Upload aria-hidden="true" />
                  导入
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start px-2.5 py-2 text-left"
                  onClick={() => void store.importDirectory()}
                >
                  <UserRound aria-hidden="true" />
                  <span>
                    <span className="block text-sm">个人 Skills</span>
                    <span className="block text-xs font-normal text-tertiary">
                      在所有项目中可用
                    </span>
                  </span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start px-2.5 py-2 text-left"
                  onClick={() => void store.importArchive()}
                >
                  <FileArchive aria-hidden="true" />
                  <span>
                    <span className="block text-sm">个人 Skill ZIP</span>
                    <span className="block text-xs font-normal text-tertiary">
                      安全校验后导入
                    </span>
                  </span>
                </Button>
              </PopoverContent>
            </Popover>
            <Button
              type="button"
              variant="outline"
              disabled={store.status === 'loading' || store.actionPending}
              onClick={() => void store.refresh()}
            >
              <RefreshCw
                className={store.status === 'loading' ? 'animate-spin' : undefined}
                aria-hidden="true"
              />
              刷新扫描
            </Button>
          </>
        )}
      />
      <div className="min-h-0 flex-1">
        <SkillsSettingsPanel
          store={store}
          initialSkillId={initialSkillId}
          onInitialSkillHandled={onInitialSkillHandled}
        />
      </div>
    </div>
  );
};
