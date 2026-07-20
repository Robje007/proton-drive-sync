/**
 * Proton Drive Sync - Configuration
 *
 * Reads config from ~/.config/proton-drive-sync/config.json
 * Supports hot-reloading via namespaced signals (config:reload:<key>)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { logger } from './logger.js';
import { isDocker } from './environment.js';
import { getConfigDir, ensureDir, chownToEffectiveUser } from './paths.js';
import { registerSignalHandler, sendSignal } from './signals.js';
import {
  findOverlappingSyncDir,
  isLocalPathConfigured,
  normalizeLocalRoot,
  normalizeRemoteRoot,
} from './sync/paths.js';

// ============================================================================
// Types
// ============================================================================

export interface SyncDir {
  source_path: string;
  remote_root: string;
  /** Upload-only is the safe default; two_way also applies remote changes locally. */
  sync_mode?: SyncMode;
}

export type SyncMode = 'upload' | 'two_way';

export interface ExcludePattern {
  path: string; // "/" for global (all sync dirs), or absolute path
  globs: string[];
}

/** Behavior when a local file is deleted */
export const RemoteDeleteBehavior = {
  TRASH: 'trash',
  PERMANENT: 'permanent',
} as const;

export type RemoteDeleteBehavior = (typeof RemoteDeleteBehavior)[keyof typeof RemoteDeleteBehavior];

export interface Config {
  sync_dirs: SyncDir[];
  sync_concurrency: number;
  remote_delete_behavior: RemoteDeleteBehavior;
  dashboard_host: string;
  dashboard_port: number;
  exclude_patterns: ExcludePattern[];
}

/** Config keys that can be watched for changes */
export type ConfigKey = keyof Config;

// ============================================================================
// Constants
// ============================================================================

/** Base signal prefix for config reload */
export const CONFIG_RELOAD_SIGNAL = 'config:reload';

/** Signal to trigger config reload check */
export const CONFIG_CHECK_SIGNAL = 'config:check';

/** Default sync concurrency */
export const DEFAULT_SYNC_CONCURRENCY = 4;

/** Generated dependency/cache directories that are unsafe to scan by default. */
export const DEFAULT_EXCLUDE_GLOBS = [
  'node_modules',
  '.npm',
  '.pnpm-store',
  '.yarn/cache',
  '__pycache__',
  '.venv',
  'venv',
] as const;

/** Default remote delete behavior - move to trash for safety */
export const DEFAULT_REMOTE_DELETE_BEHAVIOR: RemoteDeleteBehavior = 'trash';

/** Default dashboard host (0.0.0.0 in Docker for container port forwarding, localhost otherwise) */
export const DEFAULT_DASHBOARD_HOST = isDocker() ? '0.0.0.0' : '127.0.0.1';

/** Default dashboard port */
export const DEFAULT_DASHBOARD_PORT = 4242;

/** Default configuration values */
export const defaultConfig: Config = {
  sync_dirs: [],
  sync_concurrency: DEFAULT_SYNC_CONCURRENCY,
  remote_delete_behavior: DEFAULT_REMOTE_DELETE_BEHAVIOR,
  dashboard_host: DEFAULT_DASHBOARD_HOST,
  dashboard_port: DEFAULT_DASHBOARD_PORT,
  exclude_patterns: [{ path: '/', globs: [...DEFAULT_EXCLUDE_GLOBS] }],
};

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export { CONFIG_DIR, CONFIG_FILE };

export function ensureConfigDir(): void {
  ensureDir(CONFIG_DIR);
}

// ============================================================================
// Config Singleton
// ============================================================================

let currentConfig: Config | null = null;

/**
 * Parse and validate config from file.
 * @param throwOnError - If true, throws on error. If false, returns null.
 */
