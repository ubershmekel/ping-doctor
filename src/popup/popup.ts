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
import { diagnose } from '../lib/diagnose';
import type { Outage, Sample, StorageShape } from '../types';

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

function statusFromSample(sample: Sample | undefined): { pill: string; text: string; sentence: string } {
  if (!sample) {
    return { pill: 'pill-degraded', text: 'Diagnosing', sentence: 'Diagnosing...' };
  }

  if (sample.router !== null && sample.gateway !== null && sample.internet !== null) {
    return { pill: 'pill-healthy', text: 'Healthy', sentence: 'All systems healthy' };
  }

  if (sample.router === null) {
    return { pill: 'pill-outage', text: 'Outage', sentence: 'Symptoms detected - looks like your WiFi' };
  }

  if (sample.gateway === null) {
    return { pill: 'pill-degraded', text: 'Degraded', sentence: 'Symptoms detected - looks like your ISP' };
  }

  return { pill: 'pill-degraded', text: 'Degraded', sentence: 'Symptoms detected - internet issue detected' };
}

function layerRow(label: string, target: string, value: number | null): string {
  const icon = value === null ? '??' : '??';
  const latency = value === null ? 'down' : `${value}ms`;
  return `<div class="layer-row"><span>${icon} ${label}</span><code>${target}</code><strong>${latency}</strong></div>`;
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

function outageLabel(diagnosis: Outage['diagnosis']): string {
  if (diagnosis === 'wifi') return 'WiFi';
  if (diagnosis === 'isp') return 'ISP';
  if (diagnosis === 'internet') return 'Internet';
  return 'Unknown';
}

function dayString(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function describeAffected(outage: Outage): string {
  const bad = new Set(outage.affectedLayers);
  const mk = (layer: 'router' | 'gateway' | 'internet') => (bad.has(layer) ? '?' : '?');
  return `Router ${mk('router')}  Gateway ${mk('gateway')}  Internet ${mk('internet')}`;
}

function mergeLogItems(snapshot: StorageShape): Array<{ ts: number; html: string }> {
  const entries: Array<{ ts: number; html: string }> = [];

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

    entries.push({
      ts: outage.start,
      html: `<div class="outage-item"><strong>${new Date(outage.start).toLocaleString()} - ${outage.end ? new Date(outage.end).toLocaleString() : 'ongoing'}</strong> (${formatDurationMs(end - outage.start)}) ? ${outageLabel(outage.diagnosis)}<br /><span class="dim">${describeAffected(outage)}</span></div>`
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
  const healthy = daySamples.filter((s) => s.router !== null && s.gateway !== null && s.internet !== null).length;
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

  const mkData = (key: 'router' | 'gateway' | 'internet'): Array<{ x: number; y: number | null }> =>
    chartSamples.map((s) => ({ x: s.ts, y: s[key] }));

  const datasets: ChartDataset<'line'>[] = [
    { label: 'Router', data: mkData('router'), borderColor: '#2f9e44', pointRadius: 0, spanGaps: false },
    { label: 'Gateway', data: mkData('gateway'), borderColor: '#1c7ed6', pointRadius: 0, spanGaps: false },
    { label: 'Internet', data: mkData('internet'), borderColor: '#f08c00', pointRadius: 0, spanGaps: false }
  ];

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
              return sample ? `Diagnosis: ${outageLabel(diagnose(sample))}` : '';
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
  const status = statusFromSample(sample);

  if (statusPill) {
    statusPill.className = `status-pill ${status.pill}`;
    statusPill.textContent = status.text;
  }

  if (lastCheckEl) {
    lastCheckEl.textContent = `Last checkup: ${formatTimestamp(snapshot.state.lastCheckedAt)}`;
  }

  if (currentStatusEl) {
    currentStatusEl.innerHTML = [
      layerRow('Router', snapshot.settings.routerIp, sample?.router ?? null),
      layerRow('Gateway', snapshot.settings.targets.gateway.replace(/^https?:\/\//, ''), sample?.gateway ?? null),
      layerRow('Internet', 'google.com', sample?.internet ?? null),
      `<p class="dim">${status.sentence}</p>`
    ].join('');
  }

  const hasRouterSuccess = snapshot.samples.some((s) => s.router !== null);
  if (routerHelpEl) {
    routerHelpEl.hidden = hasRouterSuccess || sample?.router !== null;
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
