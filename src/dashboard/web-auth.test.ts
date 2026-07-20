import { describe, expect, test } from 'bun:test';
import {
  WebAuthRateLimiter,
  accessTokenMatches,
  isSameOriginWebAuthRequest,
  isTransportAllowed,
  webAuthConfigurationError,
  type WebAuthRequestInfo,
  type WebAuthSettings,
} from './web-auth.js';

const settings: WebAuthSettings = {
  enabled: true,
  accessToken: 'a'.repeat(32),
  trustProxy: false,
};

function request(overrides: Partial<WebAuthRequestInfo> = {}): WebAuthRequestInfo {
  return {
    url: 'http://localhost:4242/api/web-auth/login',
    clientAddress: '127.0.0.1',
    origin: 'http://localhost:4242',
    host: 'localhost:4242',
    forwardedHost: null,
    forwardedProto: null,
    fetchSite: 'same-origin',
    marker: '1',
    ...overrides,
  };
}

describe('web authentication security', () => {
  test('requires a long separately configured access token', () => {
    expect(webAuthConfigurationError({ ...settings, accessToken: 'short' })).not.toBeNull();
    expect(webAuthConfigurationError(settings)).toBeNull();
  });

  test('permits localhost HTTP but rejects plain remote HTTP', () => {
    expect(isTransportAllowed(request(), settings)).toBe(true);
    expect(
      isTransportAllowed(
        request({ url: 'http://nas.local:4242/api/web-auth/login', host: 'nas.local:4242' }),
        settings
      )
    ).toBe(false);
  });

  test('permits HTTPS from an explicitly trusted proxy', () => {
    const proxySettings = { ...settings, trustProxy: true };
    expect(
      isTransportAllowed(
        request({
          url: 'http://container:4242/api/web-auth/login',
          host: 'container:4242',
          forwardedProto: 'https',
        }),
        proxySettings
      )
    ).toBe(true);
  });

  test('requires exact same origin and the custom request marker', () => {
    expect(isSameOriginWebAuthRequest(request(), settings)).toBe(true);
    expect(isSameOriginWebAuthRequest(request({ origin: 'http://localhost.evil' }), settings)).toBe(
      false
    );
    expect(isSameOriginWebAuthRequest(request({ marker: null }), settings)).toBe(false);
    expect(isSameOriginWebAuthRequest(request({ fetchSite: 'cross-site' }), settings)).toBe(false);
  });

  test('compares access tokens without direct string comparison', () => {
    expect(accessTokenMatches('a'.repeat(32), 'a'.repeat(32))).toBe(true);
    expect(accessTokenMatches('a'.repeat(32), 'b'.repeat(32))).toBe(false);
  });

  test('limits failed attempts within a rolling window', () => {
    const limiter = new WebAuthRateLimiter(2, 1000);
    expect(limiter.isAllowed('client', 1000)).toBe(true);
    limiter.recordFailure('client', 1000);
    limiter.recordFailure('client', 1100);
    expect(limiter.isAllowed('client', 1200)).toBe(false);
    expect(limiter.retryAfterSeconds('client', 1200)).toBe(1);
    expect(limiter.isAllowed('client', 2101)).toBe(true);
  });
});
