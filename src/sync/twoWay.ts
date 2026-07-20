/**
 * Opt-in two-way sync beta.
 *
 * Remote changes are reconciled against a persisted baseline. Downloads are
 * atomic, remote deletes are recoverable, and simultaneous edits keep both
 * versions. Upload-only mappings never enter this module.
 */

import { existsSync } from 'fs';
import { mkdir, open, rename, rm, stat, utimes } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { remoteSyncState } from '../db/schema.js';
import { logger } from '../logger.js';
import type { Config, SyncDir } from '../config.js';
import type { NodeData, ProtonDriveClient } from '../proton/types.js';
import { traverseRemotePath } from '../proton/utils.js';
import { computeFileSha1, deleteChangeToken, getFileState, storeFileState } from './fileState.js';
import { isPathExcluded } from './exclusions.js';
import { isLocalPathInside, normalizeRemoteRoot } from './paths.js';
import { deleteNodeMapping, setNodeMapping } from './nodes.js';
import { markRemoteApplication } from './remoteEcho.js';

const REMOTE_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;

type StoredRemoteState = typeof remoteSyncState.$inferSelect;

export interface TwoWayHandle {
  stop(): void;
}

export type TwoWayFileAction = 'baseline' | 'download' | 'conflict' | 'keep_local';

export function decideTwoWayFileAction(input: {
  hasPrevious: boolean;
  hashesMatch: boolean;
  remoteChanged: boolean;
  localChanged: boolean;
}): TwoWayFileAction {
  if (input.hashesMatch) return 'baseline';
  if (!input.hasPrevious) return 'conflict';
  if (input.remoteChanged && input.localChanged) return 'conflict';
  if (input.remoteChanged) return 'download';
  return 'keep_local';
}

function safeRelativePath(parts: string[]): string {
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\0')) {
      throw new Error(`Unsafe remote path component: ${JSON.stringify(part)}`);
    }
  }
  return parts.join(sep);
}

function localPathFor(syncDir: SyncDir, parts: string[]): string {
  const candidate = resolve(syncDir.source_path, safeRelativePath(parts));
  if (!isLocalPathInside(candidate, syncDir.source_path)) {
    throw new Error(`Remote path escapes local sync root: ${parts.join('/')}`);
  }
  return candidate;
}

function remotePathFor(syncDir: SyncDir, parts: string[]): string {
  const suffix = parts.join('/');
  const root = normalizeRemoteRoot(syncDir.remote_root);
  return suffix ? (root === '/' ? `/${suffix}` : `${root}/${suffix}`) : root;
}

function getStates(sourcePath: string): Map<string, StoredRemoteState> {
  return new Map(
    db
      .select()
      .from(remoteSyncState)
      .where(eq(remoteSyncState.sourcePath, sourcePath))
      .all()
      .map((state) => [state.nodeUid, state])
  );
}

function storeRemoteState(
  syncDir: SyncDir,
  node: NodeData,
  localPath: string,
  remotePath: string,
  dryRun: boolean
): void {
  if (dryRun) return;
  db.insert(remoteSyncState)
    .values({
      sourcePath: syncDir.source_path,
      nodeUid: node.uid,
      localPath,
      remotePath,
      parentNodeUid: node.parentUid ?? '',
      isDirectory: node.type === 'folder',
      revisionUid: node.activeRevision?.uid,
      contentSha1: node.activeRevision?.claimedDigests?.sha1,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [remoteSyncState.sourcePath, remoteSyncState.nodeUid],
      set: {
        localPath,
        remotePath,
        parentNodeUid: node.parentUid ?? '',
        isDirectory: node.type === 'folder',
        revisionUid: node.activeRevision?.uid,
        contentSha1: node.activeRevision?.claimedDigests?.sha1,
        updatedAt: new Date(),
      },
    })
    .run();
}

