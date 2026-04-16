import { failedTargetIds, isOutageSample } from './diagnose';
import type {
  DaySummary,
  Diagnosis,
  Outage,
  Sample,
  Settings,
  StorageShape,
  TargetDaySummary,
  TargetConfig,
  TargetId,
} from '../types';

const STORAGE_KEY = 'pingdoctor';
const DB_NAME = 'pingdoctor-events';
const DB_VERSION = 1;
const SAMPLES_STORE = 'samples';
const OUTAGES_STORE = 'outages';
const DAY_MS = 24 * 60 * 60 * 1000;
const RAW_RETENTION_MS = 2 * DAY_MS;

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalSec: 30,
  targets: [
    {
      id: 'router',
      label: 'Wi-Fi Router',
      address: '192.168.1.1',
      enabled: true,
    },
    {
      id: 'site',
      label: 'Internet Check',
      address: 'https://connectivitycheck.gstatic.com/generate_204',
      enabled: true,
    },
  ],
};

const DEFAULT_STORAGE: StorageShape = {
  settings: DEFAULT_SETTINGS,
  samples: [],
  outages: [],
  daySummaries: [],
  state: {
    lastLocalIp: null,
    currentOutage: null,
    lastCheckedAt: null,
  },
};

type MetaShape = Omit<StorageShape, 'samples' | 'outages'> & {
  samples?: Sample[];
  outages?: Outage[];
};

let dbPromise: Promise<IDBDatabase> | null = null;
let idbUnavailable = false;

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
      enabled: target.enabled,
    });
  }

  return next;
}

function normalizeMeta(data?: Partial<MetaShape>): MetaShape {
  const targets = Array.isArray(data?.settings?.targets)
    ? sanitizeTargets(data?.settings?.targets ?? [])
    : [];

  if (targets.length === 0) {
    return {
      settings: structuredClone(DEFAULT_STORAGE.settings),
      daySummaries: [],
      state: structuredClone(DEFAULT_STORAGE.state),
      samples: [],
      outages: [],
    };
  }

  const pollInterval = Number(data?.settings?.pollIntervalSec);
  const pollIntervalSec = Number.isFinite(pollInterval) && pollInterval >= 1 ? pollInterval : 30;

  return {
    settings: {
      pollIntervalSec,
      targets,
    },
    daySummaries: Array.isArray(data?.daySummaries) ? data.daySummaries : [],
    state: {
      ...DEFAULT_STORAGE.state,
      ...(data?.state ?? {}),
    },
    samples: Array.isArray(data?.samples) ? data.samples : [],
    outages: Array.isArray(data?.outages) ? data.outages : [],
  };
}

async function readMeta(): Promise<MetaShape> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeMeta(raw[STORAGE_KEY]);
}

async function writeMeta(data: MetaShape): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

function canUseIndexedDb(): boolean {
  return (
    !idbUnavailable && typeof indexedDB !== 'undefined' && typeof indexedDB.open === 'function'
  );
}

function getDatabase(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(SAMPLES_STORE)) {
        const sampleStore = db.createObjectStore(SAMPLES_STORE, {
          keyPath: 'id',
          autoIncrement: true,
        });
        sampleStore.createIndex('ts', 'ts', { unique: false });
      }

      if (!db.objectStoreNames.contains(OUTAGES_STORE)) {
        const outageStore = db.createObjectStore(OUTAGES_STORE, {
          keyPath: 'id',
          autoIncrement: true,
        });
        outageStore.createIndex('start', 'start', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });

  dbPromise.catch((error) => {
    idbUnavailable = true;
    dbPromise = null;
    throw error;
  });

  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function appendEvent<T extends Sample | Outage>(storeName: string, value: T): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).add(value);
  await transactionDone(tx);
}

