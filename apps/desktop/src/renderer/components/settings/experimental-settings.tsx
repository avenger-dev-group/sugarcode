import { FlaskConical } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  setGoalPowerSaveEnabled,
  storedGoalPowerSaveEnabled,
} from '@/renderer/services/experimental';

export const ExperimentalSettings = () => {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = storedGoalPowerSaveEnabled();
    setEnabled(stored);
  }, []);

  const update = async (next: boolean): Promise<void> => {
    setError(null);
    try {
      await setGoalPowerSaveEnabled(next);
      setEnabled(next);
    } catch {
      setError('无法更新防休眠设置。');
    }
  };

  return (
    <>
      <header className="border-b px-6 py-5">
        <div className="flex items-center gap-2.5">
          <FlaskConical className="size-4 text-secondary" aria-hidden="true" />
          <h2 className="text-sm font-medium">实验性功能</h2>
        </div>
        <p className="mt-1.5 text-sm text-secondary">这些能力默认关闭，行为可能随版本调整。</p>
      </header>
      <div className="px-6 py-6">
        <label className="flex cursor-pointer items-start justify-between gap-5 rounded-xl border p-4">
          <span>
            <span className="block text-sm font-medium">Goal 运行时防休眠</span>
            <span className="mt-1 block text-sm text-secondary">仅在 Goal-owned Turn 实际运行期间阻止应用挂起；暂停、完成或退出时立即释放。</span>
          </span>
          <input
            type="checkbox"
            className="mt-1 size-4"
            checked={enabled}
            onChange={(event) => void update(event.target.checked)}
          />
        </label>
        {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
      </div>
    </>
  );
};
