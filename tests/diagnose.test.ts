import { describe, expect, it } from 'vitest';
import { affectedLayers, diagnose, isOutageSample } from '../src/lib/diagnose';

describe('diagnose', () => {
  it('labels wifi outage when router is down', () => {
    const sample = { ts: Date.now(), router: null, gateway: null, internet: null };
    expect(diagnose(sample)).toBe('wifi');
    expect(affectedLayers(sample)).toEqual(['router', 'gateway', 'internet']);
    expect(isOutageSample(sample)).toBe(true);
  });

  it('labels isp outage when router is up but gateway is down', () => {
    const sample = { ts: Date.now(), router: 10, gateway: null, internet: null };
    expect(diagnose(sample)).toBe('isp');
    expect(affectedLayers(sample)).toEqual(['gateway', 'internet']);
  });

  it('labels healthy sample as unknown diagnosis', () => {
    const sample = { ts: Date.now(), router: 10, gateway: 20, internet: 30 };
    expect(diagnose(sample)).toBe('unknown');
    expect(isOutageSample(sample)).toBe(false);
  });
});