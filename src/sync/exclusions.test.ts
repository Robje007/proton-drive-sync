import { describe, expect, test } from 'bun:test';

import { isPathExcluded, validateGlob } from './exclusions.js';

describe('exclusions', () => {
  const patterns = [{ path: '/', globs: ['node_modules', '.npm', '__pycache__'] }];

  test('excludes generated directories at every depth', () => {
    expect(
      isPathExcluded(
        '/data/Projects/app/frontend/node_modules/pkg/index.js',
        '/data/Projects',
        patterns
      )
    ).toBe(true);
    expect(
      isPathExcluded('/data/Projects/api/__pycache__/module.pyc', '/data/Projects', patterns)
    ).toBe(true);
  });

  test('does not exclude project source or git history', () => {
    expect(isPathExcluded('/data/Projects/app/src/index.ts', '/data/Projects', patterns)).toBe(
      false
    );
    expect(isPathExcluded('/data/Projects/app/.git/HEAD', '/data/Projects', patterns)).toBe(false);
  });

  test('rejects absolute globs', () => {
    expect(validateGlob('/node_modules').valid).toBe(false);
  });
});
