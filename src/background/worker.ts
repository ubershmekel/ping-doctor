import { diagnose, firstFailedTargetId } from '../lib/diagnose';
import { detectLocalIp, deriveRouterIp } from '../lib/network';
import { probeAll } from '../lib/probe';
import {
  clearAllData,
  exportData,
  getSettings,
  getStorageSnapshot,
  recordSample,
  runRollup,
  setLastLocalIp,
  updateSettings,
} from '../lib/storage';

const ALARM_NAME = 'pingdoctor-poll';

function minutesForPoll(seconds: number): number {
  return seconds / 60;
}

async function scheduleAlarm(): Promise<void> {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.1,
    periodInMinutes: minutesForPoll(settings.pollIntervalSec),
  });
}

function stripScheme(value: string): string {
  return value.replace(/^https?:\/\//, '');
}

function shouldAutoUpdateRouterIp(currentAddress: string, previousLocalIp: string | null): boolean {
  const normalized = stripScheme(currentAddress);
  const derivedPrevious = deriveRouterIp(previousLocalIp);
  return normalized === '192.168.1.1' || (!!derivedPrevious && derivedPrevious === normalized);
}

async function runTick(): Promise<void> {
  const snapshot = await getStorageSnapshot();
  let settings = snapshot.settings;

  const localIp = await detectLocalIp();
  const networkChanged = !!localIp && localIp !== snapshot.state.lastLocalIp;

  const routerTarget = settings.targets.find((target) => target.id === 'router');
  if (networkChanged && routerTarget?.enabled) {
    const derived = deriveRouterIp(localIp);
    if (derived && shouldAutoUpdateRouterIp(routerTarget.address, snapshot.state.lastLocalIp)) {
      settings = await updateSettings({
        targets: settings.targets.map((target) =>
          target.id === 'router' ? { ...target, address: derived } : target,
        ),
      });
    }
  }

  if (localIp !== snapshot.state.lastLocalIp) {
    await setLastLocalIp(localIp);
  }

  const enabledTargetIds = settings.targets
    .filter((target) => target.enabled)
    .map((target) => target.id);
  const results = await probeAll(settings);

  const sample = {
    ts: Date.now(),
    results,
    enabledTargetIds,
    networkChanged,
    localIp,
  };

  const diagnosis = diagnose(sample);
  await recordSample(sample, diagnosis, firstFailedTargetId(sample));
  await runRollup(sample.ts);
}

async function safeRunTick(source: string): Promise<void> {
  try {
    await runTick();
  } catch (error) {
    console.error(`[PingDoctor] Tick failed (${source})`, error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void scheduleAlarm().catch((error) =>
    console.error('[PingDoctor] Failed to schedule alarm on install', error),
  );
  void safeRunTick('onInstalled');
});

chrome.runtime.onStartup.addListener(() => {
  void scheduleAlarm().catch((error) =>
    console.error('[PingDoctor] Failed to schedule alarm on startup', error),
  );
  void safeRunTick('onStartup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  void safeRunTick('alarm');
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'check-now') {
    void runTick()
      .then(() => getStorageSnapshot())
      .then((nextSnapshot) => sendResponse({ ok: true, snapshot: nextSnapshot }))
      .catch((error) => {
        console.error('[PingDoctor] check-now failed', error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (message?.type === 'settings-updated') {
    void scheduleAlarm()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error('[PingDoctor] settings-updated failed', error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (message?.type === 'get-snapshot') {
    void getStorageSnapshot()
      .then((nextSnapshot) => sendResponse({ ok: true, snapshot: nextSnapshot }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === 'export-data') {
    void exportData()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === 'clear-data') {
    void clearAllData()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});
