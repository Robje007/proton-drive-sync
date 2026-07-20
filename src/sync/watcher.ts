/**
 * File Watcher (chokidar)
 *
 * Handles file change detection using chokidar for reliable
 * cross-platform file system watching, including proper handling
 * of newly created subdirectories on macOS.
 */

import chokidar, { type FSWatcher as ChokidarWatcher } from 'chokidar';
import { statSync, existsSync, type Stats } from 'fs';
import { opendir } from 'fs/promises';
import { join, relative } from 'path';
import { eq, like } from 'drizzle-orm';
import { logger } from '../logger.js';
import { type Config, type ExcludePattern, getConfig } from '../config.js';
import { db } from '../db/index.js';
import { fileState } from '../db/schema.js';
import { isPathExcluded } from './exclusions.js';
import { SCAN_BATCH_SIZE, WATCHER_DEBOUNCE_MS } from './constants.js';

// ============================================================================
// Types
// ============================================================================

export interface FileChange {
  name: string; // Relative path from the watch root
  size: number; // File size in bytes
  mtime_ms: number; // Last modification time in milliseconds since epoch
  exists: boolean; // false if the file was deleted
  type: 'f' | 'd'; // 'f' for file, 'd' for directory
  new: boolean; // true if file is newly created
  watchRoot: string; // Which watch root this change came from
  ino: number; // Inode number (0 if unavailable)
}

export type FileChangeHandler = (file: FileChange) => void;
export type FileChangeBatchHandler = (files: FileChange[]) => void | Promise<void>;

// ============================================================================
// State
// ============================================================================

/** Track active chokidar watchers for teardown */
const activeWatchers: Map<string, ChokidarWatcher> = new Map();

// ============================================================================
// Change Token Helpers
// ============================================================================

/**
 * Build a change token from mtime and size (format: "mtime_ms:size")
 */
function buildChangeToken(mtime_ms: number, size: number): string {
  return `${mtime_ms}:${size}`;
}

/**
 * Get stored change token for a path from the database
 */
function getStoredChangeToken(localPath: string): string | null {
  const result = db.select().from(fileState).where(eq(fileState.localPath, localPath)).get();
  return result?.changeToken ?? null;
}

/**
 * Get all stored change tokens under a sync directory
 */
export function getAllStoredChangeTokens(syncDirPath: string): Map<string, string> {
  const pathPrefix = syncDirPath.endsWith('/') ? syncDirPath : `${syncDirPath}/`;
  const results = db
    .select()
    .from(fileState)
    .where(like(fileState.localPath, `${pathPrefix}%`))
    .all();

  const tokenMap = new Map<string, string>();
  for (const row of results) {
    tokenMap.set(row.localPath, row.changeToken);
  }
  return tokenMap;
}

// ============================================================================
// File System Scanning
// ============================================================================

