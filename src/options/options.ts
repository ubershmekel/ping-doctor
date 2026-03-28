import {
  Chart,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartDataset,
  type Plugin
} from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import { firstFailedTargetId } from '../lib/diagnose';
import { probeValue } from '../lib/probe';
import { getSettings, updateSettings } from '../lib/storage';
import type { Outage, Sample, StorageShape, TargetConfig } from '../types';

Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Legend, zoomPlugin);

const form = document.querySelector<HTMLFormElement>('#settings-form');
const intervalInput = document.querySelector<HTMLSelectElement>('#poll-interval');
const targetsList = document.querySelector<HTMLDivElement>('#targets-list');
const addTargetBtn = document.querySelector<HTMLButtonElement>('#add-target');
const toggleTargetsBtn = document.querySelector<HTMLButtonElement>('#toggle-targets');
const targetsEditor = document.querySelector<HTMLDivElement>('#targets-editor');
const targetTemplate = document.querySelector<HTMLTemplateElement>('#target-template');
const exportBtn = document.querySelector<HTMLButtonElement>('#export-data');
const clearBtn = document.querySelector<HTMLButtonElement>('#clear-data');
const statusEl = document.querySelector<HTMLParagraphElement>('#status');

const checkNowButton = document.querySelector<HTMLButtonElement>('#check-now');
const currentStatusEl = document.querySelector<HTMLDivElement>('#current-status');
const recentResultsEl = document.querySelector<HTMLDivElement>('#recent-results');
const statusPill = document.querySelector<HTMLSpanElement>('#status-pill');
const lastCheckEl = document.querySelector<HTMLParagraphElement>('#last-check');
const outageLogEl = document.querySelector<HTMLDivElement>('#outage-log');
const outageTitleEl = document.querySelector<HTMLHeadingElement>('#outage-title');
const heatmapEl = document.querySelector<SVGSVGElement>('#heatmap');
const chartCanvas = document.querySelector<HTMLCanvasElement>('#latency-chart');

let latestSnapshot: StorageShape | null = null;
let selectedDate: string | null = null;
let chartSamples: Sample[] = [];
let chartFailureSpans: Array<{ start: number; end: number }> = [];
let chart: Chart | null = null;

const palette = ['#2f9e44', '#1c7ed6', '#f08c00', '#862e9c', '#c92a2a', '#0b7285'];

function isFailedSample(sample: Sample): boolean {
  return sample.enabledTargetIds.some((targetId) => sample.results[targetId] === null);
}

