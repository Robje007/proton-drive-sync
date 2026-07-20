/**
 * Sync Job Processor
 *
 * Executes sync jobs: create/update/delete operations against Proton Drive.
 */

import { SyncEventType } from '../db/schema.js';
import { db } from '../db/index.js';
import { createNode } from '../proton/create.js';
import { deleteNode } from '../proton/delete.js';
import { logger } from '../logger.js';
import { DEFAULT_SYNC_CONCURRENCY, getConfig } from '../config.js';
import type { ProtonDriveClient } from '../proton/types.js';
import {
  type Job,
  getNextPendingJob,
  markJobSynced,
  markJobBlocked,
  setJobError,
  categorizeError,
  scheduleRetry,
  discardJob,
} from './queue.js';
import {
  getNodeMapping,
  setNodeMapping,
  deleteNodeMapping,
  deleteNodeMappingsUnderPath,
} from './nodes.js';
import { storeFileState, deleteChangeToken, deleteChangeTokensUnderPath } from './fileState.js';
import { isPathExcluded } from './exclusions.js';
import { findSyncDirForJob } from './paths.js';

// ============================================================================
// Task Pool State (persistent across iterations)
// ============================================================================

/** Active tasks: jobId -> promise */
const activeTasks = new Map<number, Promise<void>>();

// ============================================================================
// Dynamic Concurrency
// ============================================================================

/** Current sync concurrency - can be updated via config change */
let syncConcurrency = DEFAULT_SYNC_CONCURRENCY;

/** Update the sync concurrency value */
export function setSyncConcurrency(value: number): void {
  syncConcurrency = value;
  logger.info(`Sync concurrency updated to ${value}`);
}

// ============================================================================
// Task Pool Management
// ============================================================================

/**
 * Wait for all active tasks to complete.
 */
export function waitForActiveTasks(): Promise<void> {
  return Promise.all(activeTasks.values()).then(() => {});
}

/**
 * Get the number of currently active tasks.
 */
export function getActiveTaskCount(): number {
  return activeTasks.size;
}

/**
 * Process all pending jobs until queue is empty (blocking).
 * Used for one-shot sync mode.
 */
