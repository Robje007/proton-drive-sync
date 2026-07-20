import type { FC } from 'hono/jsx';
import { Icon } from './Icon.js';

type Props = {
  enabled: boolean;
  managedByDocker?: boolean;
};

export const StartOnLoginSection: FC<Props> = ({ enabled, managedByDocker = false }) => {
  if (managedByDocker) {
    return (
      <div
        id="start-on-login-section"
        data-runtime="docker"
        class="flex min-h-[104px] items-center rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-6"
      >
        <div class="flex w-full items-center justify-between gap-5">
          <div class="flex min-w-0 items-start gap-3">
            <span class="mt-0.5 rounded-lg bg-emerald-400/10 p-2 text-emerald-300">
              <Icon name="rocket" class="h-4 w-4" />
            </span>
            <div>
              <h3 class="text-base font-semibold text-white">Start with NAS</h3>
              <p class="mt-1 text-xs leading-5 text-slate-400">
                Managed by Docker Compose. Keep{' '}
                <code class="rounded bg-slate-950/60 px-1.5 py-0.5 text-emerald-200">
                  restart: unless-stopped
                </code>{' '}
                in your YAML.
              </p>
            </div>
          </div>
          <span class="shrink-0 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300">
            Docker managed
          </span>
        </div>
      </div>
    );
  }

  const bgClass = enabled ? 'bg-proton' : 'bg-gray-600';
  const knobClass = enabled ? 'translate-x-6' : 'translate-x-1';
  const ariaChecked = enabled ? 'true' : 'false';

  return (
    <div
      id="start-on-login-section"
      class="bg-gray-800 rounded-xl border border-gray-700 p-6 h-[88px] flex items-center"
    >
      <div class="flex items-center justify-between w-full">
        <div class="flex items-center gap-3">
          <h3 class="text-lg font-semibold text-white">Start on Login</h3>
          <div class="relative group flex items-center">
            <Icon name="info" class="w-4 h-4 text-gray-500 cursor-help" />
            <div class="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-xs text-gray-300 w-72 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
              When enabled, Proton Drive Sync will automatically start when you log in.
            </div>
          </div>
        </div>
        <button
          onclick="toggleService(this)"
          class={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-proton focus:ring-offset-2 focus:ring-offset-gray-800 ${bgClass}`}
          role="switch"
          aria-checked={ariaChecked}
        >
          <span
            class={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${knobClass}`}
          ></span>
        </button>
      </div>
    </div>
  );
};
