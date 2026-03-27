import { describe, expect, it } from 'vitest';
import { failedTargetIds, diagnose, firstFailedTargetId, isOutageSample } from '../src/lib/diagnose';

describe('diagnose', () => {
  it('detects outage when any enabled target is down', () => {
    const sample = {
      ts: Date.now(),
      enabledTargetIds: ['a', 'b', 'c'],
      results: { a: 12, b: null, c: 31 }
    };

    expect(diagnose(sample)).toBe('target');
    expect(failedTargetIds(sample)).toEqual(['b']);
    expect(firstFailedTargetId(sample)).toBe('b');
    expect(isOutageSample(sample)).toBe(true);
  });

  it('detects healthy sample when all enabled targets are up', () => {
    const sample = {
      ts: Date.now(),
      enabledTargetIds: ['a', 'b'],
      results: { a: 10, b: 20 }
    };

    expect(diagnose(sample)).toBe('unknown');
    expect(failedTargetIds(sample)).toEqual([]);
    expect(isOutageSample(sample)).toBe(false);
  });
});
