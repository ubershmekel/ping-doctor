import { beforeEach, describe, expect, it } from 'vitest';
import { getStorageSnapshot, recordSample, runRollup } from '../src/lib/storage';

type LocalStore = Record<string, unknown>;

describe('storage lifecycle', () => {
  let state: LocalStore;

  beforeEach(() => {
    state = {};
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: state[key] }),
          set: async (value: Record<string, unknown>) => {
            Object.assign(state, value);
          }
        }
      }
    };
  });

  it('opens and closes outages based on subsequent healthy sample', async () => {
    const now = Date.now();
    await recordSample(
      { ts: now, enabledTargetIds: ['router'], results: { router: null } },
      'target',
      'router'
    );
    await recordSample(
      { ts: now + 1, enabledTargetIds: ['router'], results: { router: 8 } },
      'unknown',
      null
    );

    const snapshot = await getStorageSnapshot();
    expect(snapshot.outages).toHaveLength(1);
    expect(snapshot.outages[0].start).toBe(now);
    expect(snapshot.outages[0].end).toBe(now + 1);
    expect(snapshot.state.currentOutage).toBeNull();
  });

  it('rolls old samples into day summaries and trims raw sample retention', async () => {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

    await recordSample(
      { ts: eightDaysAgo, enabledTargetIds: ['a'], results: { a: 10 } },
      'unknown',
      null
    );
    await recordSample(
      { ts: now, enabledTargetIds: ['a'], results: { a: 12 } },
      'unknown',
      null
    );

    await runRollup(now);

    const snapshot = await getStorageSnapshot();
    expect(snapshot.daySummaries.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.samples).toHaveLength(1);
    expect(snapshot.samples[0].ts).toBe(now);
  });
});

