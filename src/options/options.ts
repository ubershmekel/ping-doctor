import {
  Chart,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  ScatterController,
  Tooltip,
  type ChartDataset,
  type Plugin,
} from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import { firstFailedTargetId } from '../lib/diagnose';
import { probeValue } from '../lib/probe';
import { getSettings, updateSettings } from '../lib/storage';
import { formatRecentResultTime, formatTimestamp } from '../lib/time';
import type { Outage, Sample, StorageShape, TargetConfig } from '../types';

Chart.register(
  ScatterController,
  LineElement,
  PointElement,
  LinearScale,
  Tooltip,
  Legend,
  zoomPlugin,
);

const form = document.querySelector<HTMLFormElement>('#settings-form');
const intervalInput = document.querySelector<HTMLInputElement>('#poll-interval');
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
const heatmapPrevBtn = document.querySelector<HTMLButtonElement>('#heatmap-prev');
const heatmapNextBtn = document.querySelector<HTMLButtonElement>('#heatmap-next');
const heatmapPageEl = document.querySelector<HTMLSpanElement>('#heatmap-page');
const chartCanvas = document.querySelector<HTMLCanvasElement>('#latency-chart');

let latestSnapshot: StorageShape | null = null;
let selectedDate: string | null = null;
let outageLogPage = 0;
let heatmapPage = 0;
const OUTAGE_PAGE_SIZE = 10;
const HEATMAP_PAGE_SIZE = 7;
let chartSamples: Sample[] = [];
let chartFailureSpans: Array<{ start: number; end: number }> = [];
let chart: Chart | null = null;

const palette = ['#2f9e44', '#1c7ed6', '#f08c00', '#862e9c', '#c92a2a', '#0b7285'];

let targetAverages: Map<string, number> = new Map();
let failureTooltipEl: HTMLDivElement | null = null;

type TargetStats = {
  total: number;
  failed: number;
  uptimePct: number;
  avgLatency: number;
};

type HeatmapDayStats = {
  uptime: number;
  targets: Record<string, TargetStats>;
};

type HeatmapData = {
  days: string[];
  statsByDate: Map<string, HeatmapDayStats>;
};

type RawDayStats = {
  totalSamples: number;
  healthySamples: number;
  targets: Map<
    string,
    { total: number; failed: number; latencyTotal: number; latencyCount: number }
  >;
};

function isFailedSample(sample: Sample): boolean {
  return sample.enabledTargetIds.some((targetId) => sample.results[targetId] === null);
}

function computeTargetAverages(snapshot: StorageShape): Map<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const sample of snapshot.samples) {
    for (const targetId of sample.enabledTargetIds) {
      const value = sample.results[targetId];
      if (value !== null) {
        const entry = sums.get(targetId) ?? { total: 0, count: 0 };
        entry.total += value;
        entry.count += 1;
        sums.set(targetId, entry);
      }
    }
  }
  const averages = new Map<string, number>();
  for (const [id, { total, count }] of sums) {
    averages.set(id, Math.round(total / count));
  }
  return averages;
}

function formatLatency(value: number | null, targetId: string): string {
  if (value === null) return '<span class="down-state">down</span>';
  const avg = targetAverages.get(targetId);
  if (avg !== undefined && avg > 0 && value >= avg * 2) {
    return `<span class="latency-warn">${value}ms</span>`;
  }
  return `${value}ms`;
}

