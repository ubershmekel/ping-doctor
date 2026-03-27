import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Tooltip,
  Legend,
  type Plugin,
  type ChartDataset
} from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import { diagnose, firstFailedTargetId } from '../lib/diagnose';
import { probeValue } from '../lib/probe';
import type { Outage, Sample, StorageShape, TargetConfig } from '../types';

Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Legend, zoomPlugin);

const checkNowButton = document.querySelector<HTMLButtonElement>('#check-now');
const currentStatusEl = document.querySelector<HTMLDivElement>('#current-status');
const statusPill = document.querySelector<HTMLSpanElement>('#status-pill');
const lastCheckEl = document.querySelector<HTMLParagraphElement>('#last-check');
const outageLogEl = document.querySelector<HTMLDivElement>('#outage-log');
const outageTitleEl = document.querySelector<HTMLHeadingElement>('#outage-title');
const heatmapEl = document.querySelector<SVGSVGElement>('#heatmap');
const routerHelpEl = document.querySelector<HTMLElement>('#router-help');
const openOptionsBtn = document.querySelector<HTMLButtonElement>('#open-options');
const chartCanvas = document.querySelector<HTMLCanvasElement>('#latency-chart');

let chart: Chart | null = null;
let latestSnapshot: StorageShape | null = null;
let selectedDate: string | null = null;
let chartSamples: Sample[] = [];

const palette = ['#2f9e44', '#1c7ed6', '#f08c00', '#862e9c', '#c92a2a', '#0b7285'];

const networkDividerPlugin: Plugin<'line'> = {
  id: 'network-divider',
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

    ctx.restore();
  }
};

Chart.register(networkDividerPlugin);

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
  const icon = value === null ? '??' : '??';
  const latency = value === null ? 'down' : `${value}ms`;
  return `<div class="layer-row"><span>${icon} ${label}</span><code>${target}</code><strong>${latency}</strong></div>`;
}

function formatTarget(value: string): string {
  return value.replace(/^https?:\/\//, '');
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
      html: `<div class="outage-item"><strong>${new Date(outage.start).toLocaleString()} - ${outage.end ? new Date(outage.end).toLocaleString() : 'ongoing'}</strong> (${formatDurationMs(end - outage.start)}) ? ${primaryLabel}<br /><span class="dim">Affected: ${describeAffected(outage, snapshot)}</span></div>`
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

  const cellW = 70;
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
      renderAll(snapshot);
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
            title: (items) => new Date(Number(items[0].parsed.x)).toLocaleString(),
            footer: (items) => {
              const idx = items[0].dataIndex;
              const sample = chartSamples[idx];
              if (!sample) {
                return '';
              }

              const failingId = firstFailedTargetId(sample);
              if (!failingId) {
                return `Diagnosis: ${diagnose(sample)}`;
              }

              const label = targetLabelById(snapshot).get(failingId) ?? failingId;
              return `Diagnosis: ${label} down`;
            }
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

  const firstTarget = targets[0];
  const hasPrimarySuccess = firstTarget
    ? snapshot.samples.some((entry) => probeValue(entry, firstTarget.id) !== null)
    : false;

  if (routerHelpEl) {
    routerHelpEl.hidden = !firstTarget || hasPrimarySuccess || probeValue(sample, firstTarget.id) !== null;
  }
}

function renderAll(snapshot: StorageShape): void {
  renderCurrent(snapshot);
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

async function refresh(): Promise<void> {
  latestSnapshot = await fetchSnapshot();
  renderAll(latestSnapshot);
}

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
      renderAll(latestSnapshot);
    }
  } finally {
    checkNowButton.disabled = false;
    checkNowButton.textContent = 'Check Now';
  }
});

openOptionsBtn?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.pingdoctor || !latestSnapshot) {
    return;
  }

  void refresh();
});

void refresh();
