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
    await recordSample({ ts: 1, router: null, gateway: null, internet: null }, 'wifi');
    await recordSample({ ts: 2, router: 8, gateway: 11, internet: 20 }, 'unknown');

    const snapshot = await getStorageSnapshot();
    expect(snapshot.outages).toHaveLength(1);
    expect(snapshot.outages[0].start).toBe(1);
    expect(snapshot.outages[0].end).toBe(2);
    expect(snapshot.state.currentOutage).toBeNull();
  });

  it('rolls old samples into day summaries and trims raw sample retention', async () => {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

    await recordSample({ ts: eightDaysAgo, router: 10, gateway: 20, internet: 30 }, 'unknown');
    await recordSample({ ts: now, router: 12, gateway: 22, internet: 32 }, 'unknown');

    await runRollup(now);

    const snapshot = await getStorageSnapshot();
    expect(snapshot.daySummaries.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.samples).toHaveLength(1);
    expect(snapshot.samples[0].ts).toBe(now);
  });
});
