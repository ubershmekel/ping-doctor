import { probeValue } from '../lib/probe';
import type { Sample, StorageShape, TargetConfig } from '../types';

const lastCheckEl = document.querySelector<HTMLParagraphElement>('#last-check');
const addressesEl = document.querySelector<HTMLUListElement>('#addresses');
const recentResultsEl = document.querySelector<HTMLDivElement>('#recent-results');
const openOptionsBtn = document.querySelector<HTMLButtonElement>('#open-options');

function formatTarget(value: string): string {
  return value.replace(/^https?:\/\//, '');
}

function formatTimestamp(ts: number | null): string {
  if (!ts) {
    return 'never';
  }

  return new Date(ts).toLocaleString();
}

function enabledTargets(snapshot: StorageShape): TargetConfig[] {
  return snapshot.settings.targets.filter((target) => target.enabled);
}

function renderAddresses(snapshot: StorageShape): void {
  if (!addressesEl) {
    return;
  }

  const targets = enabledTargets(snapshot);
  if (targets.length === 0) {
    addressesEl.innerHTML = '<li class="dim">No enabled addresses.</li>';
    return;
  }

  addressesEl.innerHTML = targets
    .map((target) => `<li><strong>${target.label}</strong>: <code>${formatTarget(target.address)}</code></li>`)
    .join('');
}

function sampleResultSummary(sample: Sample, snapshot: StorageShape): string {
  const values = enabledTargets(snapshot).map((target) => {
    const value = probeValue(sample, target.id);
    return `${target.label}: ${value === null ? 'down' : `${value}ms`}`;
  });

  return values.join(' | ');
}

function renderRecentResults(snapshot: StorageShape): void {
  if (!recentResultsEl) {
    return;
  }

  const recent = [...snapshot.samples].sort((a, b) => b.ts - a.ts).slice(0, 5);
  if (recent.length === 0) {
    recentResultsEl.innerHTML = '<p class="dim">No results yet.</p>';
    return;
  }

  recentResultsEl.innerHTML = recent
    .map(
      (sample) =>
        `<div class="result-row"><span>${new Date(sample.ts).toLocaleTimeString()}</span><span class="result-values">${sampleResultSummary(sample, snapshot)}</span></div>`
    )
    .join('');
}

function render(snapshot: StorageShape): void {
  if (lastCheckEl) {
    lastCheckEl.textContent = `Last checkup: ${formatTimestamp(snapshot.state.lastCheckedAt)}`;
  }

  renderAddresses(snapshot);
  renderRecentResults(snapshot);
}

async function fetchSnapshot(): Promise<StorageShape> {
  const response = await chrome.runtime.sendMessage({ type: 'get-snapshot' });
  if (response?.ok && response.snapshot) {
    return response.snapshot as StorageShape;
  }

  throw new Error('Failed to load snapshot');
}

async function refresh(): Promise<void> {
  const snapshot = await fetchSnapshot();
  render(snapshot);
}

openOptionsBtn?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.pingdoctor) {
    return;
  }

  void refresh();
});

void refresh();