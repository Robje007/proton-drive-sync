/**
 * Proton Drive Sync - Flag Management
 *
 * Flags: Persistent process state (running, paused, etc) stored in SQLite.
 */

import { eq, like } from 'drizzle-orm';
import { readFileSync } from 'fs';
import { db, schema } from './db/index.js';

// Flag names
export const FLAGS = {
  PAUSED: 'paused',
  ONBOARDING: 'onboarding', // Data: 'about' or 'completed'
  SERVICE_INSTALLED: 'service_installed',
  SERVICE_LOADED: 'service_loaded',
  STARTUP_READY: 'startup_ready', // Set after auth + watcher initialization complete
} as const;

// Onboarding states (used as data for ONBOARDING flag)
export const ONBOARDING_STATE = {
  ABOUT: 'about',
  COMPLETED: 'completed',
} as const;

// Flag name for running PID (stored as "running_pid:<pid>")
const RUNNING_PID_FLAG = 'running_pid';

// Wildcard for clearing all variants of a flag
export const ALL_VARIANTS = '*';

// Type for db or transaction - both have the same query interface
type DbConnection = Pick<typeof db, 'insert' | 'delete' | 'select'>;

/**
 * Set a flag with optional data (stored as "flag_name:data" or just "flag_name").
 * If data is provided, clears any existing variant of this flag first.
 * Optionally accepts a transaction object for atomic operations.
 */
export function setFlag(name: string, data?: string, tx?: DbConnection): void {
  const conn = tx ?? db;
  if (data !== undefined) {
    // Clear any existing flag with this prefix first
    conn
      .delete(schema.flags)
      .where(like(schema.flags.name, `${name}:%`))
      .run();
    conn.delete(schema.flags).where(eq(schema.flags.name, name)).run();
  }
  const flagName = data !== undefined ? `${name}:${data}` : name;
  conn
    .insert(schema.flags)
    .values({ name: flagName, createdAt: new Date() })
    .onConflictDoNothing()
    .run();
}

/**
 * Clear a flag (persistent state).
 * If data is not set, clears the flag matching exactly.
 * If data is set, clears the flag with that exact data (e.g., "flag:data").
 * If data is ALL_VARIANTS (%), clears all variants of this flag.
 * Optionally accepts a transaction object for atomic operations.
 */
export function clearFlag(name: string, data?: string, tx?: DbConnection): void {
  const conn = tx ?? db;
  if (data === ALL_VARIANTS) {
    // Clear all variants: both "name" and "name:*"
    conn.delete(schema.flags).where(eq(schema.flags.name, name)).run();
    conn
      .delete(schema.flags)
      .where(like(schema.flags.name, `${name}:%`))
      .run();
  } else if (data !== undefined) {
    // Clear exact "name:data"
    conn
      .delete(schema.flags)
      .where(eq(schema.flags.name, `${name}:${data}`))
      .run();
  } else {
    // Clear exact "name"
    conn.delete(schema.flags).where(eq(schema.flags.name, name)).run();
  }
}

/**
 * Get the data portion of a flag (returns null if flag doesn't exist or has no data).
 * Optionally accepts a transaction object for atomic operations.
 */
export function getFlagData(name: string, tx?: DbConnection): string | null {
  const conn = tx ?? db;
  const row = conn
    .select()
    .from(schema.flags)
    .where(like(schema.flags.name, `${name}:%`))
    .get();
  if (!row) return null;
  return row.name.slice(name.length + 1);
}

/**
 * Check if a flag is set.
 * If data is not set, checks for exact flag name.
 * If data is set, checks for exact "name:data".
 * If data is ALL_VARIANTS (*), checks if any variant exists.
 * Optionally accepts a transaction object for atomic operations.
 */
