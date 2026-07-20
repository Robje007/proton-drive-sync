import { describe, expect, test } from 'bun:test';

import type { Config, SyncDir } from '../config.js';
import {
  buildRemotePath,
  findOverlappingSyncDir,
  findSyncDirForJob,
  isLocalPathInside,
  normalizeRemoteRoot,
} from './paths.js';

const mapping: SyncDir = {
  source_path: '/data/robin/Projects',
  remote_root: '/backupnas/',
};

describe('remote path normalization', () => {
  test('uses one leading slash and removes trailing slashes', () => {
    expect(normalizeRemoteRoot('//backupnas///projects/')).toBe('/backupnas/projects');
    expect(normalizeRemoteRoot('/')).toBe('/');
  });

  test('never creates a double slash for a root mapping', () => {
    expect(
      buildRemotePath({ source_path: '/data/robin', remote_root: '/' }, '/data/robin/Projects/app')
    ).toBe('/Projects/app');
  });

  test('maps a project to the configured remote root', () => {
    expect(buildRemotePath(mapping, '/data/robin/Projects/meteowarning.eu/.git/HEAD')).toBe(
      '/backupnas/meteowarning.eu/.git/HEAD'
    );
  });
});

describe('local path boundaries', () => {
  test('does not confuse similarly prefixed directories', () => {
    expect(isLocalPathInside('/data/project-old/file', '/data/project')).toBe(false);
    expect(isLocalPathInside('/data/project/file', '/data/project')).toBe(true);
  });

  test('detects nested mappings', () => {
    expect(
      findOverlappingSyncDir('/data/robin/Projects', [
        { source_path: '/data/robin', remote_root: '/' },
      ])?.source_path
    ).toBe('/data/robin');
  });
});

test('old remote-root jobs no longer match current config', () => {
  const config = {
    sync_dirs: [mapping],
    sync_concurrency: 2,
    remote_delete_behavior: 'trash',
    dashboard_host: '127.0.0.1',
    dashboard_port: 4242,
    exclude_patterns: [],
  } satisfies Config;

  expect(
    findSyncDirForJob(
      '/data/robin/Projects/meteowarning.eu/package.json',
      '//Projects/meteowarning.eu/package.json',
      config
    )
  ).toBeNull();
  expect(
    findSyncDirForJob(
      '/data/robin/Projects/meteowarning.eu/package.json',
      '/backupnas/meteowarning.eu/package.json',
      config
    )
  ).toEqual(mapping);
});

test('legacy double-slash jobs are discarded even for a root mapping', () => {
  const config = {
    sync_dirs: [{ source_path: '/data/robin', remote_root: '/' }],
    sync_concurrency: 2,
    remote_delete_behavior: 'trash',
    dashboard_host: '127.0.0.1',
    dashboard_port: 4242,
    exclude_patterns: [],
  } satisfies Config;

  expect(
    findSyncDirForJob(
      '/data/robin/Projects/meteowarning.eu/package.json',
      '//Projects/meteowarning.eu/package.json',
      config
    )
  ).toBeNull();
});