/** Walk a tree lazily and prune excluded directories before entering them. */
async function* walkDirectory(
  watchDir: string,
  excludePatterns: ExcludePattern[],
  currentDir = watchDir
): AsyncGenerator<string> {
  let directory;
  try {
    directory = await opendir(currentDir);
  } catch (error) {
    logger.debug(
      `Unable to read directory ${currentDir}: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  for await (const entry of directory) {
    const fullPath = join(currentDir, entry.name);
    if (isPathExcluded(fullPath, watchDir, excludePatterns)) continue;
    yield fullPath;

    // Do not follow directory symlinks; they can escape the configured root or form loops.
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      yield* walkDirectory(watchDir, excludePatterns, fullPath);
    }
  }
}

/**
 * Scan a directory recursively and return all files/directories with their stats.
 * Filters out paths matching exclusion patterns.
 * @param throttleMs - Optional delay between each file stat (for background reconciliation)
 */
export async function scanDirectory(
  watchDir: string,
  excludePatterns: ExcludePattern[],
  throttleMs?: number
): Promise<Map<string, { size: number; mtime_ms: number; isDirectory: boolean; ino: number }>> {
  const results = new Map<
    string,
    { size: number; mtime_ms: number; isDirectory: boolean; ino: number }
  >();

  try {
    for await (const fullPath of walkDirectory(watchDir, excludePatterns)) {
      // Throttle if specified (for background reconciliation)
      if (throttleMs && throttleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, throttleMs));
      }

      try {
        const stats = statSync(fullPath);
        results.set(fullPath, {
          size: stats.size,
          mtime_ms: stats.mtimeMs,
          isDirectory: stats.isDirectory(),
          ino: stats.ino,
        });
      } catch {
        // File may have been deleted during scan, skip it
      }
    }
  } catch (err) {
    logger.warn(
      `Failed to scan directory ${watchDir}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return results;
}

/**
 * Compare filesystem state against stored change tokens and generate changes
 */
export function compareWithStoredChangeTokens(
  watchDir: string,
  fsState: Map<string, { size: number; mtime_ms: number; isDirectory: boolean; ino: number }>,
  storedTokens: Map<string, string>
): FileChange[] {
  const changes: FileChange[] = [];

  // Check for new and updated files
  for (const [fullPath, stats] of fsState) {
    const relativePath = relative(watchDir, fullPath);
    const currentToken = buildChangeToken(stats.mtime_ms, stats.size);
    const storedToken = storedTokens.get(fullPath);

    if (!storedToken) {
      // New file/directory
      changes.push({
        name: relativePath,
        size: stats.size,
        mtime_ms: stats.mtime_ms,
        exists: true,
        type: stats.isDirectory ? 'd' : 'f',
        new: true,
        watchRoot: watchDir,
        ino: stats.ino,
      });
    } else if (storedToken !== currentToken && !stats.isDirectory) {
      // File updated (only track changes for files, not directories)
      changes.push({
        name: relativePath,
        size: stats.size,
        mtime_ms: stats.mtime_ms,
        exists: true,
        type: 'f',
        new: false,
        watchRoot: watchDir,
        ino: stats.ino,
      });
    }
  }

  // Check for deleted files (in DB but not on filesystem)
  for (const [storedPath] of storedTokens) {
    if (!fsState.has(storedPath)) {
      const relativePath = relative(watchDir, storedPath);
      changes.push({
        name: relativePath,
        size: 0,
        mtime_ms: Date.now(),
        exists: false,
        type: 'f', // We don't know if it was a file or directory
        new: false,
        watchRoot: watchDir,
        ino: 0,
      });
    }
  }

  return changes;
}

/**
 * Stream a directory scan into bounded batches. This avoids retaining the full
 * filesystem and full change list in memory during first-run scans.
 */
async function queryDirectoryChanges(
  watchDir: string,
  excludePatterns: ExcludePattern[],
  storedTokens: Map<string, string>,
  onFileChangeBatch: FileChangeBatchHandler
): Promise<number> {
  const changes: FileChange[] = [];
  let totalChanges = 0;

  const flush = async (): Promise<void> => {
    if (changes.length === 0) return;
    const batch = changes.splice(0, changes.length);
    await onFileChangeBatch(batch);
    totalChanges += batch.length;
    // Yield so the processor, dashboard, and signal loop remain responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  try {
    for await (const fullPath of walkDirectory(watchDir, excludePatterns)) {
      // An excluded path is present, not deleted. Remove it from the deletion set.
      const storedToken = storedTokens.get(fullPath);
      storedTokens.delete(fullPath);

      try {
        const stats = statSync(fullPath);
        const currentToken = buildChangeToken(stats.mtimeMs, stats.size);
        if (!storedToken || (!stats.isDirectory() && storedToken !== currentToken)) {
          changes.push({
            name: relative(watchDir, fullPath),
            size: stats.size,
            mtime_ms: stats.mtimeMs,
            exists: true,
            type: stats.isDirectory() ? 'd' : 'f',
            new: !storedToken,
            watchRoot: watchDir,
            ino: stats.ino,
          });
        }
      } catch {
        // The path changed while scanning; the live watcher/reconciliation will catch it.
      }

      if (changes.length >= SCAN_BATCH_SIZE) await flush();
    }
  } catch (error) {
    logger.warn(
      `Failed to scan directory ${watchDir}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Only non-excluded stored paths that disappeared are remote-delete candidates.
  for (const storedPath of storedTokens.keys()) {
    if (isPathExcluded(storedPath, watchDir, excludePatterns)) continue;
    changes.push({
      name: relative(watchDir, storedPath),
      size: 0,
      mtime_ms: Date.now(),
      exists: false,
      type: 'f',
      new: false,
      watchRoot: watchDir,
      ino: 0,
    });
    if (changes.length >= SCAN_BATCH_SIZE) await flush();
  }

  await flush();
  return totalChanges;
}

// ============================================================================
// Watcher Initialization
// ============================================================================

/**
 * Initialize the watcher (no-op for chokidar - no daemon needed)
 */
export async function initializeWatcher(): Promise<void> {
  logger.debug('File watcher initialized (chokidar)');
}

/**
 * Close the watcher and clean up subscriptions
 */
export async function closeWatcher(): Promise<void> {
  await teardownWatchSubscriptions();
}

/**
 * Clear all stored file state (used by reset command to force full resync)
 * Returns the number of entries cleared
 */
export function clearAllSnapshots(): number {
  const result = db.select().from(fileState).all();
  const count = result.length;
  db.delete(fileState).run();
  return count;
}

// ============================================================================
// One-shot Query (Startup Scan)
// ============================================================================

/**
 * Query all configured directories for changes since last sync.
 * Compares filesystem state against file_state table.
 */
export async function queryAllChanges(
  config: Config,
  onFileChangeBatch: FileChangeBatchHandler
): Promise<number> {
  let totalChanges = 0;
  const excludePatterns = getConfig().exclude_patterns;

  for (const dir of config.sync_dirs) {
    const watchDir = dir.source_path;

    if (!existsSync(watchDir)) {
      logger.warn(`Sync directory does not exist: ${watchDir}`);
      continue;
    }

    // Get stored change tokens for this sync directory
    const storedTokens = getAllStoredChangeTokens(watchDir);
    const hasStoredState = storedTokens.size > 0;

    if (hasStoredState) {
      logger.info(`Syncing changes since last run for ${dir.source_path}...`);
    } else {
      logger.info(`First run - syncing all existing files in ${dir.source_path}...`);
    }

    const directoryChanges = await queryDirectoryChanges(
      watchDir,
      excludePatterns,
      storedTokens,
      onFileChangeBatch
    );
    totalChanges += directoryChanges;
    if (directoryChanges > 0) logger.info(`Queued ${directoryChanges} changes from ${watchDir}`);
  }

  return totalChanges;
}

// ============================================================================
// Chokidar Event Handlers
// ============================================================================

/**
 * Handle file add event
 */
async function handleFileAdd(
  watchDir: string,
  fullPath: string,
  stats: Stats,
  callback: FileChangeBatchHandler
): Promise<void> {
  const relativePath = relative(watchDir, fullPath);
  await callback([
    {
      name: relativePath,
      size: stats.size,
      mtime_ms: stats.mtimeMs,
      exists: true,
      type: 'f',
      new: true,
      watchRoot: watchDir,
      ino: stats.ino,
    },
  ]);
}

/**
 * Handle directory add event
 */
async function handleDirAdd(
  watchDir: string,
  fullPath: string,
  stats: Stats,
  callback: FileChangeBatchHandler
): Promise<void> {
  const relativePath = relative(watchDir, fullPath);
  await callback([
    {
      name: relativePath,
      size: stats.size,
      mtime_ms: stats.mtimeMs,
      exists: true,
      type: 'd',
      new: true,
      watchRoot: watchDir,
      ino: stats.ino,
    },
  ]);
}

/**
 * Handle file change event
 */
async function handleFileChange(
  watchDir: string,
  fullPath: string,
  stats: Stats,
  callback: FileChangeBatchHandler
): Promise<void> {
  const relativePath = relative(watchDir, fullPath);

  // Check if file actually changed using change token
  const currentToken = buildChangeToken(stats.mtimeMs, stats.size);
  const storedToken = getStoredChangeToken(fullPath);

  // If token matches, skip (no actual change)
  if (storedToken === currentToken) {
    logger.debug(`[watcher] no change detected: ${relativePath}`);
    return;
  }

  await callback([
    {
      name: relativePath,
      size: stats.size,
      mtime_ms: stats.mtimeMs,
      exists: true,
      type: 'f',
      new: false,
      watchRoot: watchDir,
      ino: stats.ino,
    },
  ]);
}

/**
 * Handle file unlink (delete) event
 */
async function handleFileUnlink(
  watchDir: string,
  fullPath: string,
  callback: FileChangeBatchHandler
): Promise<void> {
  const relativePath = relative(watchDir, fullPath);
  await callback([
    {
      name: relativePath,
      size: 0,
      mtime_ms: Date.now(),
      exists: false,
      type: 'f',
      new: false,
      watchRoot: watchDir,
      ino: 0,
    },
  ]);
}

/**
 * Handle directory unlink (delete) event
 */
async function handleDirUnlink(
  watchDir: string,
  fullPath: string,
  callback: FileChangeBatchHandler
): Promise<void> {
  const relativePath = relative(watchDir, fullPath);
  await callback([
    {
      name: relativePath,
      size: 0,
      mtime_ms: Date.now(),
      exists: false,
      type: 'd',
      new: false,
      watchRoot: watchDir,
      ino: 0,
    },
  ]);
}

// ============================================================================
// Live Watching (chokidar)
// ============================================================================

/**
 * Set up watch subscriptions for all configured directories.
 * Calls onFileChangeBatch for each batch of file changes detected.
 */
export async function setupWatchSubscriptions(
  config: Config,
  onFileChangeBatch: FileChangeBatchHandler
): Promise<void> {
  // Clear any existing subscriptions first
  await teardownWatchSubscriptions();

  const excludePatterns = getConfig().exclude_patterns;

  // Set up watches for all configured directories
  for (const dir of config.sync_dirs) {
    const watchDir = dir.source_path;

    if (!existsSync(watchDir)) {
      logger.warn(`Sync directory does not exist, skipping watch: ${watchDir}`);
      continue;
    }

    try {
      const watcher = chokidar.watch(watchDir, {
        persistent: true,
        ignoreInitial: true, // Don't emit events for existing files
        alwaysStat: true, // Get stats with events (avoid extra statSync calls)
        awaitWriteFinish: {
          stabilityThreshold: WATCHER_DEBOUNCE_MS,
          pollInterval: 100,
        },
        // Use closure to capture watchDir and excludePatterns for exclusion check
        ignored: (path: string) => isPathExcluded(path, watchDir, excludePatterns),
      });

      watcher
        .on('add', (path, stats) => {
          if (stats) {
            handleFileAdd(watchDir, path, stats, onFileChangeBatch).catch((err: unknown) => {
              logger.error(
                `Error handling file add ${path}: ${err instanceof Error ? err.message : String(err)}`
              );
            });
          }
        })
        .on('addDir', (path, stats) => {
          // Skip the root directory itself
          if (path === watchDir) return;
          if (stats) {
            handleDirAdd(watchDir, path, stats, onFileChangeBatch).catch((err: unknown) => {
              logger.error(
                `Error handling dir add ${path}: ${err instanceof Error ? err.message : String(err)}`
              );
            });
          }
        })
        .on('change', (path, stats) => {
          if (stats) {
            handleFileChange(watchDir, path, stats, onFileChangeBatch).catch((err: unknown) => {
              logger.error(
                `Error handling file change ${path}: ${err instanceof Error ? err.message : String(err)}`
              );
            });
          }
        })
        .on('unlink', (path) => {
          handleFileUnlink(watchDir, path, onFileChangeBatch).catch((err: unknown) => {
            logger.error(
              `Error handling file unlink ${path}: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        })
        .on('unlinkDir', (path) => {
          // Skip the root directory itself
          if (path === watchDir) return;
          handleDirUnlink(watchDir, path, onFileChangeBatch).catch((err: unknown) => {
            logger.error(
              `Error handling dir unlink ${path}: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        })
        .on('error', (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Watcher error for ${watchDir}: ${message}`);
        })
        .on('ready', () => {
          logger.debug(`Watcher ready for ${watchDir}`);
        });

      activeWatchers.set(watchDir, watcher);
      logger.info(`Watching ${dir.source_path} for changes...`);
    } catch (err) {
      logger.error(
        `Failed to watch ${watchDir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  logger.info('Watching for file changes... (press Ctrl+C to exit)');
}

/**
 * Tear down all active watch subscriptions.
 * Call this before re-setting up subscriptions on config change.
 */
export async function teardownWatchSubscriptions(): Promise<void> {
  if (activeWatchers.size === 0) return;

  logger.info('Tearing down watch subscriptions...');

  for (const [watchDir, watcher] of activeWatchers) {
    try {
      await watcher.close();
      logger.debug(`Closed watcher for ${watchDir}`);
    } catch (err) {
      logger.warn(`Failed to close watcher for ${watchDir}: ${(err as Error).message}`);
    }
  }

  activeWatchers.clear();
}

// ============================================================================
// Full Reconciliation (for reconcile command)
// ============================================================================

/**
 * Trigger a full filesystem reconciliation.
 * Called by the reconcile CLI command via signal.
 */
export async function triggerFullReconciliation(
  config: Config,
  onFileChangeBatch: FileChangeBatchHandler
): Promise<number> {
  logger.info('Running full filesystem reconciliation...');

  let totalChanges = 0;
  const excludePatterns = getConfig().exclude_patterns;

  for (const dir of config.sync_dirs) {
    const watchDir = dir.source_path;

    if (!existsSync(watchDir)) {
      logger.warn(`Sync directory does not exist: ${watchDir}`);
      continue;
    }

    // Get stored change tokens for this sync directory
    const storedTokens = getAllStoredChangeTokens(watchDir);

    totalChanges += await queryDirectoryChanges(
      watchDir,
      excludePatterns,
      storedTokens,
      onFileChangeBatch
    );
  }

  logger.info(`Full reconciliation complete: ${totalChanges} changes found`);
  return totalChanges;
}
