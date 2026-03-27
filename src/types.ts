export type Layer = 'router' | 'gateway' | 'internet';

export type Sample = {
  ts: number;
  router: number | null;
  gateway: number | null;
  internet: number | null;
  networkChanged?: boolean;
  localIp?: string | null;
};

export type Diagnosis = 'wifi' | 'isp' | 'internet' | 'unknown';

export type Outage = {
  start: number;
  end: number | null;
  affectedLayers: Layer[];
  diagnosis: Diagnosis;
};

export type DaySummary = {
  date: string;
  uptimePct: number;
  avgLatency: {
    router: number;
    gateway: number;
    internet: number;
  };
  outages: Outage[];
};

export type Targets = {
  gateway: string;
  internet: string;
};

export type Settings = {
  routerIp: string;
  pollIntervalSec: 15 | 30 | 60;
  targets: Targets;
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