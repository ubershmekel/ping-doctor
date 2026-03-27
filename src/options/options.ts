import { getSettings, updateSettings } from '../lib/storage';

const form = document.querySelector<HTMLFormElement>('#settings-form');
const routerInput = document.querySelector<HTMLInputElement>('#router-ip');
const intervalInput = document.querySelector<HTMLSelectElement>('#poll-interval');
const gatewayInput = document.querySelector<HTMLInputElement>('#gateway-target');
const internetInput = document.querySelector<HTMLInputElement>('#internet-target');
const exportBtn = document.querySelector<HTMLButtonElement>('#export-data');
const clearBtn = document.querySelector<HTMLButtonElement>('#clear-data');
const statusEl = document.querySelector<HTMLParagraphElement>('#status');

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

async function load(): Promise<void> {
  const settings = await getSettings();
  if (routerInput) routerInput.value = settings.routerIp;
  if (intervalInput) intervalInput.value = String(settings.pollIntervalSec);
  if (gatewayInput) gatewayInput.value = settings.targets.gateway;
  if (internetInput) internetInput.value = settings.targets.internet;
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!routerInput || !intervalInput || !gatewayInput || !internetInput) {
    return;
  }

  const pollIntervalSec = Number(intervalInput.value) as 15 | 30 | 60;
  await updateSettings({
    routerIp: routerInput.value.trim(),
    pollIntervalSec,
    targets: {
      gateway: gatewayInput.value.trim(),
      internet: internetInput.value.trim()
    }
  });

  await chrome.runtime.sendMessage({ type: 'settings-updated' });
  setStatus('Saved. Monitoring updated.');
});

exportBtn?.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'export-data' });
  if (!response?.ok) {
    setStatus('Export failed.');
    return;
  }

  const json = JSON.stringify(response.data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const link = document.createElement('a');
  link.href = url;
  link.download = `pingdoctor-export-${stamp}.json`;
  link.click();

  URL.revokeObjectURL(url);
  setStatus('Data exported.');
});

clearBtn?.addEventListener('click', async () => {
  const confirmed = window.confirm('Clear all PingDoctor data? This cannot be undone.');
  if (!confirmed) {
    return;
  }

  await chrome.runtime.sendMessage({ type: 'clear-data' });
  setStatus('All data cleared.');
});

void load();