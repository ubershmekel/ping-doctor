import { describe, expect, it } from 'vitest';
import { deriveRouterIp } from '../src/lib/network';

describe('deriveRouterIp', () => {
  it('derives x.x.x.1 from local IPv4', () => {
    expect(deriveRouterIp('192.168.50.42')).toBe('192.168.50.1');
  });

  it('returns null on malformed IP', () => {
    expect(deriveRouterIp('not-an-ip')).toBeNull();
  });
});