export async function drainQueue(client: ProtonDriveClient, dryRun: boolean): Promise<void> {
  // Keep processing until no more jobs and no active tasks
  while (true) {
    processAvailableJobs(client, dryRun);

    if (activeTasks.size === 0) {
      // Check if there are more jobs (could have been added during processing)
      const job = getNextPendingJob(dryRun);
      if (!job) break; // Queue is truly empty

      // Process it directly
      const jobId = job.id;
      const taskPromise = processJob(client, job, dryRun).finally(() => {
        activeTasks.delete(jobId);
      });
      activeTasks.set(jobId, taskPromise);
    }

    // Wait for at least one task to complete
    if (activeTasks.size > 0) {
      await Promise.race(activeTasks.values());
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Extract error message from unknown error */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Helper to delete a node, throws on failure */
async function deleteNodeOrThrow(
  client: ProtonDriveClient,
  remotePath: string,
  dryRun: boolean,
  trashOnly: boolean
): Promise<{ existed: boolean; trashed: boolean }> {
  const result = await deleteNode(client, remotePath, dryRun, trashOnly);
  if (!result.success) {
    throw new Error(result.error);
  }
  return { existed: result.existed, trashed: result.trashed };
}

/** Helper to create/update a node, throws on failure */
async function createNodeOrThrow(
  client: ProtonDriveClient,
  localPath: string,
  remotePath: string,
  dryRun: boolean
): Promise<{
  nodeUid: string;
  parentNodeUid: string;
  isDirectory: boolean;
  contentSha1: string | null;
}> {
  const result = await createNode(client, localPath, remotePath, dryRun);
  if (!result.success || !result.nodeUid) {
    throw new Error(result.error ?? 'createNode returned success but no nodeUid');
  }
  return {
    nodeUid: result.nodeUid,
    parentNodeUid: result.parentNodeUid ?? 'unknown',
    isDirectory: result.isDirectory ?? false,
    contentSha1: result.contentSha1 ?? null,
  };
}

/**
 * Process available jobs up to concurrency limit (non-blocking).
 * Spawns new tasks to fill available capacity and returns immediately.
 * Call this periodically to keep the task pool saturated.
 */
export function processAvailableJobs(client: ProtonDriveClient, dryRun: boolean): void {
  // Calculate available capacity
  const availableSlots = syncConcurrency - activeTasks.size;
  if (availableSlots <= 0) return;

  // Spawn tasks to fill available slots
  for (let i = 0; i < availableSlots; i++) {
    const job = getNextPendingJob(dryRun);
    if (!job) break; // No more pending jobs

    const jobId = job.id;

    // Start the job and track it
    const taskPromise = processJob(client, job, dryRun).finally(() => {
      activeTasks.delete(jobId);
    });

    activeTasks.set(jobId, taskPromise);
  }
}

/**
 * Process a single job (internal helper).
 */
async function processJob(client: ProtonDriveClient, job: Job, dryRun: boolean): Promise<void> {
  const { id, eventType, localPath, remotePath, nRetries } = job;

  if (!remotePath) {
    throw new Error(`Job ${id} missing required remotePath`);
  }

  // Revalidate immediately before network I/O. Config and exclusions may have changed
  // after this job was queued.
  const currentConfig = getConfig();
  const syncDir = findSyncDirForJob(localPath, remotePath, currentConfig);
  if (!syncDir || isPathExcluded(localPath, syncDir.source_path, currentConfig.exclude_patterns)) {
    logger.info(`Discarding stale or excluded job ${id}: ${localPath}`);
    db.transaction((tx) => discardJob(id, localPath, dryRun, tx));
    return;
  }

  try {
    switch (eventType) {
      case SyncEventType.DELETE: {
        const config = getConfig();
        const trashOnly = config.remote_delete_behavior === 'trash';
        const actionLabel = trashOnly ? 'Trashing' : 'Permanently deleting';
        logger.info(`${actionLabel}: ${remotePath}`);

        // Check if this is a directory before deleting (needed for cleanup)
        const mapping = getNodeMapping(localPath, remotePath);
        const isDirectory = mapping?.isDirectory ?? false;

        const { existed, trashed } = await deleteNodeOrThrow(client, remotePath, dryRun, trashOnly);
        if (!existed) {
          logger.info(`Already gone: ${remotePath}`);
        } else {
          logger.info(trashed ? `Trashed: ${remotePath}` : `Permanently deleted: ${remotePath}`);
        }
        // Remove node mapping and file_state on delete
        db.transaction((tx) => {
          deleteChangeToken(localPath, dryRun, tx);
          deleteNodeMapping(localPath, remotePath, dryRun, tx);
          // For directories, also clean up all children entries
          if (isDirectory) {
            deleteChangeTokensUnderPath(localPath, tx);
            deleteNodeMappingsUnderPath(localPath, remotePath, tx);
          }
          markJobSynced(id, localPath, dryRun, tx);
        });
        return;
      }

      case SyncEventType.CREATE_FILE:
      case SyncEventType.UPDATE: {
        const typeLabel = eventType === SyncEventType.CREATE_FILE ? 'Creating' : 'Updating';
        logger.info(`${typeLabel}: ${remotePath}`);
        const { nodeUid, parentNodeUid, isDirectory, contentSha1 } = await createNodeOrThrow(
          client,
          localPath,
          remotePath,
          dryRun
        );
        logger.info(`Success: ${remotePath} -> ${nodeUid}`);
        // Store node mapping and file state for future operations
        db.transaction((tx) => {
          setNodeMapping(localPath, remotePath, nodeUid, parentNodeUid, isDirectory, dryRun, tx);
          if (job.changeToken) {
            storeFileState(localPath, job.changeToken, contentSha1, dryRun, tx);
          }
          markJobSynced(id, localPath, dryRun, tx);
        });
        return;
      }

      case SyncEventType.CREATE_DIR: {
        logger.info(`Creating directory: ${remotePath}`);

        // Step 1: Create the directory on remote
        const { nodeUid, parentNodeUid } = await createNodeOrThrow(
          client,
          localPath,
          remotePath,
          dryRun
        );
        logger.info(`Directory created: ${remotePath} -> ${nodeUid}`);

        // Step 2: Store node mapping for the directory
        db.transaction((tx) => {
          setNodeMapping(localPath, remotePath, nodeUid, parentNodeUid, true, dryRun, tx);
          if (job.changeToken) {
            storeFileState(localPath, job.changeToken, null, dryRun, tx);
          }
          markJobSynced(id, localPath, dryRun, tx);
        });

        return;
      }

      default: {
        const _exhaustive: never = eventType;
        throw new Error(`Unknown event type: ${_exhaustive}`);
      }
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const { category: errorCategory, maxRetries } = categorizeError(errorMessage);

    if (nRetries >= maxRetries && maxRetries !== Infinity) {
      // Block the job after exhausting retries
      logger.error(
        `Job ${id} (${localPath}) failed permanently after ${maxRetries} retries: ${errorMessage}`
      );
      db.transaction((tx) => {
        setJobError(id, errorMessage, dryRun, tx);
        markJobBlocked(id, localPath, errorMessage, dryRun, tx);
      });
    } else {
      // Schedule retry
      logger.error(`Job ${id} (${localPath}) failed: ${errorMessage}`);
      db.transaction((tx) => {
        setJobError(id, errorMessage, dryRun, tx);
        scheduleRetry(id, localPath, nRetries, errorCategory, dryRun, tx);
      });
    }
  }
}
