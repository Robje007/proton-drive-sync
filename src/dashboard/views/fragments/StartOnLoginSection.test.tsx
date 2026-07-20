import { describe, expect, test } from 'bun:test';
import { StartOnLoginSection } from './StartOnLoginSection.js';

describe('start-on-login dashboard section', () => {
  test('shows Docker Compose as the source of truth inside a container', () => {
    const html = StartOnLoginSection({ enabled: false, managedByDocker: true })!.toString();

    expect(html).toContain('Start with NAS');
    expect(html).toContain('restart: unless-stopped');
    expect(html).toContain('Docker managed');
    expect(html).not.toContain('toggleService');
  });

  test('keeps the interactive service toggle for native installations', () => {
    const html = StartOnLoginSection({ enabled: true })!.toString();

    expect(html).toContain('Start on Login');
    expect(html).toContain('toggleService');
    expect(html).toContain('aria-checked="true"');
  });
});
