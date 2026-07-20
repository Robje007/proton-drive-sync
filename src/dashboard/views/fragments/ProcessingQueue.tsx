import type { FC } from 'hono/jsx';
import type { DashboardJob, SyncStatus, AuthStatusUpdate } from './types.js';
import { PauseButton } from './PauseButton.js';
import { formatPath } from './utils.js';
import { Icon } from './Icon.js';

type Props = {
  jobs: DashboardJob[];
  count: number;
  syncStatus: SyncStatus;
  authStatus: AuthStatusUpdate;
  limit: number;
};

export const ProcessingQueue: FC<Props> = ({ jobs, count, syncStatus, authStatus, limit }) => {
  const isPaused = syncStatus === 'paused';
  const isActive = syncStatus === 'syncing' && authStatus.status === 'authenticated';
  const title = isPaused ? 'Transfers paused' : isActive ? 'Uploading now' : 'Transfers on hold';
  const subtitle = isPaused
    ? 'Resume sync when you are ready'
    : isActive
      ? 'Files currently moving to Proton Drive'
      : 'Waiting for a connection and authenticated account';
  const statusDot = isPaused || !isActive ? 'bg-amber-500' : 'bg-blue-500 animate-pulse';
  const displayJobs = jobs.slice(0, limit);
  const isTruncated = jobs.length > limit;

  return (
    <>
      <div class="flex min-h-[72px] items-center justify-between gap-3 border-b border-white/8 bg-white/3 px-5 py-4">
        <div>
          <h2 class="flex items-center gap-2 text-sm font-semibold text-white">
            <span class={`h-2 w-2 rounded-full ${statusDot}`}></span>
            {title}
          </h2>
          <p class="mt-1 text-xs text-slate-500">{subtitle}</p>
        </div>
        <div class="flex shrink-0 items-center gap-3">
          {PauseButton({ syncStatus })}
          <span class="rounded-full bg-blue-400/10 px-2.5 py-1 text-xs font-semibold text-blue-300">
            {count}
          </span>
        </div>
      </div>

      {/* List */}
      <div class="custom-scrollbar flex-1 overflow-y-auto p-3">
        {displayJobs.length === 0 ? (
          <div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
            <Icon name="zap" class="w-10 h-10 opacity-20" />
            <p class="text-sm font-medium text-slate-400">Nothing uploading right now</p>
            <p class="text-xs text-slate-600">New changes will appear here automatically.</p>
          </div>
        ) : (
          <div class="space-y-1">
            {displayJobs.map((job) => (
              <div
                id={`processing-${job.id}`}
                class="group rounded-xl border border-blue-400/15 bg-blue-400/5 px-3 py-3 transition-colors hover:border-blue-400/35"
              >
                <div class="flex items-start gap-3">
                  {isActive ? (
                    <Icon name="refresh-cw" class="w-4 h-4 text-blue-500 mt-0.5 shrink-0 js-spin" />
                  ) : (
                    <Icon name="clock" class="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                  )}
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-xs font-medium text-slate-200">
                      {formatPath(job.localPath)}
                    </div>
                    <div class="mt-1 truncate font-mono text-[10px] text-slate-500">
                      {job.localPath}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Truncation footer */}
      {isTruncated && (
        <div class="px-5 py-2 border-t border-gray-700 bg-gray-800/30">
          <span class="text-xs text-gray-500">
            Showing {displayJobs.length} of {count}
          </span>
        </div>
      )}
    </>
  );
};
