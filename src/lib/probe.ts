import type { Sample, Settings, TargetId } from '../types';

const DEFAULT_TIMEOUT_MS = 2000;

type ProbeValue = number | null;

type ProbeResult = Record<TargetId, ProbeValue>;

async function timedFetch(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProbeValue> {
  const start = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    });

    return Math.round(performance.now() - start);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return null;
    }

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isIpv4Address(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isPrivateIpv4Address(value: string): boolean {
  if (!isIpv4Address(value)) {
    return false;
  }

  const [first, second] = value.split('.').map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31)
  );
}

export function normalizeProbeAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }

  return isPrivateIpv4Address(trimmed) || trimmed === 'localhost'
    ? `http://${trimmed}`
    : `https://${trimmed}`;
}

export async function probeAll(
  settings: Settings,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProbeResult> {
  const enabledTargets = settings.targets.filter((target) => target.enabled);
  const entries = await Promise.all(
    enabledTargets.map(
      async (target) =>
        [target.id, await timedFetch(normalizeProbeAddress(target.address), timeoutMs)] as const,
    ),
  );

  return Object.fromEntries(entries);
}

export function probeValue(sample: Sample | undefined, targetId: TargetId): number | null {
  if (!sample) {
    return null;
  }

  return targetId in sample.results ? sample.results[targetId] : null;
}
