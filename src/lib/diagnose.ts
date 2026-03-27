import type { Outage, Sample } from '../types';

export function diagnose(sample: Sample): Outage['diagnosis'] {
  if (sample.router === null) {
    return 'wifi';
  }

  if (sample.gateway === null) {
    return 'isp';
  }

  if (sample.internet === null) {
    return 'internet';
  }

  return 'unknown';
}

export function affectedLayers(sample: Sample): Outage['affectedLayers'] {
  const layers: Outage['affectedLayers'] = [];

  if (sample.router === null) {
    layers.push('router');
  }

  if (sample.gateway === null) {
    layers.push('gateway');
  }

  if (sample.internet === null) {
    layers.push('internet');
  }

  return layers;
}

export function isOutageSample(sample: Sample): boolean {
  return affectedLayers(sample).length > 0;
}