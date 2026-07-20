/** Short-lived guard against feeding remote-applied filesystem events back into uploads. */

import { normalizeLocalRoot } from './paths.js';

const remoteApplications = new Map<string, number>();
const SUPPRESSION_MS = 10_000;

export function markRemoteApplication(localPath: string): void {
  const now = Date.now();
  for (const [path, expiresAt] of remoteApplications) {
    if (expiresAt <= now) remoteApplications.delete(path);
  }
  remoteApplications.set(normalizeLocalRoot(localPath), now + SUPPRESSION_MS);
}

export function isRemoteApplication(localPath: string): boolean {
  const normalized = normalizeLocalRoot(localPath);
  const expiresAt = remoteApplications.get(normalized);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    remoteApplications.delete(normalized);
    return false;
  }
  return true;
}
