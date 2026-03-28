export type TargetId = string;

export type TargetConfig = {
  id: TargetId;
  label: string;
  address: string;
  enabled: boolean;
};

export type Sample = {
  ts: number;
  results: Record<TargetId, number | null>;
  enabledTargetIds: TargetId[];
  networkChanged?: boolean;
  localIp?: string | null;
};

export type Diagnosis = 'target' | 'unknown';

export type Outage = {
  start: number;
  end: number | null;
  affectedTargetIds: TargetId[];
  diagnosis: Diagnosis;
  primaryTargetId: TargetId | null;
};

export type TargetDaySummary = {
  totalPings: number;
  failedPings: number;
  uptimePct: number;
  avgLatency: number;
};

export type DaySummary = {
  date: string;
  targets: Record<TargetId, TargetDaySummary>;
  outages: Outage[];
};

export type Settings = {
  pollIntervalSec: 15 | 30 | 60;
  targets: TargetConfig[];
};

export type RuntimeState = {
  lastLocalIp: string | null;
  currentOutage: Outage | null;
  lastCheckedAt: number | null;
};

export type StorageShape = {
  settings: Settings;
  samples: Sample[];
  outages: Outage[];
  daySummaries: DaySummary[];
  state: RuntimeState;
};
