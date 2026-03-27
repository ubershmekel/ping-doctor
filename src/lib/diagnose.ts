import type { Outage, Sample, TargetId } from '../types';

export function failedTargetIds(sample: Sample): TargetId[] {
  return sample.enabledTargetIds.filter((id) => sample.results[id] === null);
}

export function firstFailedTargetId(sample: Sample): TargetId | null {
  const list = failedTargetIds(sample);
  return list[0] ?? null;
}

export function diagnose(sample: Sample): Outage['diagnosis'] {
  return failedTargetIds(sample).length > 0 ? 'target' : 'unknown';
}

export function isOutageSample(sample: Sample): boolean {
  return failedTargetIds(sample).length > 0;
}