async function queryEvents<T>(
  storeName: string,
  indexName: string,
  minTs: number | null,
  maxTs: number | null,
): Promise<T[]> {
  const db = await getDatabase();
  const tx = db.transaction(storeName, 'readonly');
  const index = tx.objectStore(storeName).index(indexName);

  const range =
    minTs === null && maxTs === null
      ? undefined
      : minTs === null
        ? IDBKeyRange.upperBound(maxTs as number)
        : maxTs === null
          ? IDBKeyRange.lowerBound(minTs)
          : IDBKeyRange.bound(minTs, maxTs);

  const request = index.openCursor(range);
  const rows: T[] = [];

  await new Promise<void>((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      const value = cursor.value as T;
      rows.push(value);
      cursor.continue();
    };
  });

  await transactionDone(tx);
  return rows;
}

async function deleteEvents(storeName: string, indexName: string, maxTs: number): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  const index = tx.objectStore(storeName).index(indexName);
  const request = index.openCursor(IDBKeyRange.upperBound(maxTs));

  await new Promise<void>((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      cursor.delete();
      cursor.continue();
    };
  });

  await transactionDone(tx);
}

async function clearEventStores(): Promise<void> {
  const db = await getDatabase();
  const tx = db.transaction([SAMPLES_STORE, OUTAGES_STORE], 'readwrite');
  tx.objectStore(SAMPLES_STORE).clear();
  tx.objectStore(OUTAGES_STORE).clear();
  await transactionDone(tx);
}

async function appendSample(sample: Sample, meta: MetaShape): Promise<void> {
  if (!canUseIndexedDb()) {
    meta.samples = [...(meta.samples ?? []), sample];
    return;
  }

  try {
    await appendEvent(SAMPLES_STORE, sample);
  } catch {
    idbUnavailable = true;
    meta.samples = [...(meta.samples ?? []), sample];
  }
}

async function appendOutage(outage: Outage, meta: MetaShape): Promise<void> {
  if (!canUseIndexedDb()) {
    meta.outages = [...(meta.outages ?? []), outage];
    return;
  }

  try {
    await appendEvent(OUTAGES_STORE, outage);
  } catch {
    idbUnavailable = true;
    meta.outages = [...(meta.outages ?? []), outage];
  }
}

async function listSamples(
  minTs: number | null,
  maxTs: number | null,
  meta: MetaShape,
): Promise<Sample[]> {
  if (!canUseIndexedDb()) {
    const all = meta.samples ?? [];
    return all.filter(
      (s) => (minTs === null || s.ts >= minTs) && (maxTs === null || s.ts <= maxTs),
    );
  }

  try {
    return await queryEvents<Sample>(SAMPLES_STORE, 'ts', minTs, maxTs);
  } catch {
    idbUnavailable = true;
    const all = meta.samples ?? [];
    return all.filter(
      (s) => (minTs === null || s.ts >= minTs) && (maxTs === null || s.ts <= maxTs),
    );
  }
}

async function listOutages(
  minStart: number | null,
  maxStart: number | null,
  meta: MetaShape,
): Promise<Outage[]> {
  if (!canUseIndexedDb()) {
    const all = meta.outages ?? [];
    return all.filter(
      (o) =>
        (minStart === null || o.start >= minStart) && (maxStart === null || o.start <= maxStart),
    );
  }

  try {
    return await queryEvents<Outage>(OUTAGES_STORE, 'start', minStart, maxStart);
  } catch {
    idbUnavailable = true;
    const all = meta.outages ?? [];
    return all.filter(
      (o) =>
        (minStart === null || o.start >= minStart) && (maxStart === null || o.start <= maxStart),
    );
  }
}

async function deleteOutages(maxStart: number, meta: MetaShape): Promise<void> {
  if (!canUseIndexedDb()) {
    meta.outages = (meta.outages ?? []).filter((o) => o.start > maxStart);
    return;
  }

  try {
    await deleteEvents(OUTAGES_STORE, 'start', maxStart);
  } catch {
    idbUnavailable = true;
    meta.outages = (meta.outages ?? []).filter((o) => o.start > maxStart);
  }
}