const chartEventPlugin: Plugin<'line'> = {
  id: 'chart-events',
  beforeDatasetsDraw(c) {
    const { ctx, chartArea, scales } = c;
    const xScale = scales.x;
    if (!xScale) {
      return;
    }

    ctx.save();
    ctx.fillStyle = 'rgba(224, 49, 49, 0.14)';

    for (const span of chartFailureSpans) {
      const startX = Math.max(chartArea.left, xScale.getPixelForValue(span.start));
      const endX = Math.min(chartArea.right, xScale.getPixelForValue(span.end));
      const width = endX - startX;
      if (width <= 0) {
        continue;
      }

      ctx.fillRect(startX, chartArea.top, width, chartArea.bottom - chartArea.top);
    }

    ctx.restore();
  },
  afterDatasetsDraw(c) {
    const { ctx, chartArea, scales } = c;
    const xScale = scales.x;
    if (!xScale) {
      return;
    }

    const markers = chartSamples.filter((s) => s.networkChanged);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#9f7aea';
    ctx.lineWidth = 1;

    for (const m of markers) {
      const x = xScale.getPixelForValue(m.ts);
      if (x < chartArea.left || x > chartArea.right) {
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.strokeStyle = '#e03131';
    ctx.lineWidth = 2;

    for (const span of chartFailureSpans) {
      const x = xScale.getPixelForValue(span.start);
      if (x < chartArea.left || x > chartArea.right) {
        continue;
      }

      const y = chartArea.top + 12;
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 4);
      ctx.lineTo(x + 4, y + 4);
      ctx.moveTo(x + 4, y - 4);
      ctx.lineTo(x - 4, y + 4);
      ctx.stroke();
    }

    ctx.restore();
  }
};

Chart.register(chartEventPlugin);

function setStatus(text: string): void {
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function makeTargetId(): string {
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }

  return `target-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function updateRowTitle(row: HTMLElement): void {
  const labelInput = row.querySelector<HTMLInputElement>('[data-field="label"]');
  const title = row.querySelector<HTMLElement>('[data-target-title]');
  if (!labelInput || !title) {
    return;
  }

  title.textContent = labelInput.value.trim() || 'Target';
}

function addTargetRow(target?: Partial<TargetConfig>): void {
  if (!targetsList || !targetTemplate) {
    return;
  }

  const fragment = targetTemplate.content.cloneNode(true) as DocumentFragment;
  const row = fragment.querySelector<HTMLElement>('[data-target-row]');
  if (!row) {
    return;
  }

  const idInput = row.querySelector<HTMLInputElement>('[data-field="id"]');
  const enabledInput = row.querySelector<HTMLInputElement>('[data-field="enabled"]');
  const labelInput = row.querySelector<HTMLInputElement>('[data-field="label"]');
  const addressInput = row.querySelector<HTMLInputElement>('[data-field="address"]');
  const removeBtn = row.querySelector<HTMLButtonElement>('[data-action="remove"]');

  if (!idInput || !enabledInput || !labelInput || !addressInput || !removeBtn) {
    return;
  }

  idInput.value = target?.id ?? makeTargetId();
  enabledInput.checked = target?.enabled ?? true;
  labelInput.value = target?.label ?? '';
  addressInput.value = target?.address ?? '';

  labelInput.addEventListener('input', () => updateRowTitle(row));
  removeBtn.addEventListener('click', () => {
    row.remove();
    if (targetsList.children.length === 0) {
      addTargetRow();
    }
  });

  updateRowTitle(row);
  targetsList.appendChild(fragment);
}

function collectTargets(): TargetConfig[] {
  if (!targetsList) {
    return [];
  }

  const rows = Array.from(targetsList.querySelectorAll<HTMLElement>('[data-target-row]'));
  return rows
    .map((row) => {
      const id = row.querySelector<HTMLInputElement>('[data-field="id"]')?.value.trim() ?? '';
      const enabled = row.querySelector<HTMLInputElement>('[data-field="enabled"]')?.checked ?? false;
      const label = row.querySelector<HTMLInputElement>('[data-field="label"]')?.value.trim() ?? '';
      const address = row.querySelector<HTMLInputElement>('[data-field="address"]')?.value.trim() ?? '';

      if (!id) {
        return null;
      }

      return {
        id,
        enabled,
        label: label || 'Target',
        address
      };
    })
    .filter((target): target is TargetConfig => target !== null);
}

function enabledTargets(snapshot: StorageShape): TargetConfig[] {
  return snapshot.settings.targets.filter((target) => target.enabled);
}

function targetLabelById(snapshot: StorageShape): Map<string, string> {
  return new Map(snapshot.settings.targets.map((target) => [target.id, target.label]));
}

function isHealthySample(sample: Sample | undefined): boolean {
  if (!sample) {
    return false;
  }

  return sample.enabledTargetIds.every((targetId) => sample.results[targetId] !== null);
}

function statusFromSample(sample: Sample | undefined, snapshot: StorageShape): { pill: string; text: string; sentence: string } {
  if (!sample) {
    return { pill: 'pill-degraded', text: 'Diagnosing', sentence: 'Diagnosing...' };
  }

  if (isHealthySample(sample)) {
    return { pill: 'pill-healthy', text: 'Healthy', sentence: 'All enabled targets are healthy' };
  }

  const firstDown = firstFailedTargetId(sample);
  const labelMap = targetLabelById(snapshot);
  const label = firstDown ? labelMap.get(firstDown) ?? 'Target' : 'Target';
  return {
    pill: 'pill-degraded',
    text: 'Degraded',
    sentence: `${label} is unreachable`
  };
}

function layerRow(label: string, target: string, value: number | null): string {
  const state = value === null ? '<span class="down-state">down</span>' : `${value}ms`;
  return `<div class="layer-row"><span>${label}</span><code>${target}</code><strong>${state}</strong></div>`;
}

function formatTarget(value: string): string {
  return value.replace(/^https?:\/\//, '');
}

function sampleResultSummary(sample: Sample, snapshot: StorageShape): string {
  const values = enabledTargets(snapshot).map((target) => {
    const value = probeValue(sample, target.id);
    const state = value === null ? '<span class="down-state">down</span>' : `${value}ms`;
    return `${target.label}: ${state}`;
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

function formatTimestamp(ts: number | null): string {
  if (!ts) {
    return 'never';
  }

  return new Date(ts).toLocaleString();
}

function formatDurationMs(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) {
    return '<1 min';
  }

  return `${minutes} min`;
}

function dayString(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function describeAffected(outage: Outage, snapshot: StorageShape): string {
  const labelMap = targetLabelById(snapshot);
  if (outage.affectedTargetIds.length === 0) {
    return 'No affected targets';
  }

  return outage.affectedTargetIds.map((id) => labelMap.get(id) ?? id).join(', ');
}

function mergeLogItems(snapshot: StorageShape): Array<{ ts: number; html: string }> {
  const entries: Array<{ ts: number; html: string }> = [];
  const labelMap = targetLabelById(snapshot);

  const outages = [...snapshot.outages];
  if (snapshot.state.currentOutage) {
    outages.unshift(snapshot.state.currentOutage);
  }

  for (const outage of outages) {
    const end = outage.end ?? Date.now();
    const sameDay = selectedDate ? dayString(outage.start) === selectedDate : true;
    if (!sameDay) {
      continue;
    }

    const primaryLabel = outage.primaryTargetId ? labelMap.get(outage.primaryTargetId) ?? outage.primaryTargetId : 'Target';

    entries.push({
      ts: outage.start,
      html: `<div class="outage-item"><strong>${new Date(outage.start).toLocaleString()} - ${outage.end ? new Date(outage.end).toLocaleString() : 'ongoing'}</strong> (${formatDurationMs(end - outage.start)}) on ${primaryLabel}<br /><span class="dim">Affected: ${describeAffected(outage, snapshot)}</span></div>`
    });
  }

  for (const sample of snapshot.samples) {
    if (!sample.networkChanged) {
      continue;
    }

    const sameDay = selectedDate ? dayString(sample.ts) === selectedDate : true;
    if (!sameDay) {
      continue;
    }

    entries.push({
      ts: sample.ts,
      html: `<div class="net-change">Network change detected - monitoring resumed (${new Date(sample.ts).toLocaleString()})</div>`
    });
  }

  return entries.sort((a, b) => b.ts - a.ts);
}

function calculateDayUptime(date: string, snapshot: StorageShape): number {
  const summary = snapshot.daySummaries.find((d) => d.date === date);
  if (summary) {
    return summary.uptimePct;
  }

  const daySamples = snapshot.samples.filter((s) => dayString(s.ts) === date);
  if (daySamples.length === 0) {
    return 100;
  }

  const healthy = daySamples.filter((s) => isHealthySample(s)).length;
  return Number(((healthy / daySamples.length) * 100).toFixed(2));
}

function colorForUptime(uptime: number): string {
  if (uptime >= 99.5) return '#2f9e44';
  if (uptime >= 95) return '#74b816';
  if (uptime >= 80) return '#f08c00';
  return '#e03131';
}

function renderHeatmap(snapshot: StorageShape): void {
  if (!heatmapEl) {
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days: string[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 86400000);
    days.push(dayString(d.getTime()));
  }

  const cellW = 90;
  const cellH = 34;
  const y = 20;

  heatmapEl.innerHTML = '';

  days.forEach((date, idx) => {
    const uptime = calculateDayUptime(date, snapshot);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(idx * (cellW + 8)));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(cellW));
    rect.setAttribute('height', String(cellH));
    rect.setAttribute('rx', '4');
    rect.setAttribute('fill', colorForUptime(uptime));
    rect.setAttribute('class', 'clickable-day');
    rect.addEventListener('click', () => {
      selectedDate = selectedDate === date ? null : date;
      renderAllStats(snapshot);
    });

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(idx * (cellW + 8) + 4));
    label.setAttribute('y', String(y - 4));
    label.setAttribute('class', 'day-label');
    label.textContent = date.slice(5);

    const pct = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    pct.setAttribute('x', String(idx * (cellW + 8) + 6));
    pct.setAttribute('y', String(y + 22));
    pct.setAttribute('class', 'day-label');
    pct.textContent = `${uptime.toFixed(1)}%`;

    g.appendChild(label);
    g.appendChild(rect);
    g.appendChild(pct);
    heatmapEl.appendChild(g);
  });
}

function renderChart(snapshot: StorageShape): void {
  if (!chartCanvas) {
    return;
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  chartSamples = snapshot.samples.filter((s) => s.ts >= cutoff).sort((a, b) => a.ts - b.ts);

  chartFailureSpans = [];
  let activeFailureStart: number | null = null;
  for (const sample of chartSamples) {
    const failed = isFailedSample(sample);
    if (failed && activeFailureStart === null) {
      activeFailureStart = sample.ts;
      continue;
    }

    if (!failed && activeFailureStart !== null) {
      chartFailureSpans.push({ start: activeFailureStart, end: sample.ts });
      activeFailureStart = null;
    }
  }

  if (activeFailureStart !== null) {
    const end = chartSamples.length > 0 ? chartSamples[chartSamples.length - 1].ts : activeFailureStart;
    chartFailureSpans.push({ start: activeFailureStart, end });
  }

  const targets = enabledTargets(snapshot);
  const datasets: ChartDataset<'line'>[] = targets.map((target, idx) => ({
    label: target.label,
    data: chartSamples.map((sample) => ({ x: sample.ts, y: probeValue(sample, target.id) })),
    borderColor: palette[idx % palette.length],
    pointRadius: 0,
    spanGaps: false
  }));

  if (chart) {
    chart.data.datasets = datasets;
    chart.update();
    return;
  }

  chart = new Chart(chartCanvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          type: 'linear',
          ticks: {
            callback: (v) => new Date(Number(v)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Latency (ms)' }
        }
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            title: (items) => new Date(Number(items[0].parsed.x)).toLocaleString()
          }
        },
        zoom: {
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
          pan: { enabled: true, mode: 'x' }
        }
      }
    }
  });
}

function renderOutages(snapshot: StorageShape): void {
  if (!outageLogEl || !outageTitleEl) {
    return;
  }

  outageTitleEl.textContent = selectedDate ? `Outage Log (${selectedDate})` : 'Outage Log';
  const rows = mergeLogItems(snapshot);
  outageLogEl.innerHTML = rows.length ? rows.map((r) => r.html).join('') : '<p class="dim">No recent outages.</p>';
}

function renderCurrent(snapshot: StorageShape): void {
  const sample = snapshot.samples[snapshot.samples.length - 1];
  const status = statusFromSample(sample, snapshot);
  const targets = enabledTargets(snapshot);

  if (statusPill) {
    statusPill.className = `status-pill ${status.pill}`;
    statusPill.textContent = status.text;
  }

  if (lastCheckEl) {
    lastCheckEl.textContent = `Last checkup: ${formatTimestamp(snapshot.state.lastCheckedAt)}`;
  }

  if (currentStatusEl) {
    const rows = targets.map((target) => layerRow(target.label, formatTarget(target.address), probeValue(sample, target.id)));
    rows.push(`<p class="dim">${status.sentence}</p>`);
    currentStatusEl.innerHTML = rows.join('');
  }
}

function renderAllStats(snapshot: StorageShape): void {
  renderCurrent(snapshot);
  renderRecentResults(snapshot);
  renderChart(snapshot);
  renderOutages(snapshot);
  renderHeatmap(snapshot);
}

async function fetchSnapshot(): Promise<StorageShape> {
  const response = await chrome.runtime.sendMessage({ type: 'get-snapshot' });
  if (response?.ok && response.snapshot) {
    return response.snapshot as StorageShape;
  }

  throw new Error('Failed to load snapshot');
}

async function refreshStats(): Promise<void> {
  latestSnapshot = await fetchSnapshot();
  renderAllStats(latestSnapshot);
}

async function load(): Promise<void> {
  const settings = await getSettings();

  if (intervalInput) {
    intervalInput.value = String(settings.pollIntervalSec);
  }

  if (targetsList) {
    targetsList.innerHTML = '';
    settings.targets.forEach((target) => addTargetRow(target));
    if (settings.targets.length === 0) {
      addTargetRow();
    }
  }
}

addTargetBtn?.addEventListener('click', () => addTargetRow());
toggleTargetsBtn?.addEventListener('click', () => {
  if (!targetsEditor || !toggleTargetsBtn) {
    return;
  }

  const isHidden = targetsEditor.hasAttribute('hidden');
  if (isHidden) {
    targetsEditor.removeAttribute('hidden');
    toggleTargetsBtn.setAttribute('aria-expanded', 'true');
    return;
  }

  targetsEditor.setAttribute('hidden', '');
  toggleTargetsBtn.setAttribute('aria-expanded', 'false');
});

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!intervalInput) {
    return;
  }

  const targets = collectTargets();
  if (targets.length === 0) {
    setStatus('Add at least one target.');
    return;
  }

  const enabledTargetsOnly = targets.filter((target) => target.enabled);
  if (enabledTargetsOnly.length === 0) {
    setStatus('Enable at least one target.');
    return;
  }

  if (enabledTargetsOnly.some((target) => !target.address)) {
    setStatus('Enabled targets must have an address or URL.');
    return;
  }

  const pollIntervalSec = Number(intervalInput.value) as 15 | 30 | 60;

  await updateSettings({
    pollIntervalSec,
    targets
  });

  await chrome.runtime.sendMessage({ type: 'settings-updated' });
  setStatus('Saved. Monitoring updated.');
  await refreshStats();
});

checkNowButton?.addEventListener('click', async () => {
  if (!checkNowButton) {
    return;
  }

  checkNowButton.disabled = true;
  checkNowButton.textContent = 'Diagnosing...';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'check-now' });
    if (response?.ok && response.snapshot) {
      latestSnapshot = response.snapshot as StorageShape;
      renderAllStats(latestSnapshot);
    }
  } finally {
    checkNowButton.disabled = false;
    checkNowButton.textContent = 'Check Now';
  }
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
  await refreshStats();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.pingdoctor) {
    return;
  }

  void refreshStats();
});

void load();
void refreshStats();





