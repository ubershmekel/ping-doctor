import type { Sample, Settings } from '../types';

const DEFAULT_TIMEOUT_MS = 2000;

type ProbeValue = number | null;

type ProbeResult = Pick<Sample, 'router' | 'gateway' | 'internet'>;

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

export async function probeAll(settings: Settings, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProbeResult> {
  const routerUrl = settings.routerIp.startsWith('http') ? settings.routerIp : `http://${settings.routerIp}`;

  const [router, gateway, internet] = await Promise.all([
    timedFetch(routerUrl, timeoutMs),
    timedFetch(settings.targets.gateway, timeoutMs),
    timedFetch(settings.targets.internet, timeoutMs)
  ]);

  return { router, gateway, internet };
}