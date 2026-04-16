import { describe, expect, it } from 'vitest';
import { normalizeProbeAddress } from '../src/lib/probe';

describe('normalizeProbeAddress', () => {
  it('keeps explicit schemes unchanged', () => {
    expect(normalizeProbeAddress('https://example.com/health')).toBe('https://example.com/health');
    expect(normalizeProbeAddress('http://192.168.1.1')).toBe('http://192.168.1.1');
  });

  it('defaults private network addresses to http', () => {
    expect(normalizeProbeAddress('192.168.1.1')).toBe('http://192.168.1.1');
    expect(normalizeProbeAddress('10.0.0.1')).toBe('http://10.0.0.1');
    expect(normalizeProbeAddress('localhost')).toBe('http://localhost');
  });

  it('defaults public hosts and IPs to https', () => {
    expect(normalizeProbeAddress('connectivitycheck.gstatic.com/generate_204')).toBe(
      'https://connectivitycheck.gstatic.com/generate_204',
    );
    expect(normalizeProbeAddress('8.8.8.8')).toBe('https://8.8.8.8');
  });
});
