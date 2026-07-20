import type { FC } from 'hono/jsx';
import type { JobCounts } from './types.js';
import { Icon } from './Icon.js';

export const Stats: FC<{ counts: JobCounts }> = ({ counts }) => {
  return (
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
      {/* Pending */}
      <div class="group relative overflow-hidden rounded-2xl border border-white/8 bg-white/4 p-5 shadow-sm transition-colors hover:border-violet-400/30">
        <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
          <Icon name="clock" class="w-12 h-12 text-amber-500" />
        </div>
        <dt class="text-xs font-medium uppercase tracking-wider text-slate-500">Waiting</dt>
        <dd class="mt-2 text-3xl font-semibold text-white transition-colors group-hover:text-violet-300">
          {counts.pending}
        </dd>
      </div>

      {/* Processing */}
      <div class="group relative overflow-hidden rounded-2xl border border-white/8 bg-white/4 p-5 shadow-sm transition-colors hover:border-blue-400/30">
        <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
          <Icon name="refresh-cw" class="w-12 h-12 text-blue-500" />
        </div>
        <dt class="text-xs font-medium uppercase tracking-wider text-slate-500">Uploading</dt>
        <dd class="mt-2 text-3xl font-semibold text-white transition-colors group-hover:text-blue-300">
          {counts.processing}
        </dd>
      </div>

      {/* Recently Synced */}
      <div class="group relative overflow-hidden rounded-2xl border border-white/8 bg-white/4 p-5 shadow-sm transition-colors hover:border-emerald-400/30">
        <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
          <Icon name="check" class="w-12 h-12 text-green-500" />
        </div>
        <dt class="text-xs font-medium uppercase tracking-wider text-slate-500">Completed</dt>
        <dd class="mt-2 text-3xl font-semibold text-white transition-colors group-hover:text-emerald-300">
          {counts.synced}
        </dd>
      </div>

      {/* Blocked */}
      <div class="group relative overflow-hidden rounded-2xl border border-white/8 bg-white/4 p-5 shadow-sm transition-colors hover:border-rose-400/30">
        <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
          <Icon name="triangle-alert" class="w-12 h-12 text-red-500" />
        </div>
        <dt class="text-xs font-medium uppercase tracking-wider text-slate-500">Needs attention</dt>
        <dd class="mt-2 text-3xl font-semibold text-white transition-colors group-hover:text-rose-300">
          {counts.blocked}
        </dd>
      </div>
    </div>
  );
};
