// store.js — reactive data store + polling
// Holds instances, hostStats, and gpuHardware. Fires 'change:<key>' events.
// Imported by app.js and future Web Components.

import { api } from './api.js';

class Store extends EventTarget {
  #data = new Map();

  get(key) {
    return this.#data.get(key);
  }

  set(key, value) {
    this.#data.set(key, value);
    this.dispatchEvent(new CustomEvent('change:' + key, { detail: value }));
  }

  subscribe(key, cb) {
    this.addEventListener('change:' + key, (e) => cb(e.detail));
  }

  async #fetchInstances() {
    const { data, gpus } = await api("/v1/instances");
    if (Array.isArray(gpus)) this.set('gpus', gpus);
    this.set('instances', data || []);
  }

  async #fetchHostStats() {
    try {
      const data = await api("/v1/host-stats");
      this.set('hostStats', data);
    } catch {
      this.dispatchEvent(new CustomEvent('hostStatsError'));
    }
  }

  async #fetchGpuHardware() {
    const result = await api("/v1/gpus");
    this.set('gpuHardware', result);
  }

  async refresh(key) {
    if (key === 'instances') return this.#fetchInstances();
    if (key === 'hostStats') return this.#fetchHostStats();
    if (key === 'gpuHardware') return this.#fetchGpuHardware();
    throw new Error(`Unknown store key: ${key}`);
  }

  startPolling() {
    void this.#fetchInstances().catch(() => {});
    void this.#fetchHostStats().catch(() => {});
    void this.#fetchGpuHardware().catch(() => {});

    setInterval(() => void this.#fetchInstances().catch(() => {}), 2000);
    setInterval(() => void this.#fetchHostStats().catch(() => {}), 3000);
    setInterval(() => void this.#fetchGpuHardware().catch(() => {}), 15000);
  }
}

export const store = new Store();
