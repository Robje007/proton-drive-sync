import { describe, expect, test } from 'bun:test';
import { decideTwoWayFileAction } from './twoWay.js';

describe('two-way beta conflict policy', () => {
  const decide = (
    hasPrevious: boolean,
    hashesMatch: boolean,
    remoteChanged: boolean,
    localChanged: boolean
  ) => decideTwoWayFileAction({ hasPrevious, hashesMatch, remoteChanged, localChanged });

  test('baselines identical content', () =>
    expect(decide(false, true, true, true)).toBe('baseline'));
  test('keeps both versions on first contact', () =>
    expect(decide(false, false, true, true)).toBe('conflict'));
  test('downloads a remote-only change', () =>
    expect(decide(true, false, true, false)).toBe('download'));
  test('preserves simultaneous edits', () =>
    expect(decide(true, false, true, true)).toBe('conflict'));
  test('leaves a local-only edit for upload', () =>
    expect(decide(true, false, false, true)).toBe('keep_local'));
});
