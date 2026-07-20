import { createHash, timingSafeEqual } from 'crypto';

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export interface WebAuthSettings {
  enabled: boolean;
  accessToken: string | null;
  trustProxy: boolean;
}

export interface WebAuthRequestInfo {
  url: string;
  clientAddress: string;
  origin: string | null;
  host: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
  fetchSite: string | null;
  marker: string | null;
}

function enabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function getWebAuthSettings(env: NodeJS.ProcessEnv = process.env): WebAuthSettings {
  const accessToken = env.WEB_AUTH_ACCESS_TOKEN?.trim() || null;
  return {
    enabled: enabled(env.WEB_AUTH_ENABLED),
    accessToken,
    trustProxy: enabled(env.WEB_AUTH_TRUST_PROXY),
  };
}

function firstHeaderValue(value: string | null): string | null {
  return value?.split(',')[0]?.trim() || null;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

export function webAuthConfigurationError(settings: WebAuthSettings): string | null {
  if (!settings.enabled) return 'Web login is disabled by the server administrator.';
  if (!settings.accessToken || settings.accessToken.length < 32) {
    return 'WEB_AUTH_ACCESS_TOKEN must contain at least 32 characters.';
  }
  return null;
}

/** Web authentication may only cross the network through TLS. Localhost HTTP is safe. */
export function isTransportAllowed(info: WebAuthRequestInfo, settings: WebAuthSettings): boolean {
  const requestUrl = new URL(info.url);
  if (isLoopbackHostname(requestUrl.hostname)) return true;
  if (requestUrl.protocol === 'https:') return true;

  return settings.trustProxy && firstHeaderValue(info.forwardedProto)?.toLowerCase() === 'https';
}

/** Reject cross-site and non-AJAX requests, then verify the browser's exact source origin. */
export function isSameOriginWebAuthRequest(
  info: WebAuthRequestInfo,
  settings: WebAuthSettings
): boolean {
  if (info.marker !== '1') return false;
  if (info.fetchSite === 'cross-site') return false;
  if (!info.origin) return false;

  const requestUrl = new URL(info.url);
  const proto = settings.trustProxy
    ? firstHeaderValue(info.forwardedProto) || requestUrl.protocol.replace(':', '')
    : requestUrl.protocol.replace(':', '');
  const host = settings.trustProxy ? firstHeaderValue(info.forwardedHost) || info.host : info.host;
  if (!host) return false;

  try {
    const source = new URL(info.origin);
    return source.origin === `${proto.toLowerCase()}://${host}`;
  } catch {
    return false;
  }
}

export function accessTokenMatches(expected: string, supplied: string): boolean {
  const expectedHash = createHash('sha256').update(expected).digest();
  const suppliedHash = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

interface AttemptBucket {
  attempts: number[];
}

export class WebAuthRateLimiter {
  private readonly buckets = new Map<string, AttemptBucket>();

  constructor(
    private readonly maxAttempts = MAX_ATTEMPTS,
    private readonly windowMs = ATTEMPT_WINDOW_MS
  ) {}

  isAllowed(key: string, now = Date.now()): boolean {
    const bucket = this.getCurrentBucket(key, now);
    return bucket.attempts.length < this.maxAttempts;
  }

  recordFailure(key: string, now = Date.now()): void {
    const bucket = this.getCurrentBucket(key, now);
    bucket.attempts.push(now);
    this.buckets.set(key, bucket);
  }

  clear(key: string): void {
    this.buckets.delete(key);
  }

  retryAfterSeconds(key: string, now = Date.now()): number {
    const bucket = this.getCurrentBucket(key, now);
    const oldest = bucket.attempts[0];
    if (oldest === undefined) return 0;
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  private getCurrentBucket(key: string, now: number): AttemptBucket {
    const cutoff = now - this.windowMs;
    const attempts = (this.buckets.get(key)?.attempts ?? []).filter((value) => value > cutoff);
    const bucket = { attempts };
    if (attempts.length === 0) this.buckets.delete(key);
    else this.buckets.set(key, bucket);
    return bucket;
  }
}