async function deleteSamples(maxTs: number, meta: MetaShape): Promise<void> {
  if (!canUseIndexedDb()) {
    meta.samples = (meta.samples ?? []).filter((s) => s.ts > maxTs);
    return;
  }

  try {
    await deleteEvents(SAMPLES_STORE, 'ts', maxTs);
  } catch {
    idbUnavailable = true;
    meta.samples = (meta.samples ?? []).filter((s) => s.ts > maxTs);
  }
}

async function clearEvents(meta: MetaShape): Promise<void> {
  if (!canUseIndexedDb()) {
    meta.samples = [];
    meta.outages = [];
    return;
  }

  try {
    await clearEventStores();
  } catch {
    idbUnavailable = true;
    meta.samples = [];
    meta.outages = [];
  }
}

function toSnapshot(meta: MetaShape, samples: Sample[], outages: Outage[]): StorageShape {
  return {
    settings: meta.settings,
    daySummaries: meta.daySummaries,
    state: meta.state,
    samples,
    outages,
  };
}

export async function getStorageSnapshot(): Promise<StorageShape> {
  const meta = await readMeta();
  const cutoff = Date.now() - RAW_RETENTION_MS;
  const [samples, outages] = await Promise.all([
    listSamples(cutoff, null, meta),
    listOutages(cutoff, null, meta),
  ]);
  return toSnapshot(meta, samples, outages);
}

export async function getSettings(): Promise<Settings> {
  const meta = await readMeta();
  return meta.settings;
}

export async function updateSettings(next: Partial<Settings>): Promise<Settings> {
  const meta = await readMeta();
  meta.settings = {
    pollIntervalSec: next.pollIntervalSec ?? meta.settings.pollIntervalSec,
    targets: next.targets ? sanitizeTargets(next.targets) : meta.settings.targets,
  };

  if (meta.settings.targets.length === 0) {
    meta.settings.targets = structuredClone(DEFAULT_SETTINGS.targets);
  }

  await writeMeta(meta);
  return meta.settings;
}

export async function setLastLocalIp(ip: string | null): Promise<void> {
  const meta = await readMeta();
  meta.state.lastLocalIp = ip;
  await writeMeta(meta);
}

export async function clearAllData(): Promise<void> {
  const meta = await readMeta();
  const next: MetaShape = {
    settings: meta.settings,
    daySummaries: [],
    state: structuredClone(DEFAULT_STORAGE.state),
    samples: [],
    outages: [],
  };

  await clearEvents(next);
  await writeMeta(next);
}

function mergeOutageTargets(outage: Outage, sample: Sample): Outage {
  const next = new Set([...outage.affectedTargetIds, ...failedTargetIds(sample)]);
  return {
    ...outage,
    affectedTargetIds: Array.from(next),
  };
}

export async function recordSample(
  sample: Sample,
  diagnosis: Diagnosis,
  primaryTargetId: TargetId | null,
): Promise<void> {
  const meta = await readMeta();
  await appendSample(sample, meta);
  meta.state.lastCheckedAt = sample.ts;

  const isOutage = isOutageSample(sample);

  if (meta.state.currentOutage) {
    if (isOutage) {
      meta.state.currentOutage = mergeOutageTargets(meta.state.currentOutage, sample);
    } else {
      meta.state.currentOutage.end = sample.ts;
      await appendOutage(meta.state.currentOutage, meta);
      meta.state.currentOutage = null;
    }
  } else if (isOutage) {
    meta.state.currentOutage = {
      start: sample.ts,
      end: null,
      affectedTargetIds: failedTargetIds(sample),
      diagnosis,
      primaryTargetId,
    };
  }

  await writeMeta(meta);
}

