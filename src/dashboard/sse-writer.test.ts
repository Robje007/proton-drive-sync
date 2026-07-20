import { describe, expect, test } from 'bun:test';
import { createOrderedWriter } from './sse-writer.js';

describe('ordered dashboard writes', () => {
  test('keeps rapid queue updates in event order', async () => {
    const writer = createOrderedWriter();
    const updates: string[] = [];

    writer.enqueue(async () => {
      await Promise.resolve();
      updates.push('pending');
    });
    writer.enqueue(async () => {
      updates.push('processing');
    });

    await writer.drain();
    expect(updates).toEqual(['pending', 'processing']);
  });

  test('continues after a failed write and stops after close', async () => {
    const writer = createOrderedWriter();
    const updates: string[] = [];

    writer.enqueue(async () => {
      throw new Error('browser disconnected');
    });
    writer.enqueue(async () => {
      updates.push('recovered');
    });
    await writer.drain();

    writer.close();
    writer.enqueue(async () => {
      updates.push('too late');
    });
    await writer.drain();

    expect(updates).toEqual(['recovered']);
  });
});
