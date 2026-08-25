import { PlugZap } from 'lucide-react';
import { useEffect, useState } from 'react';

import { MainSurfaceHeader } from '@/renderer/components/foundation/main-surface-header';
import { McpSessionPanel } from '@/renderer/components/mcp/session-panel';
import { SkillsCenter } from '@/renderer/components/skills/skills-center';

type CapabilityTab = 'skills' | 'mcp';

export const CapabilityCenter = ({
  turnBusy,
  initialSkillId,
  onInitialSkillHandled,
}: Readonly<{
  turnBusy: boolean;
  initialSkillId?: string;
  onInitialSkillHandled?: () => void;
}>) => {
  const [tab, setTab] = useState<CapabilityTab>('skills');

  useEffect(() => {
    if (initialSkillId) {
      setTab('skills');
    }
  }, [initialSkillId]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <nav
        className="window-no-drag flex shrink-0 gap-1 border-b bg-surface/25 px-5 pt-2 sm:px-6"
        role="tablist"
        aria-orientation="horizontal"
        aria-label="能力类型"
      >
        <button
          type="button"
          role="tab"
          id="capability-tab-skills"
          aria-selected={tab === 'skills'}
          aria-controls="capability-panel-skills"
          onClick={() => setTab('skills')}
          className={`relative min-h-10 px-3 text-sm outline-none transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full focus-visible:ring-2 focus-visible:ring-ring ${
            tab === 'skills'
              ? 'text-primary after:bg-brand'
              : 'text-secondary after:bg-transparent hover:text-primary'
          }`}
        >
          技能
        </button>
        <button
          type="button"
          role="tab"
          id="capability-tab-mcp"
          aria-selected={tab === 'mcp'}
          aria-controls="capability-panel-mcp"
          onClick={() => setTab('mcp')}
          className={`relative min-h-10 px-3 text-sm outline-none transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full focus-visible:ring-2 focus-visible:ring-ring ${
            tab === 'mcp'
              ? 'text-primary after:bg-brand'
              : 'text-secondary after:bg-transparent hover:text-primary'
          }`}
        >
          MCP
        </button>
      </nav>

      <div className="min-h-0 min-w-0 flex-1">
        {tab === 'skills' ? (
          <section
            id="capability-panel-skills"
            className="h-full min-h-0"
            role="tabpanel"
            aria-labelledby="capability-tab-skills"
          >
            <SkillsCenter
              initialSkillId={initialSkillId}
              onInitialSkillHandled={onInitialSkillHandled}
            />
          </section>
        ) : (
          <section
            id="capability-panel-mcp"
            className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
            role="tabpanel"
            aria-labelledby="capability-tab-mcp"
          >
            <MainSurfaceHeader
              icon={<PlugZap className="size-5" aria-hidden="true" />}
              title="MCP 配置"
              description="管理本地工具服务、当前选择与连接状态。"
              compact
            />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <McpSessionPanel turnBusy={turnBusy} embedded />
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
