import type { FC } from 'hono/jsx';
import type { DashboardJob } from './types.js';
import { formatPath } from './utils.js';
import { Icon } from './Icon.js';

type Props = {
  jobs: DashboardJob[];
  count: number;
  limit: number;
};

export const PendingQueue: FC<Props> = ({ jobs, count, limit }) => {
  const displayJobs = jobs.slice(0, limit);
  const isTruncated = jobs.length > limit;

  return (
    <>
      <div class="flex min-h-[72px] items-center justify-between gap-3 border-b border-white/8 bg-white/3 px-5 py-4">
        <div>
          <h2 class="flex items-center gap-2 text-sm font-semibold text-white">
            <span class="h-2 w-2 rounded-full bg-violet-400"></span>
            Up next
          </h2>
          <p class="mt-1 text-xs text-slate-500">Ready and waiting for an upload slot</p>
        </div>
        <div class="flex shrink-0 items-center gap-3">
          <span class="text-[10px] font-medium uppercase tracking-wider text-slate-600">Live</span>
          <span class="rounded-full bg-violet-400/10 px-2.5 py-1 text-xs font-semibold text-violet-300">
            {count}
          </span>
        </div>
      </div>

      {/* List */}
      <div class="custom-scrollbar flex-1 overflow-y-auto p-3">
        {displayJobs.length === 0 ? (
          <div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
            <Icon name="circle-check" class="h-10 w-10 opacity-20" />
            <p class="text-sm font-medium text-slate-400">All caught up</p>
            <p class="text-xs text-slate-600">There are no files waiting to upload.</p>
          </div>
        ) : (
          <div class="space-y-1">
            {displayJobs.map((job) => (
              <div
                id={`pending-${job.id}`}
                class="flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors hover:border-white/8 hover:bg-white/4"
              >
                <Icon name="clock" class="w-4 h-4 text-amber-500 shrink-0" />
                <div class="min-w-0 flex-1">
                  <span class="block truncate text-xs font-medium text-slate-300">
                    {formatPath(job.localPath)}
                  </span>
                  <span class="mt-0.5 block truncate font-mono text-[10px] text-slate-600">
                    {job.remotePath}
                  </span>
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