function forgetRemoteState(sourcePath: string, nodeUid: string, dryRun: boolean): void {
  if (dryRun) return;
  db.delete(remoteSyncState)
    .where(and(eq(remoteSyncState.sourcePath, sourcePath), eq(remoteSyncState.nodeUid, nodeUid)))
    .run();
}

function datedSafetyPath(syncDir: SyncDir, kind: 'conflicts' | 'recovery', localPath: string) {
  const relativePath = relative(syncDir.source_path, localPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(syncDir.source_path, `.proton-sync-${kind}`, stamp, relativePath);
}

async function moveToRecovery(syncDir: SyncDir, localPath: string, dryRun: boolean): Promise<void> {
  const recoveryPath = datedSafetyPath(syncDir, 'recovery', localPath);
  logger.warn(`[two-way beta] Remote delete preserved locally: ${localPath} -> ${recoveryPath}`);
  if (dryRun || !existsSync(localPath)) return;
  markRemoteApplication(localPath);
  await mkdir(dirname(recoveryPath), { recursive: true });
  await rename(localPath, recoveryPath);
}

async function downloadAtomic(
  client: ProtonDriveClient,
  node: NodeData,
  destination: string,
  syncDir: SyncDir,
  dryRun: boolean
): Promise<void> {
  logger.info(`[two-way beta] Downloading ${destination}`);
  if (dryRun) return;

  const tempDir = join(syncDir.source_path, '.proton-sync-tmp');
  await mkdir(tempDir, { recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  const tempPath = join(
    tempDir,
    `${node.uid.replace(/[^a-zA-Z0-9_-]/g, '_')}-${crypto.randomUUID()}`
  );
  const handle = await open(tempPath, 'wx');
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await handle.close();
    }
  };

  try {
    const stream = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await handle.write(Buffer.from(chunk));
      },
      close,
      abort: close,
    });
    const downloader = await client.getFileDownloader(node.uid);
    const controller = downloader.downloadToStream(stream);
    await controller.completion();
    await close();
    markRemoteApplication(destination);
    await rename(tempPath, destination);
    const modificationTime = node.activeRevision?.claimedModificationTime;
    if (modificationTime) await utimes(destination, new Date(), modificationTime);
  } catch (error) {
    await close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function storeDownloadedFileBaseline(
  syncDir: SyncDir,
  node: NodeData,
  localPath: string,
  remotePath: string,
  dryRun: boolean
): Promise<void> {
  if (!dryRun) {
    const fileStat = await stat(localPath);
    const sha1 = await computeFileSha1(localPath);
    db.transaction((tx) => {
      storeFileState(localPath, `${fileStat.mtimeMs}:${fileStat.size}`, sha1, false, tx);
      setNodeMapping(localPath, remotePath, node.uid, node.parentUid ?? '', false, false, tx);
    });
  }
  storeRemoteState(syncDir, node, localPath, remotePath, dryRun);
}

async function reconcileFile(
  client: ProtonDriveClient,
  syncDir: SyncDir,
  node: NodeData,
  localPath: string,
  remotePath: string,
  previous: StoredRemoteState | undefined,
  dryRun: boolean
): Promise<void> {
  const remoteSha1 = node.activeRevision?.claimedDigests?.sha1?.toLowerCase() ?? null;
  const remoteChanged = previous
    ? previous.revisionUid !== (node.activeRevision?.uid ?? null)
    : true;

  if (!existsSync(localPath)) {
    await downloadAtomic(client, node, localPath, syncDir, dryRun);
    await storeDownloadedFileBaseline(syncDir, node, localPath, remotePath, dryRun);
    return;
  }

  const localStat = await stat(localPath);
  if (!localStat.isFile()) {
    await moveToRecovery(syncDir, localPath, dryRun);
    await downloadAtomic(client, node, localPath, syncDir, dryRun);
    await storeDownloadedFileBaseline(syncDir, node, localPath, remotePath, dryRun);
    return;
  }

  const localBaseline = db.transaction((tx) => getFileState(localPath, tx));
  const currentToken = `${localStat.mtimeMs}:${localStat.size}`;
  const localSha1 =
    localBaseline?.changeToken === currentToken && localBaseline.contentSha1
      ? localBaseline.contentSha1.toLowerCase()
      : ((await computeFileSha1(localPath))?.toLowerCase() ?? null);
  const hashesMatch = Boolean(remoteSha1 && localSha1 === remoteSha1);
  if (hashesMatch) {
    await storeDownloadedFileBaseline(syncDir, node, localPath, remotePath, dryRun);
    return;
  }

  const localChanged = previous
    ? !localBaseline?.contentSha1 || localBaseline.contentSha1.toLowerCase() !== localSha1
    : true;
  const action = decideTwoWayFileAction({
    hasPrevious: Boolean(previous),
    hashesMatch,
    remoteChanged,
    localChanged,
  });

  if (action === 'download') {
    await downloadAtomic(client, node, localPath, syncDir, dryRun);
    await storeDownloadedFileBaseline(syncDir, node, localPath, remotePath, dryRun);
    return;
  }

  if (action === 'conflict') {
    const conflictPath = datedSafetyPath(syncDir, 'conflicts', localPath);
    logger.warn(`[two-way beta] Conflict preserved: remote copy -> ${conflictPath}`);
    await downloadAtomic(client, node, conflictPath, syncDir, dryRun);
    if (!dryRun) {
      const current = await stat(localPath);
      db.transaction((tx) =>
        storeFileState(localPath, `${current.mtimeMs}:${current.size}`, localSha1, false, tx)
      );
    }
  }

  storeRemoteState(syncDir, node, localPath, remotePath, dryRun);
}

async function reconcileMapping(
  client: ProtonDriveClient,
  syncDir: SyncDir,
  config: Config,
  dryRun: boolean
): Promise<void> {
  const rootResult = await client.getMyFilesRootFolder();
  if (!rootResult.ok || !rootResult.value) throw rootResult.error;
  const remoteParts = normalizeRemoteRoot(syncDir.remote_root).split('/').filter(Boolean);
  const remoteRootUid = await traverseRemotePath(client, rootResult.value.uid, remoteParts);
  if (!remoteRootUid) {
    logger.info(`[two-way beta] Remote root does not exist yet: ${syncDir.remote_root}`);
    return;
  }

  const previousStates = getStates(syncDir.source_path);
  const seen = new Set<string>();

  const walk = async (parentUid: string, parts: string[]): Promise<void> => {
    for await (const result of client.iterateFolderChildren(parentUid)) {
      if (!result.ok || !result.value) {
        // Abort the complete pass: treating a partially unreadable listing as
        // authoritative could mistake unavailable nodes for remote deletes.
        throw new Error(`Could not read a remote node: ${String(result.error)}`);
      }
      const node = result.value;
      seen.add(node.uid);
      const nodeParts = [...parts, node.name];
      const localPath = localPathFor(syncDir, nodeParts);
      const remotePath = remotePathFor(syncDir, nodeParts);

      if (isPathExcluded(localPath, syncDir.source_path, config.exclude_patterns)) {
        for (const state of previousStates.values()) {
          if (state.localPath === localPath || state.localPath.startsWith(`${localPath}${sep}`)) {
            seen.add(state.nodeUid);
          }
        }
        continue;
      }

      const previous = previousStates.get(node.uid);
      if (previous && previous.localPath !== localPath) {
        if (existsSync(previous.localPath)) {
          markRemoteApplication(previous.localPath);
          markRemoteApplication(localPath);
          if (!existsSync(localPath)) {
            if (!dryRun) {
              await mkdir(dirname(localPath), { recursive: true });
              await rename(previous.localPath, localPath);
            }
          } else {
            await moveToRecovery(syncDir, previous.localPath, dryRun);
          }
        }
        if (!dryRun) {
          db.transaction((tx) => {
            deleteChangeToken(previous.localPath, false, tx);
            deleteNodeMapping(previous.localPath, previous.remotePath, false, tx);
          });
        }
      }
      if (node.type === 'folder') {
        if (existsSync(localPath) && !(await stat(localPath)).isDirectory()) {
          await moveToRecovery(syncDir, localPath, dryRun);
        }
        if (!dryRun) {
          markRemoteApplication(localPath);
          await mkdir(localPath, { recursive: true });
        }
        if (!dryRun) {
          db.transaction((tx) =>
            setNodeMapping(localPath, remotePath, node.uid, node.parentUid ?? '', true, false, tx)
          );
        }
        storeRemoteState(syncDir, node, localPath, remotePath, dryRun);
        await walk(node.uid, nodeParts);
      } else if (node.type === 'file') {
        await reconcileFile(client, syncDir, node, localPath, remotePath, previous, dryRun);
      }
    }
  };

  await walk(remoteRootUid, []);

  for (const state of previousStates.values()) {
    if (!seen.has(state.nodeUid)) {
      await moveToRecovery(syncDir, state.localPath, dryRun);
      if (!dryRun) {
        db.transaction((tx) => {
          deleteChangeToken(state.localPath, false, tx);
          deleteNodeMapping(state.localPath, state.remotePath, false, tx);
        });
      }
      forgetRemoteState(syncDir.source_path, state.nodeUid, dryRun);
    }
  }
}

export async function startTwoWaySync(
  client: ProtonDriveClient,
  config: Config,
  dryRun: boolean
): Promise<TwoWayHandle> {
  const subscriptions: Array<{ dispose(): void }> = [];
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const scopeSchedules = new Map<string, Set<() => void>>();
  let stopped = false;

  for (const syncDir of config.sync_dirs.filter((dir) => dir.sync_mode === 'two_way')) {
    let chain = Promise.resolve();
    let eventTimer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      chain = chain
        .then(() => (stopped ? undefined : reconcileMapping(client, syncDir, config, dryRun)))
        .catch((error: unknown) => {
          logger.error(
            `[two-way beta] Reconciliation failed for ${syncDir.source_path}: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      return chain;
    };
    const scheduleRun = () => {
      if (eventTimer) clearTimeout(eventTimer);
      eventTimer = setTimeout(() => {
        eventTimer = null;
        void run();
      }, 1500);
    };

    await run();
    if (stopped) break;

    const rootResult = await client.getMyFilesRootFolder();
    if (!rootResult.ok || !rootResult.value) continue;
    const remoteRootUid = await traverseRemotePath(
      client,
      rootResult.value.uid,
      normalizeRemoteRoot(syncDir.remote_root).split('/').filter(Boolean)
    );
    if (remoteRootUid) {
      const remoteRoot = await client.getNode(remoteRootUid);
      if (remoteRoot.treeEventScopeId) {
        let schedules = scopeSchedules.get(remoteRoot.treeEventScopeId);
        if (!schedules) {
          schedules = new Set();
          scopeSchedules.set(remoteRoot.treeEventScopeId, schedules);
          subscriptions.push(
            await client.subscribeToTreeEvents(remoteRoot.treeEventScopeId, async (event) => {
              // Event bursts (for example a directory upload) collapse into
              // one bounded reconciliation per affected mapping.
              if (event.type !== 'fast_forward') {
                scopeSchedules.get(event.treeEventScopeId)?.forEach((schedule) => schedule());
              }
            })
          );
        }
        schedules.add(scheduleRun);
      }
    }
    timers.push(setInterval(() => void run(), REMOTE_RECONCILE_INTERVAL_MS));
    logger.info(`[two-way beta] Watching ${syncDir.source_path} <-> ${syncDir.remote_root}`);
  }

  return {
    stop() {
      stopped = true;
      subscriptions.forEach((subscription) => subscription.dispose());
      timers.forEach(clearInterval);
      // Event timers are short lived; stopped prevents their run from doing work.
    },
  };
}