export function hasFlag(name: string, data?: string, tx?: DbConnection): boolean {
  const conn = tx ?? db;
  if (data === ALL_VARIANTS) {
    // Check if any variant exists: "name" or "name:*"
    const exact = conn.select().from(schema.flags).where(eq(schema.flags.name, name)).get();
    if (exact) return true;
    const variant = conn
      .select()
      .from(schema.flags)
      .where(like(schema.flags.name, `${name}:%`))
      .get();
    return !!variant;
  } else if (data !== undefined) {
    // Check exact "name:data"
    const row = conn
      .select()
      .from(schema.flags)
      .where(eq(schema.flags.name, `${name}:${data}`))
      .get();
    return !!row;
  } else {
    // Check exact "name"
    const row = conn.select().from(schema.flags).where(eq(schema.flags.name, name)).get();
    return !!row;
  }
}

/**
 * Check if a process with the given PID is currently running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the Linux kernel start-time tick for a PID to distinguish PID reuse. */
function getProcessStartId(pid: number): string | null {
  if (process.platform !== 'linux') return null;

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd === -1) return null;
    const fieldsAfterCommand = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    return fieldsAfterCommand[19] ?? null;
  } catch {
    return null;
  }
}

/** Parse a lock value stored as pid,start-id (legacy values contain only a PID). */
function parseRunLock(value: string): { pid: number; startId: string | null } | null {
  const [pidValue, startId] = value.split(',', 2);
  const pid = Number.parseInt(pidValue, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, startId: startId || null };
}

/** Check both PID and process birth time, preventing false locks after container restarts. */
function isRunLockOwnerAlive(value: string): boolean {
  const lock = parseRunLock(value);
  if (!lock || !isProcessRunning(lock.pid)) return false;

  if (lock.startId) {
    return getProcessStartId(lock.pid) === lock.startId;
  }

  // Legacy locks only contain a PID. On Linux, verify that it still belongs to this app.
  if (process.platform === 'linux') {
    try {
      const commandLine = readFileSync(`/proc/${lock.pid}/cmdline`, 'utf8');
      return commandLine.includes('proton-drive-sync');
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Check if a proton-drive-sync process is currently running.
 */
export function isAlreadyRunning(): boolean {
  const lockValue = getFlagData(RUNNING_PID_FLAG);
  return lockValue ? isRunLockOwnerAlive(lockValue) : false;
}

/**
 * Check if syncing is paused.
 */
export function isPaused(): boolean {
  return hasFlag(FLAGS.PAUSED);
}

/**
 * Check if the daemon has completed startup (auth + watcher ready).
 */
export function isStartupReady(): boolean {
  return hasFlag(FLAGS.STARTUP_READY);
}

/**
 * Acquire the run lock: checks if another instance is running and marks this process as running.
 * Returns true if lock acquired, false if another instance is already running.
 * If a stale lock exists (process no longer running), it will be cleared and lock acquired.
 */
export function acquireRunLock(): boolean {
  return db.transaction((tx) => {
    // Check if another process holds the lock
    const lockValue = getFlagData(RUNNING_PID_FLAG, tx);

    if (lockValue) {
      if (isRunLockOwnerAlive(lockValue)) {
        // Process is still running, can't acquire lock
        return false;
      }
      // Process is dead, clear stale lock
      clearFlag(RUNNING_PID_FLAG, lockValue, tx);
    }

    // Clear all stale signals
    tx.delete(schema.signals).run();

    // Store our PID as the lock
    const startId = getProcessStartId(process.pid);
    setFlag(RUNNING_PID_FLAG, startId ? `${process.pid},${startId}` : String(process.pid), tx);

    return true;
  });
}

/** Remove a stale run lock, but never unlock a verified live process. */
export function clearStaleRunLock(): boolean {
  const lockValue = getFlagData(RUNNING_PID_FLAG);
  if (!lockValue) return false;
  if (isRunLockOwnerAlive(lockValue)) {
    throw new Error('Refusing to clear lock: a proton-drive-sync process is still running');
  }
  clearFlag(RUNNING_PID_FLAG, ALL_VARIANTS);
  clearFlag(FLAGS.STARTUP_READY);
  return true;
}

/**
 * Release the run lock: removes the running PID and paused flags.
 * Should be called during graceful shutdown.
 */
export function releaseRunLock(): void {
  clearFlag(FLAGS.STARTUP_READY);
  clearFlag(RUNNING_PID_FLAG, ALL_VARIANTS);
  clearFlag(FLAGS.PAUSED);
}