function summarizeDay(date: string, samples: Sample[], outages: Outage[]): DaySummary {
  const targetIds = new Set<string>();
  for (const sample of samples) {
    for (const targetId of sample.enabledTargetIds) {
      targetIds.add(targetId);
    }
  }

  const targets: Record<string, import('../types').TargetDaySummary> = {};
  for (const targetId of targetIds) {
    const relevant = samples.filter((s) => s.enabledTargetIds.includes(targetId));
    const latencies = relevant
      .map((s) => s.results[targetId])
      .filter((v): v is number => typeof v === 'number');
    const failedPings = relevant.filter((s) => s.results[targetId] === null).length;

    targets[targetId] = {
      totalPings: relevant.length,
      failedPings,
      uptimePct:
        relevant.length === 0
          ? -1
          : Number((((relevant.length - failedPings) / relevant.length) * 100).toFixed(2)),
      avgLatency:
        latencies.length > 0
          ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1))
          : 0,
    };
  }

  return {
    date,
    targets,
    outages,
  };
}

function mergeTargetSummary(
  current: TargetDaySummary | undefined,
  next: TargetDaySummary,
): TargetDaySummary {
  if (!current) {
    return next;
  }

  const totalPings = current.totalPings + next.totalPings;
  const failedPings = current.failedPings + next.failedPings;
  const currentSuccesses = current.totalPings - current.failedPings;
  const nextSuccesses = next.totalPings - next.failedPings;
  const successes = currentSuccesses + nextSuccesses;

  return {
    totalPings,
    failedPings,
    uptimePct:
      totalPings === 0 ? -1 : Number((((totalPings - failedPings) / totalPings) * 100).toFixed(2)),
    avgLatency:
      successes > 0
        ? Number(
            (
              (current.avgLatency * currentSuccesses + next.avgLatency * nextSuccesses) /
              successes
            ).toFixed(1),
          )
        : 0,
  };
}

function outageKey(outage: Outage): string {
  return [
    outage.start,
    outage.end ?? '',
    outage.primaryTargetId ?? '',
    outage.affectedTargetIds.join(','),
    outage.diagnosis,
  ].join('|');
}

function mergeDaySummary(current: DaySummary | undefined, next: DaySummary): DaySummary {
  if (!current) {
    return next;
  }

  const targets = { ...current.targets };
  for (const [id, target] of Object.entries(next.targets)) {
    targets[id] = mergeTargetSummary(targets[id], target);
  }

  const outagesByKey = new Map<string, Outage>();
  for (const outage of [...current.outages, ...next.outages]) {
    outagesByKey.set(outageKey(outage), outage);
  }

  return {
    date: current.date,
    targets,
    outages: [...outagesByKey.values()].sort((a, b) => a.start - b.start),
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
    end: Math.min(outageEnd, dayEnd),
  };
}

export async function runRollup(now = Date.now()): Promise<void> {
  const meta = await readMeta();
  const cutoff = now - RAW_RETENTION_MS;

  const oldSamples = await listSamples(null, cutoff - 1, meta);
  if (oldSamples.length === 0) {
    return;
  }

  const oldOutages = await listOutages(null, cutoff - 1, meta);
  const byDate = new Map<string, Sample[]>();

  for (const sample of oldSamples) {
    const date = localDate(sample.ts);
    const list = byDate.get(date) ?? [];
    list.push(sample);
    byDate.set(date, list);
  }

  const summaryMap = new Map<string, DaySummary>(meta.daySummaries.map((s) => [s.date, s]));

  for (const [date, samples] of byDate) {
    const dayStart = startOfLocalDay(samples[0].ts);
    const dayEnd = dayStart + DAY_MS - 1;
    const dayOutages = oldOutages
      .map((o) => clipOutageToDay(o, dayStart, dayEnd))
      .filter((o): o is Outage => o !== null);

    const nextSummary = summarizeDay(date, samples, dayOutages);
    summaryMap.set(date, mergeDaySummary(summaryMap.get(date), nextSummary));
  }

  meta.daySummaries = Array.from(summaryMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  await deleteSamples(cutoff - 1, meta);
  await deleteOutages(cutoff - 1, meta);
  await writeMeta(meta);
}

export async function exportData(): Promise<StorageShape> {
  const meta = await readMeta();
  const [samples, outages] = await Promise.all([
    listSamples(null, null, meta),
    listOutages(null, null, meta),
  ]);
  return toSnapshot(meta, samples, outages);
}
