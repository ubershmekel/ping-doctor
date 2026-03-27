import { affectedLayers, isOutageSample } from './diagnose';
import type { DaySummary, Diagnosis, Outage, Sample, Settings, StorageShape } from '../types';

const STORAGE_KEY = 'pingdoctor';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * DAY_MS;

export const DEFAULT_SETTINGS: Settings = {
  routerIp: '192.168.1.1',
  pollIntervalSec: 30,
  targets: {
    gateway: 'http://8.8.8.8',
    internet: 'https://connectivitycheck.gstatic.com/generate_204'
  }
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

function avg(values: Array<number | null>): number {
  const list = values.filter((x): x is number => x !== null);
  if (list.length === 0) {
    return 0;
  }

  return Number((list.reduce((a, b) => a + b, 0) / list.length).toFixed(1));
}

function normalize(data?: Partial<StorageShape>): StorageShape {
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      ...(data?.settings ?? {}),
      targets: {
        ...DEFAULT_SETTINGS.targets,
        ...(data?.settings?.targets ?? {})
      }
    },
    samples: data?.samples ?? [],
    outages: data?.outages ?? [],
    daySummaries: data?.daySummaries ?? [],
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
    ...data.settings,
    ...next,
    targets: {
      ...data.settings.targets,
      ...(next.targets ?? {})
    }
  };
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

function mergeOutageLayers(outage: Outage, sample: Sample): Outage {
  const next = new Set([...outage.affectedLayers, ...affectedLayers(sample)]);
  return {
    ...outage,
    affectedLayers: Array.from(next)
  };
}

export async function recordSample(sample: Sample, diagnosis: Diagnosis): Promise<void> {
  const data = await readStorage();
  data.samples.push(sample);
  data.state.lastCheckedAt = sample.ts;

  const isOutage = isOutageSample(sample);

  if (data.state.currentOutage) {
    if (isOutage) {
      data.state.currentOutage = mergeOutageLayers(data.state.currentOutage, sample);
    } else {
      data.state.currentOutage.end = sample.ts;
      data.outages.push(data.state.currentOutage);
      data.state.currentOutage = null;
    }
  } else if (isOutage) {
    data.state.currentOutage = {
      start: sample.ts,
      end: null,
      affectedLayers: affectedLayers(sample),
      diagnosis
    };
  }

  await writeStorage(data);
}

function summarizeDay(date: string, samples: Sample[], outages: Outage[]): DaySummary {
  const healthyCount = samples.filter((s) => s.router !== null && s.gateway !== null && s.internet !== null).length;
  const uptimePct = samples.length === 0 ? 100 : Number(((healthyCount / samples.length) * 100).toFixed(2));

  return {
    date,
    uptimePct,
    avgLatency: {
      router: avg(samples.map((s) => s.router)),
      gateway: avg(samples.map((s) => s.gateway)),
      internet: avg(samples.map((s) => s.internet))
    },
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