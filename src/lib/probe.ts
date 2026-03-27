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
      signal: controller.signal
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

function toUrl(address: string): string {
  return address.startsWith('http://') || address.startsWith('https://') ? address : `http://${address}`;
}

export async function probeAll(settings: Settings, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProbeResult> {
  const enabledTargets = settings.targets.filter((target) => target.enabled);
  const entries = await Promise.all(
    enabledTargets.map(async (target) => [target.id, await timedFetch(toUrl(target.address), timeoutMs)] as const)
  );

  return Object.fromEntries(entries);
}

export function probeValue(sample: Sample | undefined, targetId: TargetId): number | null {
  if (!sample) {
    return null;
  }

  return targetId in sample.results ? sample.results[targetId] : null;
}
