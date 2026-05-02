/**
 * lf-host-stats — Light DOM panel component.
 * Subscribes to store 'hostStats' and 'gpuHardware' and renders the host stats strip bar.
 */
import { store } from '../store.js';

class LfHostStats extends HTMLElement {
  #hostData = null;
  #gpuData = null;

  connectedCallback() {
    const hostData = store.get('hostStats');
    if (hostData) { this.#hostData = hostData; this.#render(); }

    const gpuData = store.get('gpuHardware');
    if (gpuData) { this.#gpuData = gpuData; }

    store.subscribe('hostStats', (data) => { this.#hostData = data; this.#render(); });
    store.subscribe('gpuHardware', (data) => { this.#gpuData = data; this.#render(); });

    store.addEventListener('hostStatsError', () => {
      if (this.querySelector('.host-stats-loading')) {
        this.innerHTML = '<span class="host-stats-loading">Host stats unavailable</span>';
      }
    });
  }

  #render() {
    const data = this.#hostData;
    if (!data) return;

    const memPct = data.mem_total_mib > 0
      ? Math.round((data.mem_used_mib / data.mem_total_mib) * 100)
      : 0;
    const memUsedGib  = (data.mem_used_mib  / 1024).toFixed(1);
    const memTotalGib = (data.mem_total_mib / 1024).toFixed(1);
    const memColor = memPct >= 90 ? 'var(--danger)' : memPct >= 70 ? '#ffbe5c' : 'var(--accent-2)';

    const cpuPct = data.cpu_utilization_percent ?? 0;
    const cpuColor = cpuPct >= 90 ? 'var(--danger)' : cpuPct >= 60 ? '#ffbe5c' : 'var(--accent)';
    const load1 = data.loadavg ? data.loadavg[0].toFixed(2) : '\u2014';

    const coreSquares = Array.isArray(data.cpu_per_core) && data.cpu_per_core.length > 0
      ? data.cpu_per_core.map((pct, i) => {
          const c = pct >= 80 ? 'var(--danger)' : pct >= 40 ? '#ffbe5c' : pct >= 10 ? 'var(--accent)' : 'rgba(159,176,216,0.18)';
          return `<span class="hs-core-sq" style="background:${c}" title="Core ${i}: ${pct}%"></span>`;
        }).join('')
      : '';

    const gpus = Array.isArray(this.#gpuData?.data) ? this.#gpuData.data : [];
    let gpuHtml = '';
    if (gpus.length > 0) {
      const totalVramMib = gpus.reduce((s, g) => s + (g.memory_total_mib || 0), 0);
      const usedVramMib  = gpus.reduce((s, g) => s + (g.memory_used_mib  || 0), 0);
      const vramPct = totalVramMib > 0 ? Math.round((usedVramMib / totalVramMib) * 100) : 0;
      const vramUsedGib  = (usedVramMib  / 1024).toFixed(1);
      const vramTotalGib = (totalVramMib / 1024).toFixed(1);
      const vramColor = vramPct >= 90 ? 'var(--danger)' : vramPct >= 70 ? '#ffbe5c' : 'var(--accent)';
      gpuHtml = `
    <div class="host-strip-stat">
      <span class="hs-label">GPU</span>
      <span class="hs-muted">${gpus.length}&times;</span>
      <div class="hs-bar-wrap"><div class="hs-bar-fill" style="width:${vramPct}%;background:${vramColor}"></div></div>
      <span class="hs-value">${vramUsedGib}/${vramTotalGib}&thinsp;GiB</span>
    </div>`;
    }

    this.innerHTML = `
    <div class="host-strip-stat">
      <span class="hs-label">CPU</span>
      <div class="hs-bar-wrap"><div class="hs-bar-fill" style="width:${cpuPct}%;background:${cpuColor}"></div></div>
      <span class="hs-value">${cpuPct}%&thinsp;avg</span>
      <span class="hs-muted">load&thinsp;${load1}</span>
    </div>
    <div class="host-strip-stat">
      <span class="hs-label">RAM</span>
      <div class="hs-bar-wrap"><div class="hs-bar-fill" style="width:${memPct}%;background:${memColor}"></div></div>
      <span class="hs-value">${memUsedGib}/${memTotalGib}&thinsp;GiB</span>
      <span class="hs-muted">${memPct}%</span>
    </div>${gpuHtml}
    ${coreSquares ? `<div class="hs-cores" title="Per-core CPU utilisation">${coreSquares}</div>` : ''}`;  
  }
}

customElements.define('lf-host-stats', LfHostStats);