function parseConfig(throwOnError: boolean): Config | null {
  if (!existsSync(CONFIG_FILE)) {
    ensureConfigDir();
    writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    chownToEffectiveUser(CONFIG_FILE);
    logger.info(`Created default config file: ${CONFIG_FILE}`);
    return { ...defaultConfig };
  }

  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content) as Config;

    if (!config.sync_dirs) {
      config.sync_dirs = [];
    } else if (!Array.isArray(config.sync_dirs)) {
      const msg = 'Config "sync_dirs" must be an array';
      if (throwOnError) {
        throw new Error(msg);
      }
      logger.error(msg);
      return null;
    }

    // Default sync_concurrency if not set
    if (config.sync_concurrency === undefined) {
      config.sync_concurrency = DEFAULT_SYNC_CONCURRENCY;
    }

    // Default remote_delete_behavior if not set
    if (config.remote_delete_behavior === undefined) {
      config.remote_delete_behavior = DEFAULT_REMOTE_DELETE_BEHAVIOR;
    }

    // Default dashboard_host if not set
    if (config.dashboard_host === undefined) {
      config.dashboard_host = DEFAULT_DASHBOARD_HOST;
    }

    // Default dashboard_port if not set
    if (config.dashboard_port === undefined) {
      config.dashboard_port = DEFAULT_DASHBOARD_PORT;
    }

    // Default exclude_patterns if not set. Existing explicit configurations are preserved.
    if (config.exclude_patterns === undefined) {
      config.exclude_patterns = [{ path: '/', globs: [...DEFAULT_EXCLUDE_GLOBS] }];
    }

    // Validate all sync_dirs entries
    const normalizedSyncDirs: SyncDir[] = [];
    for (const dir of config.sync_dirs) {
      if (typeof dir === 'string') {
        const msg =
          'Config sync_dirs must be objects with "source_path" and "remote_root" properties. ' +
          'Example: {"sync_dirs": [{"source_path": "/path/to/dir", "remote_root": "/backup"}]}';
        if (throwOnError) {
          throw new Error(msg);
        }
        logger.error(msg);
        return null;
      }
      if (!dir.source_path) {
        const msg = 'Each sync_dirs entry must have a "source_path" property';
        if (throwOnError) {
          throw new Error(msg);
        }
        logger.error(msg);
        return null;
      }

      dir.source_path = normalizeLocalRoot(dir.source_path);
      dir.remote_root = normalizeRemoteRoot(dir.remote_root || '/');
      dir.sync_mode = dir.sync_mode || 'upload';
      if (dir.sync_mode !== 'upload' && dir.sync_mode !== 'two_way') {
        const msg = `Invalid sync mode for ${dir.source_path}: ${String(dir.sync_mode)}`;
        if (throwOnError) throw new Error(msg);
        logger.error(msg);
        return null;
      }

      if (!existsSync(dir.source_path)) {
        const msg = `Sync directory does not exist: ${dir.source_path}`;
        if (throwOnError) {
          throw new Error(msg);
        }
        logger.error(msg);
        return null;
      }

      const overlap = findOverlappingSyncDir(dir.source_path, normalizedSyncDirs);
      if (overlap) {
        const msg =
          `Overlapping sync directories are not allowed: ${dir.source_path} overlaps ` +
          overlap.source_path;
        if (throwOnError) throw new Error(msg);
        logger.error(msg);
        return null;
      }

      normalizedSyncDirs.push(dir);
    }

    config.sync_dirs = normalizedSyncDirs;

    return config;
  } catch (error) {
    // Re-throw our own errors
    if (error instanceof Error && !('code' in error)) {
      throw error;
    }

    let msg: string;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      msg = `Config file not found: ${CONFIG_FILE}`;
    } else if (error instanceof SyntaxError) {
      msg = `Invalid JSON in config file: ${CONFIG_FILE}`;
    } else {
      msg = `Error reading config: ${(error as Error).message}`;
    }
    if (throwOnError) {
      throw new Error(msg);
    }
    logger.error(msg);
    return null;
  }
}

/**
 * Get the current config. Auto-loads on first call.
 * Throws an error if config is invalid.
 */
export function getConfig(): Config {
  if (!currentConfig) {
    currentConfig = parseConfig(true)!;
  }
  return currentConfig;
}

/**
 * Check if a path is within any of the configured sync directories.
 */
export function isPathWatched(localPath: string): boolean {
  return isLocalPathConfigured(localPath, getConfig());
}

/** Check if two values are deeply equal (for sync_dirs array comparison) */
function isEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reload config from file and send signals for changed keys.
 */
function reloadConfig(): void {
  const oldConfig = currentConfig;
  const newConfig = parseConfig(false);
  if (!newConfig) {
    logger.warn('Config reload failed, keeping previous config');
    return;
  }

  currentConfig = newConfig;
  logger.info('Config reloaded');

  if (!oldConfig) return;

  // Send signals for keys that changed
  const keys: ConfigKey[] = [
    'sync_dirs',
    'sync_concurrency',
    'remote_delete_behavior',
    'dashboard_host',
    'dashboard_port',
    'exclude_patterns',
  ];
  for (const key of keys) {
    if (!isEqual(oldConfig[key], newConfig[key])) {
      logger.debug(`Config key "${key}" changed, sending signal`);
      sendSignal(`${CONFIG_RELOAD_SIGNAL}:${key}`);
    }
  }
}

/**
 * Register a handler for changes to a specific config key.
 * Handler is called when config:reload:<key> signal is received.
 */
export function onConfigChange(key: ConfigKey, handler: () => void): void {
  registerSignalHandler(`${CONFIG_RELOAD_SIGNAL}:${key}`, handler);
}

/**
 * Start watching for config check signals.
 * When received, reloads config and sends signals for changed keys.
 */
export function watchConfig(): void {
  registerSignalHandler(CONFIG_CHECK_SIGNAL, reloadConfig);
}
