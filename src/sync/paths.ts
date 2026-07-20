/**
 * Sync path helpers.
 *
 * Keeps local path containment checks and Proton Drive path construction
 * consistent across configuration, scanning, queue cleanup, and processing.
 */

import { normalize, relative, resolve, sep } from 'path';

import type { Config, SyncDir } from '../config.js';

/** Normalize a local sync root without a trailing separator. */
export function normalizeLocalRoot(path: string): string {
  const normalized = normalize(resolve(path));
  return normalized.length > 1 && normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized;
}

/** Normalize a Proton Drive root to exactly one leading slash and no trailing slash. */
export function normalizeRemoteRoot(path: string): string {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');

  if (segments.some((segment) => segment === '..')) {
    throw new Error('Remote root cannot contain ".." path segments');
  }

  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/** Return true when path is the root itself or a child on a path boundary. */
export function isLocalPathInside(path: string, root: string): boolean {
  const normalizedPath = normalizeLocalRoot(path);
  const normalizedRoot = normalizeLocalRoot(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

/** Build the canonical Proton Drive path for a local path in a sync directory. */
export function buildRemotePath(syncDir: SyncDir, localPath: string): string | null {
  const sourcePath = normalizeLocalRoot(syncDir.source_path);
  const normalizedLocalPath = normalizeLocalRoot(localPath);
  if (!isLocalPathInside(normalizedLocalPath, sourcePath)) return null;

  const relativePath = relative(sourcePath, normalizedLocalPath).split(sep).join('/');
  const remoteRoot = normalizeRemoteRoot(syncDir.remote_root);
  if (!relativePath) return remoteRoot;
  return remoteRoot === '/' ? `/${relativePath}` : `${remoteRoot}/${relativePath}`;
}

/** Find the configured sync directory that owns a local/remote job pair. */
export function findSyncDirForJob(
  localPath: string,
  remotePath: string,
  config: Config
): SyncDir | null {
  const normalizedRemotePath = normalizeRemoteRoot(remotePath);
  if (remotePath !== normalizedRemotePath) return null;
  return (
    config.sync_dirs.find((dir) => buildRemotePath(dir, localPath) === normalizedRemotePath) ?? null
  );
}

/** Check whether a local path is covered by at least one configured sync directory. */
export function isLocalPathConfigured(localPath: string, config: Config): boolean {
  return config.sync_dirs.some((dir) => isLocalPathInside(localPath, dir.source_path));
}

/** Return an explanation when sync directories overlap locally. */
export function findOverlappingSyncDir(
  candidatePath: string,
  syncDirs: SyncDir[],
  ignorePath?: string
): SyncDir | null {
  const candidate = normalizeLocalRoot(candidatePath);
  const ignored = ignorePath ? normalizeLocalRoot(ignorePath) : null;

  return (
    syncDirs.find((dir) => {
      const existing = normalizeLocalRoot(dir.source_path);
      if (ignored && existing === ignored) return false;
      return isLocalPathInside(candidate, existing) || isLocalPathInside(existing, candidate);
    }) ?? null
  );
}
