import type { FC } from 'hono/jsx';

export const WelcomeModal: FC = () => {
  return (
    <div
      id="welcome-modal"
      class="fixed inset-0 z-50 flex items-center justify-center"
      sse-swap="welcome-modal"
      hx-swap="outerHTML"
    >
      {/* Backdrop */}
      <div class="absolute inset-0 bg-black/60"></div>

      {/* Modal */}
      <div class="relative bg-gray-800 border border-gray-700 rounded-xl p-8 w-full max-w-lg shadow-xl">
        {/* Icon */}
        <div class="flex justify-center mb-6">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" class="w-20 h-20">
            <rect width="64" height="64" rx="14" fill="#6d4aff" />
            <g
              fill="none"
              stroke="white"
              stroke-width="4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M40 20H24a12 12 0 0 0-12 12v2" />
              <polyline points="34,14 40,20 34,26" />
              <path d="M24 44h16a12 12 0 0 0 12-12v-2" />
              <polyline points="30,50 24,44 30,38" />
            </g>
          </svg>
        </div>

        {/* Title */}
        <h2 class="text-2xl text-white text-center mb-3">
          Welcome to <span class="font-bold">Proton NAS Sync</span>
        </h2>

        {/* Description */}
        <p class="text-gray-400 text-sm text-center mb-2">
          Configure safe one-way NAS backups and monitor every upload from one dashboard.
        </p>
        <p class="text-gray-400 text-sm text-center mb-6">
          Access it anytime at <span class="text-proton font-mono">localhost:4242</span>
        </p>

        {/* Action */}
        <div class="flex justify-center">
          <button
            type="button"
            onclick="document.getElementById('welcome-modal').remove()"
            class="px-6 py-2.5 bg-proton hover:bg-proton-dark text-white text-sm font-medium rounded-lg transition-colors"
          >
            Configure backup
          </button>
        </div>
      </div>
    </div>
  );
};
