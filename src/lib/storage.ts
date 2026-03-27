import { failedTargetIds, isOutageSample } from './diagnose';
import type { DaySummary, Diagnosis, Outage, Sample, Settings, StorageShape, TargetConfig, TargetId } from '../types';

const STORAGE_KEY = 'pingdoctor';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * DAY_MS;

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalSec: 30,
  targets: [
    { id: 'router', label: 'Wifi Router', address: '192.168.1.1', enabled: true },
    { id: 'modem', label: 'Internet Modem', address: '8.8.8.8', enabled: true },
    { id: 'site', label: 'Internet Site', address: 'connectivitycheck.gstatic.com/generate_204', enabled: true }
  ]
};

const DEFAULT_STORAGE: StorageShape = {
  settings: DEFAULT_SETTINGS,
  samples: [],
  outages: [],
  daySummaries: [],
  state: {
    lastLocalIp: null,
    currentOutage: null,
    lastCheckedAt: null
  }
};

function localDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isTargetConfig(value: unknown): value is TargetConfig {
  const target = value as TargetConfig;
  return (
    !!target &&
    typeof target.id === 'string' &&
    target.id.length > 0 &&
    typeof target.label === 'string' &&
    typeof target.address === 'string' &&
    typeof target.enabled === 'boolean'
  );
}

function sanitizeTargets(targets: TargetConfig[]): TargetConfig[] {
  const seen = new Set<string>();
  const next: TargetConfig[] = [];

  for (const target of targets) {
    if (!isTargetConfig(target)) {
      continue;
    }

    if (seen.has(target.id)) {
      continue;
    }

    seen.add(target.id);
    next.push({
      id: target.id,
      label: target.label.trim() || 'Target',
      address: target.address.trim(),
      enabled: target.enabled
    });
  }

  return next;
}

function normalize(data?: Partial<StorageShape>): StorageShape {
  const targets = Array.isArray(data?.settings?.targets)
    ? sanitizeTargets(data?.settings?.targets ?? [])
    : [];

  if (targets.length === 0) {
    return structuredClone(DEFAULT_STORAGE);
  }

  const pollInterval = data?.settings?.pollIntervalSec;
  const pollIntervalSec = pollInterval === 15 || pollInterval === 30 || pollInterval === 60 ? pollInterval : 30;

  return {
    settings: {
      pollIntervalSec,
      targets
    },
    samples: Array.isArray(data?.samples) ? data.samples : [],
    outages: Array.isArray(data?.outages) ? data.outages : [],
    daySummaries: Array.isArray(data?.daySummaries) ? data.daySummaries : [],
    state: {
      ...DEFAULT_STORAGE.state,
      ...(data?.state ?? {})
    }
  };
}

async function readStorage(): Promise<StorageShape> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  return normalize(raw[STORAGE_KEY]);
}

async function writeStorage(data: StorageShape): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

export async function getStorageSnapshot(): Promise<StorageShape> {
  return readStorage();
}

export async function getSettings(): Promise<Settings> {
  const data = await readStorage();
  return data.settings;
}

export async function updateSettings(next: Partial<Settings>): Promise<Settings> {
  const data = await readStorage();
  data.settings = {
    pollIntervalSec: next.pollIntervalSec ?? data.settings.pollIntervalSec,
    targets: next.targets ? sanitizeTargets(next.targets) : data.settings.targets
  };

  if (data.settings.targets.length === 0) {
    data.settings.targets = structuredClone(DEFAULT_SETTINGS.targets);
  }

  await writeStorage(data);
  return data.settings;
}

export async function setLastLocalIp(ip: string | null): Promise<void> {
  const data = await readStorage();
  data.state.lastLocalIp = ip;
  await writeStorage(data);
}

export async function clearAllData(): Promise<void> {
  await writeStorage({ ...DEFAULT_STORAGE, settings: (await readStorage()).settings });
}

