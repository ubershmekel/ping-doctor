import { getSettings, updateSettings } from '../lib/storage';
import type { TargetConfig } from '../types';

const form = document.querySelector<HTMLFormElement>('#settings-form');
const intervalInput = document.querySelector<HTMLSelectElement>('#poll-interval');
const targetsList = document.querySelector<HTMLDivElement>('#targets-list');
const addTargetBtn = document.querySelector<HTMLButtonElement>('#add-target');
const targetTemplate = document.querySelector<HTMLTemplateElement>('#target-template');
const exportBtn = document.querySelector<HTMLButtonElement>('#export-data');
const clearBtn = document.querySelector<HTMLButtonElement>('#clear-data');
const statusEl = document.querySelector<HTMLParagraphElement>('#status');

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

  const enabledTargets = targets.filter((target) => target.enabled);
  if (enabledTargets.length === 0) {
    setStatus('Enable at least one target.');
    return;
  }

  if (enabledTargets.some((target) => !target.address)) {
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
