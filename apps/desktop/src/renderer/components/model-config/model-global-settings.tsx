import { AudioLines, ImageIcon, Video } from 'lucide-react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';

import type { ModelConfigStore } from './types';

const AUTOMATIC_PROFILE_VALUE = 'media:auto';

type ModelGlobalSettingsProps = Readonly<{
  store: ModelConfigStore;
}>;

export const ModelGlobalSettings = ({ store }: ModelGlobalSettingsProps) => (
  <main className="min-h-0 flex-1 overflow-y-auto">
    <fieldset
      className="mx-auto grid w-full max-w-3xl gap-5 px-5 py-5 lg:px-6"
      disabled={store.busy || !store.inspection}
    >
      <legend className="sr-only">全局模型设置</legend>

      <div>
        <h3 className="text-sm font-medium">媒体模型路由</h3>
        <p className="mt-1 text-xs leading-5 text-tertiary">
          这些设置对所有会话生效。媒体分析完成后，结果会交回当前会话模型继续处理。
        </p>
      </div>

      <section className="grid gap-4 rounded-xl border bg-surface/20 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(15rem,0.8fr)] sm:items-start">
        <div className="flex gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-secondary">
            <ImageIcon className="size-4" aria-hidden="true" />
          </span>
          <div>
            <h4 className="text-sm font-medium">图片理解</h4>
            <p className="mt-1 text-xs leading-5 text-tertiary">
              当会话需要读取图片时，优先调用指定模型；不可用时自动降级到当前模型和默认模型。
            </p>
          </div>
        </div>

        <label className="grid gap-1.5 text-sm">
          <span className="text-secondary">图片分析模型</span>
          <Select
            value={
              store.config.mediaRouting?.imageProfileId ??
              AUTOMATIC_PROFILE_VALUE
            }
            onValueChange={(value) =>
              store.setImageAnalysisProfile(
                value === AUTOMATIC_PROFILE_VALUE ? undefined : value,
              )
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTOMATIC_PROFILE_VALUE}>自动选择</SelectItem>
              {store.config.profiles.map((profile) => {
                const connection = store.config.connections.find(
                  (candidate) => candidate.id === profile.connectionId,
                );
                const available =
                  connection?.enabled === true &&
                  profile.imageInput !== 'disabled';

                return (
                  <SelectItem
                    key={profile.id}
                    value={profile.id}
                    disabled={!available}
                  >
                    {profile.displayName}
                    {available ? '' : '（不可用）'}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <span className="text-xs leading-5 text-tertiary">
            自动顺序：当前会话模型 → 默认模型
          </span>
        </label>
      </section>

      <section className="grid gap-4 rounded-xl border bg-surface/20 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(15rem,0.8fr)] sm:items-start">
        <div className="flex gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-secondary">
            <AudioLines className="size-4" aria-hidden="true" />
          </span>
          <div>
            <h4 className="text-sm font-medium">音频与会议转写</h4>
            <p className="mt-1 text-xs leading-5 text-tertiary">
              视频原生分析不可用或需要会议纪要时，用于转写音轨、区分说话人并保留时间戳。
            </p>
          </div>
        </div>

        <label className="grid gap-1.5 text-sm">
          <span className="text-secondary">音频分析模型</span>
          <Select
            value={
              store.config.mediaRouting?.audioProfileId ??
              AUTOMATIC_PROFILE_VALUE
            }
            onValueChange={(value) =>
              store.setAudioAnalysisProfile(
                value === AUTOMATIC_PROFILE_VALUE ? undefined : value,
              )
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTOMATIC_PROFILE_VALUE}>自动选择</SelectItem>
              {store.config.profiles.map((profile) => {
                const connection = store.config.connections.find(
                  (candidate) => candidate.id === profile.connectionId,
                );
                const available =
                  connection?.enabled === true &&
                  connection.wireApi !== 'anthropicMessages' &&
                  profile.audioInput !== 'disabled';

                return (
                  <SelectItem
                    key={profile.id}
                    value={profile.id}
                    disabled={!available}
                  >
                    {profile.displayName}
                    {available ? '' : '（不可用）'}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <span className="text-xs leading-5 text-tertiary">
            未指定时优先复用视频模型，再尝试当前模型与默认模型。
          </span>
        </label>
      </section>

      <section className="grid gap-4 rounded-xl border bg-surface/20 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(15rem,0.8fr)] sm:items-start">
        <div className="flex gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-secondary">
            <Video className="size-4" aria-hidden="true" />
          </span>
          <div>
            <h4 className="text-sm font-medium">视频理解</h4>
            <p className="mt-1 text-xs leading-5 text-tertiary">
              为视频分析指定支持视频输入的模型；不可用时自动降级到当前模型和默认模型。
            </p>
          </div>
        </div>

        <label className="grid gap-1.5 text-sm">
          <span className="text-secondary">视频分析模型</span>
          <Select
            value={
              store.config.mediaRouting?.videoProfileId ??
              AUTOMATIC_PROFILE_VALUE
            }
            onValueChange={(value) =>
              store.setVideoAnalysisProfile(
                value === AUTOMATIC_PROFILE_VALUE ? undefined : value,
              )
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTOMATIC_PROFILE_VALUE}>自动选择</SelectItem>
              {store.config.profiles.map((profile) => {
                const connection = store.config.connections.find(
                  (candidate) => candidate.id === profile.connectionId,
                );
                const available =
                  connection?.enabled === true &&
                  profile.videoInput !== 'disabled';

                return (
                  <SelectItem
                    key={profile.id}
                    value={profile.id}
                    disabled={!available}
                  >
                    {profile.displayName}
                    {available ? '' : '（不可用）'}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <span className="text-xs leading-5 text-tertiary">
            使用该模型连接已配置的协议；自动顺序：当前会话模型 → 默认模型
          </span>
        </label>
      </section>

      <p className="text-xs leading-5 text-tertiary">
        视频分析支持 MP4、MOV、WebM、MKV、AVI 和 MPEG，单个本地视频最大 2 GiB。系统优先按所选连接的协议直接分析；会议模式或原生视频不可用时，会分别处理画面和音轨，再按时间轴融合结果。
      </p>
    </fieldset>
  </main>
);