function mergeOutageTargets(outage: Outage, sample: Sample): Outage {
  const next = new Set([...outage.affectedTargetIds, ...failedTargetIds(sample)]);
  return {
    ...outage,
    affectedTargetIds: Array.from(next)
  };
}

function isHealthySample(sample: Sample): boolean {
  return sample.enabledTargetIds.every((targetId) => sample.results[targetId] !== null);
}

export async function recordSample(sample: Sample, diagnosis: Diagnosis, primaryTargetId: TargetId | null): Promise<void> {
  const data = await readStorage();
  data.samples.push(sample);
  data.state.lastCheckedAt = sample.ts;

  const isOutage = isOutageSample(sample);

  if (data.state.currentOutage) {
    if (isOutage) {
      data.state.currentOutage = mergeOutageTargets(data.state.currentOutage, sample);
    } else {
      data.state.currentOutage.end = sample.ts;
      data.outages.push(data.state.currentOutage);
      data.state.currentOutage = null;
    }
  } else if (isOutage) {
    data.state.currentOutage = {
      start: sample.ts,
      end: null,
      affectedTargetIds: failedTargetIds(sample),
      diagnosis,
      primaryTargetId
    };
  }

  await writeStorage(data);
}

function summarizeDay(date: string, samples: Sample[], outages: Outage[]): DaySummary {
  const healthyCount = samples.filter((s) => isHealthySample(s)).length;
  const uptimePct = samples.length === 0 ? 100 : Number(((healthyCount / samples.length) * 100).toFixed(2));

  const targetIds = new Set<string>();
  for (const sample of samples) {
    for (const targetId of sample.enabledTargetIds) {
      targetIds.add(targetId);
    }
  }

  const avgLatencyByTarget: Record<string, number> = {};
  for (const targetId of targetIds) {
    const values = samples
      .map((s) => s.results[targetId])
      .filter((value): value is number => typeof value === 'number');

    avgLatencyByTarget[targetId] =
      values.length > 0 ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)) : 0;
  }

  return {
    date,
    uptimePct,
    avgLatencyByTarget,
    outages
  };
}

function clipOutageToDay(outage: Outage, dayStart: number, dayEnd: number): Outage | null {
  const outageEnd = outage.end ?? dayEnd;
  if (outage.start > dayEnd || outageEnd < dayStart) {
    return null;
  }

  return {
    ...outage,
    start: Math.max(outage.start, dayStart),
    end: Math.min(outageEnd, dayEnd)
  };
}

export async function runRollup(now = Date.now()): Promise<void> {
  const data = await readStorage();
  const cutoff = now - RETENTION_MS;

  const oldSamples = data.samples.filter((s) => s.ts < cutoff);
  if (oldSamples.length === 0) {
    return;
  }

  const recentSamples = data.samples.filter((s) => s.ts >= cutoff);
  const oldOutages = data.outages.filter((o) => o.start < cutoff);
  const recentOutages = data.outages.filter((o) => o.start >= cutoff);

  const byDate = new Map<string, Sample[]>();
  for (const sample of oldSamples) {
    const date = localDate(sample.ts);
    const list = byDate.get(date) ?? [];
    list.push(sample);
    byDate.set(date, list);
  }

  const summaryMap = new Map<string, DaySummary>(data.daySummaries.map((s) => [s.date, s]));

  for (const [date, samples] of byDate) {
    const dayStart = startOfLocalDay(samples[0].ts);
    const dayEnd = dayStart + DAY_MS - 1;
    const dayOutages = oldOutages
      .map((o) => clipOutageToDay(o, dayStart, dayEnd))
      .filter((o): o is Outage => o !== null);

    summaryMap.set(date, summarizeDay(date, samples, dayOutages));
  }

  data.samples = recentSamples;
  data.outages = recentOutages;
  data.daySummaries = Array.from(summaryMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  await writeStorage(data);
}

export async function exportData(): Promise<StorageShape> {
  return readStorage();
}