function handleChartEvent(
  c: Chart,
  args: { event: { type: string; x: number | null; y: number | null } },
): void {
  const tip = failureTooltipEl;
  if (!tip) return;
  const { event } = args;

  if (event.type === 'mouseout') {
    tip.style.display = 'none';
    return;
  }

  if (event.type !== 'mousemove' || event.x == null || event.y == null) return;

  const { scales, chartArea } = c;
  const xScale = scales.x;
  if (!xScale) return;

  for (const span of chartFailureSpans) {
    const x = xScale.getPixelForValue(span.start);
    if (x < chartArea.left || x > chartArea.right) continue;
    const y = chartArea.top + 12;

    if (Math.abs(event.x - x) <= 10 && Math.abs(event.y - y) <= 10) {
      const sample = chartSamples.find((s) => s.ts === span.start);
      if (!sample || !latestSnapshot) {
        tip.style.display = 'none';
        return;
      }

      const labelMap = targetLabelById(latestSnapshot);
      const downTargets = sample.enabledTargetIds
        .filter((id) => sample.results[id] === null)
        .map((id) => labelMap.get(id) ?? id);

      const duration = span.end - span.start;

      tip.innerHTML =
        `<strong>Failure</strong><br>` +
        `${formatTimestamp(span.start)} \u2013 ${formatTimestamp(span.end)}<br>` +
        `Duration: ${formatDurationMs(duration)}<br>` +
        `Down: ${downTargets.join(', ')}`;
      tip.style.display = 'block';
      tip.style.left = `${event.x + 12}px`;
      tip.style.top = `${event.y - 10}px`;
      return;
    }
  }

  tip.style.display = 'none';
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
  },
  afterEvent: handleChartEvent,
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
      const enabled =
        row.querySelector<HTMLInputElement>('[data-field="enabled"]')?.checked ?? false;
      const label = row.querySelector<HTMLInputElement>('[data-field="label"]')?.value.trim() ?? '';
      const address =
        row.querySelector<HTMLInputElement>('[data-field="address"]')?.value.trim() ?? '';

      if (!id) {
        return null;
      }

      return {
        id,
        enabled,
        label: label || 'Target',
        address,
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

function statusFromSample(
  sample: Sample | undefined,
  snapshot: StorageShape,
): { pill: string; text: string; sentence: string } {
  if (!sample) {
    return { pill: 'pill-degraded', text: 'Waiting', sentence: 'Waiting for first check...' };
  }

  if (isHealthySample(sample)) {
    return { pill: 'pill-healthy', text: 'Healthy', sentence: 'All enabled targets responded' };
  }

  const firstDown = firstFailedTargetId(sample);
  const labelMap = targetLabelById(snapshot);
  const label = firstDown ? (labelMap.get(firstDown) ?? 'Target') : 'Target';
  return {
    pill: 'pill-degraded',
    text: 'Degraded',
    sentence: `${label} did not respond`,
  };
}

function layerRow(label: string, target: string, value: number | null, targetId: string): string {
  const state = formatLatency(value, targetId);
  const avg = targetAverages.get(targetId);
  const avgText = avg !== undefined ? ` <span class="avg-label">(avg ${avg}ms)</span>` : '';
  return `<div class="layer-row"><span>${label}</span><code>${target}</code><strong>${state}${avgText}</strong></div>`;
}

function formatTarget(value: string): string {
  return value.replace(/^https?:\/\//, '');
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

  const targets = enabledTargets(snapshot);
  const headerCells = targets
    .map((t) => {
      const avg = targetAverages.get(t.id);
      const avgText = avg !== undefined ? `<br><span class="avg-label">avg ${avg}ms</span>` : '';
      return `<th>${t.label}${avgText}</th>`;
    })
    .join('');

  const rows = recent
    .map((sample) => {
      const cells = targets
        .map((t) => `<td>${formatLatency(probeValue(sample, t.id), t.id)}</td>`)
        .join('');
      return `<tr><td>${formatRecentResultTime(sample.ts)}</td>${cells}</tr>`;
    })
    .join('');

  recentResultsEl.innerHTML = `<table class="results-table"><thead><tr><th>When</th>${headerCells}</tr></thead><tbody>${rows}</tbody></table>`;
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

function shiftDay(date: string, offset: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(year, month - 1, day + offset);
  next.setHours(0, 0, 0, 0);
  return dayString(next.getTime());
}

function formatDayRange(start: string, end: string): string {
  return start === end ? start : `${start} - ${end}`;
}

function formatDailyAverageLatency(
  avgLatency: number,
  totalChecks: number,
  failedChecks: number,
): string {
  if (totalChecks - failedChecks <= 0) {
    return 'n/a';
  }

  return `${avgLatency}ms`;
}

function statsFromSummaryTargets(summary: StorageShape['daySummaries'][number]): HeatmapDayStats {
  const targets: Record<string, TargetStats> = {};
  for (const [id, t] of Object.entries(summary.targets)) {
    targets[id] = {
      total: t.totalPings,
      failed: t.failedPings,
      uptimePct: t.uptimePct,
      avgLatency: t.avgLatency,
    };
  }

  const entries = Object.values(targets);
  return {
    uptime: entries.length === 0 ? -1 : Math.min(...entries.map((t) => t.uptimePct)),
    targets,
  };
}

function createRawDayStats(): RawDayStats {
  return {
    totalSamples: 0,
    healthySamples: 0,
    targets: new Map(),
  };
}

function appendRawSampleStats(stats: RawDayStats, sample: Sample): void {
  stats.totalSamples += 1;
  if (isHealthySample(sample)) {
    stats.healthySamples += 1;
  }

  for (const id of sample.enabledTargetIds) {
    const target = stats.targets.get(id) ?? {
      total: 0,
      failed: 0,
      latencyTotal: 0,
      latencyCount: 0,
    };
    const value = sample.results[id];

    target.total += 1;
    if (value === null) {
      target.failed += 1;
    } else if (typeof value === 'number') {
      target.latencyTotal += value;
      target.latencyCount += 1;
    }

    stats.targets.set(id, target);
  }
}

function finalizeRawDayStats(stats: RawDayStats): HeatmapDayStats {
  const targets: Record<string, TargetStats> = {};
  for (const [id, target] of stats.targets) {
    targets[id] = {
      total: target.total,
      failed: target.failed,
      uptimePct:
        target.total === 0
          ? -1
          : Number((((target.total - target.failed) / target.total) * 100).toFixed(2)),
      avgLatency:
        target.latencyCount > 0
          ? Number((target.latencyTotal / target.latencyCount).toFixed(1))
          : 0,
    };
  }

  return {
    uptime:
      stats.totalSamples === 0
        ? -1
        : Number(((stats.healthySamples / stats.totalSamples) * 100).toFixed(2)),
    targets,
  };
}

function mergeTargetStats(current: TargetStats | undefined, next: TargetStats): TargetStats {
  if (!current) {
    return next;
  }

  const total = current.total + next.total;
  const failed = current.failed + next.failed;
  const currentSuccesses = current.total - current.failed;
  const nextSuccesses = next.total - next.failed;
  const successes = currentSuccesses + nextSuccesses;

  return {
    total,
    failed,
    uptimePct: total === 0 ? -1 : Number((((total - failed) / total) * 100).toFixed(2)),
    avgLatency:
      successes > 0
        ? Number(
            (
              (current.avgLatency * currentSuccesses + next.avgLatency * nextSuccesses) /
              successes
            ).toFixed(1),
          )
        : 0,
  };
}

function mergeHeatmapDayStats(
  current: HeatmapDayStats | undefined,
  next: HeatmapDayStats,
): HeatmapDayStats {
  if (!current) {
    return next;
  }

  const targets = { ...current.targets };
  for (const [id, target] of Object.entries(next.targets)) {
    targets[id] = mergeTargetStats(targets[id], target);
  }

  const entries = Object.values(targets);
  return {
    uptime: entries.length === 0 ? -1 : Math.min(...entries.map((t) => t.uptimePct)),
    targets,
  };
}

function buildHeatmapData(snapshot: StorageShape): HeatmapData {
  const today = dayString(Date.now());
  const knownDays = new Set<string>([today]);
  const statsByDate = new Map<string, HeatmapDayStats>();

  for (const summary of snapshot.daySummaries) {
    knownDays.add(summary.date);
    statsByDate.set(summary.date, statsFromSummaryTargets(summary));
  }

  const rawStatsByDate = new Map<string, RawDayStats>();
  for (const sample of snapshot.samples) {
    const date = dayString(sample.ts);
    knownDays.add(date);

    const stats = rawStatsByDate.get(date) ?? createRawDayStats();
    appendRawSampleStats(stats, sample);
    rawStatsByDate.set(date, stats);
  }

  for (const [date, stats] of rawStatsByDate) {
    const rawDayStats = finalizeRawDayStats(stats);
    statsByDate.set(date, mergeHeatmapDayStats(statsByDate.get(date), rawDayStats));
  }

  const sortedDays = [...knownDays].sort();
  const firstDay = sortedDays[0] ?? today;
  const days: string[] = [];
  let current = firstDay;

  while (current <= today) {
    days.push(current);
    current = shiftDay(current, 1);
  }

  return { days, statsByDate };
}

function visibleHeatmapDays(data: HeatmapData): { days: string[]; totalPages: number } {
  const { days } = data;
  const totalPages = Math.max(1, Math.ceil(days.length / HEATMAP_PAGE_SIZE));
  heatmapPage = Math.min(heatmapPage, totalPages - 1);

  const end = days.length - heatmapPage * HEATMAP_PAGE_SIZE;
  const start = Math.max(0, end - HEATMAP_PAGE_SIZE);
  return { days: days.slice(start, end).reverse(), totalPages };
}

function describeAffected(outage: Outage, snapshot: StorageShape): string {
  const labelMap = targetLabelById(snapshot);
  if (outage.affectedTargetIds.length === 0) {
    return 'No affected targets';
  }

  return outage.affectedTargetIds.map((id) => labelMap.get(id) ?? id).join(', ');
}

type LogItem = {
  ts: number;
  endTs: number;
  durationMs: number;
  primaryLabel: string;
  type: 'outage' | 'netchange';
  html: string;
};

function mergeLogItems(snapshot: StorageShape): LogItem[] {
  const entries: LogItem[] = [];
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

    const primaryLabel = outage.primaryTargetId
      ? (labelMap.get(outage.primaryTargetId) ?? outage.primaryTargetId)
      : 'Target';

    entries.push({
      ts: outage.start,
      endTs: end,
      durationMs: end - outage.start,
      primaryLabel,
      type: 'outage',
      html: `<div class="outage-item"><strong>${new Date(outage.start).toLocaleString()} – ${outage.end ? new Date(outage.end).toLocaleTimeString() : 'ongoing'}</strong> (${formatDurationMs(end - outage.start)}) on ${primaryLabel}<br /><span class="dim">Affected: ${describeAffected(outage, snapshot)}</span></div>`,
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
      endTs: sample.ts,
      durationMs: 0,
      primaryLabel: '',
      type: 'netchange',
      html: `<div class="net-change">Network change detected – monitoring resumed (${new Date(sample.ts).toLocaleString()})</div>`,
    });
  }

  return entries.sort((a, b) => b.ts - a.ts);
}

function hourKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}`;
}

function groupLogItems(items: LogItem[], snapshot: StorageShape): string[] {
  if (items.length === 0) return [];

  const buckets = new Map<string, LogItem[]>();
  for (const item of items) {
    const key = hourKey(item.ts);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(item);
  }

  // Sort buckets newest first
  const sorted = [...buckets.values()].sort((a, b) => b[0].ts - a[0].ts);
  const labelMap = targetLabelById(snapshot);

  return sorted.map((group) => {
    group.sort((a, b) => b.ts - a.ts);
    const spanStart = group[group.length - 1].ts;
    const spanEnd = group[0].endTs;

    // Count failed pings per target from raw samples within this hour's span
    const failedByTarget = new Map<string, number>();
    for (const sample of snapshot.samples) {
      if (sample.ts < spanStart || sample.ts > spanEnd) continue;
      for (const [targetId, result] of Object.entries(sample.results)) {
        if (result === null) {
          failedByTarget.set(targetId, (failedByTarget.get(targetId) ?? 0) + 1);
        }
      }
    }

    const failedParts = [...failedByTarget.entries()].map(
      ([id, count]) => `${labelMap.get(id) ?? id}: ${count} failed`,
    );

    const hourLabel = new Date(spanStart).toLocaleString([], {
      month: 'numeric',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
    });

    const summaryText =
      failedParts.length > 0 ? `${hourLabel} — ${failedParts.join(' · ')}` : hourLabel;

    const inner = group.map((i) => i.html).join('');
    return `<details class="outage-group"><summary>${summaryText}</summary><div class="outage-group-items">${inner}</div></details>`;
  });
}

function colorForUptime(uptime: number): string {
  if (uptime < 0) return '#868e96';
  if (uptime >= 99.5) return '#2f9e44';
  if (uptime >= 95) return '#74b816';
  if (uptime >= 80) return '#f08c00';
  return '#e03131';
}

function renderHeatmap(snapshot: StorageShape): void {
  if (!heatmapEl) {
    return;
  }

  const heatmapData = buildHeatmapData(snapshot);
  const { days, totalPages } = visibleHeatmapDays(heatmapData);
  const rangeLabel =
    days.length > 0 ? formatDayRange(days[days.length - 1], days[0]) : dayString(Date.now());
  const labelMap = targetLabelById(snapshot);

  if (heatmapPrevBtn) {
    heatmapPrevBtn.disabled = heatmapPage === 0;
  }
  if (heatmapNextBtn) {
    heatmapNextBtn.disabled = heatmapPage >= totalPages - 1;
  }
  if (heatmapPageEl) {
    heatmapPageEl.textContent = `${rangeLabel} · Page ${heatmapPage + 1} of ${totalPages}`;
  }

  const cellW = 90;
  const cellH = 34;
  const y = 20;

  heatmapEl.innerHTML = '';

  days.forEach((date, idx) => {
    const stats = heatmapData.statsByDate.get(date);
    const uptime = stats?.uptime ?? -1;
    const noData = uptime < 0;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(idx * (cellW + 8)));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(cellW));
    rect.setAttribute('height', String(cellH));
    rect.setAttribute('rx', '4');
    rect.setAttribute('fill', colorForUptime(uptime));
    rect.setAttribute('stroke', selectedDate === date ? 'currentColor' : 'transparent');
    rect.setAttribute('stroke-width', selectedDate === date ? '2' : '0');
    rect.setAttribute('class', 'clickable-day');
    rect.addEventListener('click', () => {
      selectedDate = selectedDate === date ? null : date;
      outageLogPage = 0;
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
    pct.textContent = noData ? 'No data' : `${uptime.toFixed(1)}%`;

    const detail = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    if (noData) {
      detail.textContent = `${date}: No data collected`;
    } else {
      const lines = Object.entries(stats.targets).map(([id, t]) => {
        const name = labelMap.get(id) ?? id;
        return `${name}: ${t.total} checks, ${t.failed} failed (${t.uptimePct.toFixed(1)}%), avg ${formatDailyAverageLatency(t.avgLatency, t.total, t.failed)}`;
      });
      detail.textContent = `${date}\n${lines.join('\n')}`;
    }

    g.appendChild(label);
    g.appendChild(rect);
    g.appendChild(pct);
    g.appendChild(detail);
    heatmapEl.appendChild(g);
  });
}

function renderChart(snapshot: StorageShape): void {
  if (!chartCanvas) {
    return;
  }

  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
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
    const end =
      chartSamples.length > 0 ? chartSamples[chartSamples.length - 1].ts : activeFailureStart;
    chartFailureSpans.push({ start: activeFailureStart, end });
  }

  const targets = enabledTargets(snapshot);
  const datasets: ChartDataset<'scatter'>[] = targets.map((target, idx) => ({
    label: target.label,
    data: chartSamples
      .map((sample) => {
        const y = probeValue(sample, target.id);
        return y !== null ? { x: sample.ts, y } : null;
      })
      .filter((p): p is { x: number; y: number } => p !== null),
    borderColor: palette[idx % palette.length],
    backgroundColor: palette[idx % palette.length],
    pointRadius: 2,
    showLine: false,
  }));

  if (chart) {
    chart.data.datasets = datasets;
    chart.update();
    return;
  }

  chart = new Chart(chartCanvas, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          type: 'linear',
          ticks: {
            callback: (v) =>
              new Date(Number(v)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Latency (ms)' },
        },
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            title: (items) => new Date(Number(items[0].parsed.x)).toLocaleString(),
            label: (item) => `${item.dataset.label}: ${item.parsed.y}ms`,
          },
        },
        zoom: {
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
          pan: { enabled: true, mode: 'x' },
        },
      },
    },
  });

  if (!failureTooltipEl && chartCanvas.parentElement) {
    chartCanvas.parentElement.style.position = 'relative';
    failureTooltipEl = document.createElement('div');
    failureTooltipEl.className = 'failure-tooltip';
    chartCanvas.parentElement.appendChild(failureTooltipEl);
  }
}

function renderOutages(snapshot: StorageShape): void {
  if (!outageLogEl || !outageTitleEl) {
    return;
  }

  outageTitleEl.textContent = selectedDate ? `Outage Log (${selectedDate})` : 'Outage Log';
  const grouped = groupLogItems(mergeLogItems(snapshot), snapshot);

  if (grouped.length === 0) {
    outageLogEl.innerHTML = '<p class="dim">No recent outages.</p>';
    return;
  }

  const totalPages = Math.ceil(grouped.length / OUTAGE_PAGE_SIZE);
  outageLogPage = Math.min(outageLogPage, totalPages - 1);
  const page = grouped.slice(
    outageLogPage * OUTAGE_PAGE_SIZE,
    (outageLogPage + 1) * OUTAGE_PAGE_SIZE,
  );

  const pagination =
    totalPages > 1
      ? `<div class="outage-pagination">
          <button id="outage-prev" ${outageLogPage === 0 ? 'disabled' : ''}>&larr; Prev</button>
          <span class="dim">Page ${outageLogPage + 1} of ${totalPages}</span>
          <button id="outage-next" ${outageLogPage >= totalPages - 1 ? 'disabled' : ''}>Next &rarr;</button>
        </div>`
      : '';

  outageLogEl.innerHTML = page.join('') + pagination;

  outageLogEl.querySelector('#outage-prev')?.addEventListener('click', () => {
    outageLogPage--;
    renderOutages(snapshot);
  });
  outageLogEl.querySelector('#outage-next')?.addEventListener('click', () => {
    outageLogPage++;
    renderOutages(snapshot);
  });
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
    lastCheckEl.textContent = `Last check: ${formatTimestamp(snapshot.state.lastCheckedAt)}`;
  }

  if (currentStatusEl) {
    const rows = targets.map((target) =>
      layerRow(
        target.label,
        formatTarget(target.address),
        probeValue(sample, target.id),
        target.id,
      ),
    );
    rows.push(`<p class="dim">${status.sentence}</p>`);
    currentStatusEl.innerHTML = rows.join('');
  }
}

function renderAllStats(snapshot: StorageShape): void {
  targetAverages = computeTargetAverages(snapshot);
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

heatmapPrevBtn?.addEventListener('click', () => {
  if (!latestSnapshot || heatmapPage === 0) {
    return;
  }

  heatmapPage -= 1;
  renderHeatmap(latestSnapshot);
});

heatmapNextBtn?.addEventListener('click', () => {
  if (!latestSnapshot) {
    return;
  }

  heatmapPage += 1;
  renderHeatmap(latestSnapshot);
});

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

  const pollIntervalSec = Number(intervalInput.value);

  await updateSettings({
    pollIntervalSec,
    targets,
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
  checkNowButton.textContent = 'Checking...';

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
