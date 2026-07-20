/** Safely clear a stale process lock. */

import { clearStaleRunLock } from '../flags.js';
import { logger } from '../logger.js';

export function unlockCommand(): void {
  try {
    const removed = clearStaleRunLock();
    logger.info(removed ? 'Stale process lock cleared.' : 'No process lock found.');
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
