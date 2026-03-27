import { diagnose } from '../lib/diagnose';
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
  updateSettings
} from '../lib/storage';

const ALARM_NAME = 'pingdoctor-poll';

function minutesForPoll(seconds: 15 | 30 | 60): number {
  return seconds / 60;
}

async function scheduleAlarm(): Promise<void> {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.1,
    periodInMinutes: minutesForPoll(settings.pollIntervalSec)
  });
}

function shouldAutoUpdateRouterIp(currentRouterIp: string, previousLocalIp: string | null): boolean {
  const derivedPrevious = deriveRouterIp(previousLocalIp);
  return currentRouterIp === '192.168.1.1' || (!!derivedPrevious && derivedPrevious === currentRouterIp);
}

async function runTick(): Promise<void> {
  const snapshot = await getStorageSnapshot();
  let settings = snapshot.settings;

  const localIp = await detectLocalIp();
  const networkChanged = !!localIp && localIp !== snapshot.state.lastLocalIp;

  if (networkChanged) {
    const derived = deriveRouterIp(localIp);
    if (derived && shouldAutoUpdateRouterIp(settings.routerIp, snapshot.state.lastLocalIp)) {
      settings = await updateSettings({ routerIp: derived });
    }
  }

  if (localIp !== snapshot.state.lastLocalIp) {
    await setLastLocalIp(localIp);
  }

  const result = await probeAll(settings);
  const sample = {
    ts: Date.now(),
    ...result,
    networkChanged,
    localIp
  };

  const diagnosis = diagnose(sample);
  await recordSample(sample, diagnosis);
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
  void scheduleAlarm().catch((error) => console.error('[PingDoctor] Failed to schedule alarm on install', error));
  void safeRunTick('onInstalled');
});

chrome.runtime.onStartup.addListener(() => {
  void scheduleAlarm().catch((error) => console.error('[PingDoctor] Failed to schedule alarm on startup', error));
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
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
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
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
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
