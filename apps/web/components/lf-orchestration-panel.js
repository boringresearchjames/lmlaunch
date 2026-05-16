/**
 * lf-orchestration-panel.js
 * Web Component for managing orchestration routes and frontier backends.
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { copy } from './utils.js';

const CONDITION_TYPES = [
  { value: 'toolsPresent',         label: 'Tools present',              hasValue: false },
  { value: 'toolNameContains',     label: 'Tool available (name has)',  hasValue: true, placeholder: 'e.g. execute_command' },
  { value: 'toolCalledContains',   label: 'Tool was called (name has)', hasValue: true, placeholder: 'e.g. bash' },
  { value: 'systemPromptContains', label: 'System prompt contains',     hasValue: true, placeholder: 'keyword' },
  { value: 'messageContains',      label: 'Any message contains',       hasValue: true, placeholder: 'keyword' },
  { value: 'estimatedTokens',      label: 'Estimated tokens',           hasValue: true, hasOp: true, placeholder: '6000' },
  { value: 'multiTurnDepth',       label: 'Message count',              hasValue: true, hasOp: true, placeholder: '10' },
];

class LfOrchestrationPanel extends HTMLElement {
  constructor() {
    super();
    this._routes = [];
    this._frontierBackends = [];
    this._runningInstances = [];
    this._instanceConfigs = [];
    this._editingRoute = null;
    this._editingBackend = null;
    this._log = [];
    this._logPollTimer = null;
    this._testEntry = null;  // log entry currently selected in rule tester
    this._expandedLogId = null; // log row currently expanded
  }

  connectedCallback() {
    this.render();
    this._load();
    // Keep running-instances list in sync with the live store
    this._runningInstances = (store.get('instances') || []).filter(i => i.state !== 'stopped');
    store.subscribe('instances', (data) => {
      this._runningInstances = (data || []).filter(i => i.state !== 'stopped');
    });
  }

  disconnectedCallback() {
    if (this._logPollTimer) clearInterval(this._logPollTimer);
  }

  async _load() {
    try {
      const [routesRes, backendsRes, configsRes] = await Promise.all([
        api('/api/orchestration-routes'),
        api('/api/frontier-backends'),
        api('/v1/instance-configs'),
      ]);
      this._routes = routesRes.data || [];
      this._frontierBackends = backendsRes.data || [];
      this._instanceConfigs = configsRes.data || [];
      if (!this._runningInstances.length) {
        this._runningInstances = (store.get('instances') || []).filter(i => i.state !== 'stopped');
      }
      await this._loadLog();
      this._renderContent();
      // Poll log every 5s
      if (!this._logPollTimer) {
        this._logPollTimer = setInterval(() => this._loadLog(), 5000);
      }
    } catch (e) {
      this.querySelector('.orch-error').textContent = `Load failed: ${e.message}`;
    }
  }

  async _loadLog() {
    try {
      const res = await api('/api/orchestration-log');
      this._log = res.data || [];
      this._renderLogSection();
    } catch { /* non-fatal */ }
  }

  render() {
    this.innerHTML = `
      <div class="orch-panel">
        <div class="orch-error" style="color:var(--danger);min-height:1.2em"></div>
        <div class="orch-body"></div>
        <div class="orch-log-section"></div>
      </div>
      ${this._routeDialogTemplate()}
      ${this._backendDialogTemplate()}
    `;
    this._bindDialogEvents();
  }

  _renderContent() {
    const body = this.querySelector('.orch-body');
    if (!body) return;
    body.innerHTML = `
      <div class="orch-section">
        <div class="orch-section-header">
          <div>
            <h3 class="orch-section-title">Orchestration Routes</h3>
            <p class="orch-section-subtitle">Virtual model names that route requests to local instances or frontier APIs based on rules.</p>
          </div>
          <button class="btn-primary orch-add-route-btn" type="button">+ Add Route</button>
        </div>
        ${this._routes.length === 0
          ? '<p class="orch-empty">No orchestration routes yet. Add one to start routing requests intelligently.</p>'
          : `<div class="orch-routes-list">${this._routes.map(r => this._routeCard(r)).join('')}</div>`
        }
      </div>

      <div class="orch-section orch-section-frontier">
        <div class="orch-section-header">
          <div>
            <h3 class="orch-section-title">Frontier Backends</h3>
            <p class="orch-section-subtitle">OpenAI-compatible external APIs (OpenRouter, Together, Groq, etc.) used as routing targets.</p>
          </div>
          <button class="btn-primary orch-add-backend-btn" type="button">+ Add Backend</button>
        </div>
        ${this._frontierBackends.length === 0
          ? '<p class="orch-empty">No frontier backends configured.</p>'
          : `<div class="orch-backends-list">${this._frontierBackends.map(b => this._backendCard(b)).join('')}</div>`
        }
      </div>
    `;
    this._renderLogSection();
    this.querySelector('.orch-add-route-btn').onclick = () => this._openRouteDialog(null);
    this.querySelector('.orch-add-backend-btn').onclick = () => this._openBackendDialog(null);
    this.querySelectorAll('.orch-copy-model, .orch-copy-url').forEach(btn => {
      btn.onclick = () => copy(btn.dataset.copy || '');
    });
    this.querySelectorAll('.orch-edit-route').forEach(btn => {
      btn.onclick = () => {
        const r = this._routes.find(x => x.id === btn.dataset.id);
        if (r) this._openRouteDialog(r);
      };
    });
    this.querySelectorAll('.orch-delete-route').forEach(btn => {
      btn.onclick = () => this._deleteRoute(btn.dataset.id);
    });
    this.querySelectorAll('.orch-edit-backend').forEach(btn => {
      btn.onclick = () => {
        const b = this._frontierBackends.find(x => x.id === btn.dataset.id);
        if (b) this._openBackendDialog(b);
      };
    });
    this.querySelectorAll('.orch-delete-backend').forEach(btn => {
      btn.onclick = () => this._deleteBackend(btn.dataset.id);
    });
  }

  _routeCard(r) {
    const hourly = r._hourly || {};
    const totalReq = (hourly.localRequests || 0) + (hourly.frontierRequests || 0);
    const localPct = totalReq > 0 ? Math.round((hourly.localRequests / totalReq) * 100) : null;
    const costDisplay = this._estimateRouteCost(r, hourly);
    return `
      <div class="orch-card">
        <div class="orch-card-main">
          <div class="orch-card-name"><code>${this._esc(r.name)}</code></div>
          <div class="orch-card-meta">
            ${r.rules.length} rule${r.rules.length !== 1 ? 's' : ''}
            &middot; default: ${this._backendLabel(r.defaultBackend)}
            ${r.fallbackBackend ? `&middot; fallback: ${this._backendLabel(r.fallbackBackend)}` : ''}
          </div>
          ${r.description ? `<div class="orch-card-desc">${this._esc(r.description)}</div>` : ''}
          ${totalReq > 0 ? `
            <div class="orch-cost-bar" title="${hourly.localRequests || 0} local / ${hourly.frontierRequests || 0} frontier in last hour">
              <div class="orch-cost-bar-local" style="width:${localPct}%"></div>
            </div>
            <div class="orch-cost-stats">
              <span class="orch-stat-local">⬡ ${hourly.localRequests || 0} local</span>
              <span class="orch-stat-frontier">☁ ${hourly.frontierRequests || 0} frontier</span>
              ${costDisplay ? `<span class="orch-stat-cost">~$${costDisplay}/hr</span>` : ''}
            </div>
          ` : '<div class="orch-cost-stats orch-cost-idle">No requests in last hour</div>'}
        </div>
        <div class="orch-card-actions">
          <button class="btn-small orch-copy-model" data-id="${r.id}" data-copy="${this._esc(r.name)}" type="button" title="Copy model ID for use with /v1/chat/completions">&#x1F4CB; Model</button>
          <button class="btn-small orch-copy-url" data-id="${r.id}" data-copy="${this._esc(window.location.origin + '/v1/chat/completions')}" type="button" title="Copy API endpoint URL">&#x1F4CB; URL</button>
          <button class="btn-small orch-edit-route" data-id="${r.id}" type="button">Edit</button>
          <button class="btn-small btn-danger orch-delete-route" data-id="${r.id}" type="button">Delete</button>
        </div>
      </div>
    `;
  }

  _backendCard(b) {
    const stats = b._stats;
    const costUsd = stats?.estimatedCostUsd;
    return `
      <div class="orch-card">
        <div class="orch-card-main">
          <div class="orch-card-name"><code>${this._esc(b.name)}</code></div>
          <div class="orch-card-meta">
            ${this._esc(b.baseUrl)} &middot; model: <code>${this._esc(b.model)}</code>
          </div>
          ${stats ? `<div class="orch-card-desc">${stats.totalRequests || 0} total req &middot; ${stats.totalInputTokens || 0} in / ${stats.totalOutputTokens || 0} out tokens${costUsd != null ? ` &middot; ~$${costUsd.toFixed(4)} session cost` : ''}</div>` : ''}
        </div>
        <div class="orch-card-actions">
          <button class="btn-small orch-edit-backend" data-id="${b.id}" type="button">Edit</button>
          <button class="btn-small btn-danger orch-delete-backend" data-id="${b.id}" type="button">Delete</button>
        </div>
      </div>
    `;
  }

  _estimateRouteCost(route, hourly) {
    if (!hourly.frontierRequests) return null;
    // Find frontier backend cost for defaultBackend
    const fb = route.defaultBackend?.type === 'frontier'
      ? this._frontierBackends.find(b => b.id === route.defaultBackend.backendId)
      : null;
    if (!fb || (!fb.costPer1kInputTokens && !fb.costPer1kOutputTokens)) return null;
    const stats = fb._stats;
    if (!stats?.estimatedCostUsd || !stats?.totalRequests) return null;
    const avgCostPerReq = stats.estimatedCostUsd / stats.totalRequests;
    return (avgCostPerReq * hourly.frontierRequests).toFixed(4);
  }

  // ── Routing Log ─────────────────────────────────────────────────────────

  _renderLogSection() {
    const el = this.querySelector('.orch-log-section');
    if (!el) return;
    el.innerHTML = `
      <div class="orch-section orch-section-log">
        <div class="orch-section-header">
          <div>
            <h3 class="orch-section-title">Routing Log</h3>
            <p class="orch-section-subtitle">Last ${this._log.length} routed requests — click <b>Test rules →</b> to open the rule editor with that request pre-loaded for live testing.</p>
          </div>
          <button class="btn-small orch-log-refresh" type="button">Refresh</button>
        </div>
        ${this._log.length === 0
          ? '<p class="orch-empty">No routed requests yet. Send a request to a virtual model name to see entries here.</p>'
          : `<div class="orch-log-table">
              <div class="orch-log-header">
                <span></span><span>Time</span><span>Route</span><span>Rule</span><span>Backend</span><span>ms</span><span>Meta</span><span></span>
              </div>
              ${this._log.map(e => this._logRow(e)).join('')}
             </div>`
        }
      </div>
    `;
    el.querySelector('.orch-log-refresh')?.addEventListener('click', () => this._loadLog());
    el.querySelectorAll('.orch-log-row-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        this._expandedLogId = this._expandedLogId === btn.dataset.id ? null : btn.dataset.id;
        this._renderLogSection();
      });
    });
    el.querySelectorAll('.orch-log-test').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = this._log.find(e => e.id === btn.dataset.id);
        if (!entry) return;
        const route = this._routes.find(r => r.name === entry.routeName);
        if (route) this._openRouteDialog(route, entry);
      });
    });
  }

  _logRow(e) {
    const t = new Date(e.at);
    const timeStr = `${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}:${t.getSeconds().toString().padStart(2,'0')}`;
    const ruleClass = e.ruleId === 'default' ? 'orch-badge-default' : 'orch-badge-rule';
    let ruleLabel = e.ruleId;
    if (e.ruleId !== 'default') {
      const route = this._routes.find(r => r.name === e.routeName);
      if (route) {
        const idx = route.rules.findIndex(r => r.id === e.ruleId);
        ruleLabel = idx >= 0 ? `Rule ${idx + 1}` : e.ruleId.slice(-6);
      } else {
        ruleLabel = e.ruleId.slice(-6);
      }
    }
    const backendType = e.backend?.type || 'unknown';
    const backendLabel = backendType === 'local' ? e.backend.model
      : backendType === 'frontier' ? (this._frontierBackends.find(b => b.id === e.backend?.backendId)?.name || e.backend?.backendId)
      : backendType;
    const isExpanded = this._expandedLogId === e.id;
    const snap = e.requestSnapshot;

    let expandedHtml = '';
    if (isExpanded && snap) {
      const tools = snap.tools || [];
      const messages = snap.messages || [];

      const toolsHtml = tools.length
        ? tools.map(t => `<span class="orch-snap-tool">${this._esc(t.function?.name || '?')}</span>`).join('')
        : '<span class="orch-snap-none">none</span>';

      // Show newest message first so each entry's unique turn is immediately visible
      const msgsHtml = [...messages].reverse().map((m, i) => {
        const turnLabel = i === 0 ? '<span class="orch-snap-turn-latest">latest</span>' : '';
        const contentHtml = m.content
          ? `<span class="orch-snap-content">${this._esc(m.content)}</span>`
          : '';
        const toolCallsHtml = m.toolCalls?.length
          ? `<span class="orch-snap-toolcalls">called: ${m.toolCalls.map(tc =>
              `<span class="orch-snap-tool">${this._esc(tc.name)}</span>${tc.args ? `<span class="orch-snap-args">(${this._esc(tc.args.slice(0, 60))}${tc.args.length > 60 ? '…' : ''})</span>` : ''}`
            ).join(' ')}</span>`
          : '';
        return `
          <div class="orch-snap-msg">
            <span class="orch-snap-role orch-snap-role-${m.role}">${m.role}</span>
            ${turnLabel}
            <span class="orch-snap-msg-body">${contentHtml}${toolCallsHtml}</span>
          </div>
        `;
      }).join('');

      expandedHtml = `
        <div class="orch-log-expanded">
          <div class="orch-snap-section">
            <span class="orch-snap-label">Tools</span>
            <div class="orch-snap-tools">${toolsHtml}</div>
          </div>
          <div class="orch-snap-section">
            <span class="orch-snap-label">Messages (last ${messages.length})</span>
            <div class="orch-snap-msgs">${msgsHtml || '<span class="orch-snap-none">none</span>'}</div>
          </div>
          ${snap.tool_choice != null ? `<div class="orch-snap-section"><span class="orch-snap-label">tool_choice</span> <code>${this._esc(JSON.stringify(snap.tool_choice))}</code></div>` : ''}
        </div>
      `;
    }

    return `
      <div class="orch-log-row ${isExpanded ? 'orch-log-row-open' : ''}">
        <div class="orch-log-row-main">
          <button class="orch-log-row-toggle" data-id="${e.id}" type="button" title="Expand request details">${isExpanded ? '▾' : '▸'}</button>
          <span class="orch-log-time">${timeStr}</span>
          <span><code>${this._esc(e.routeName)}</code></span>
          <span><span class="orch-badge ${ruleClass}" title="${this._esc(e.ruleId)}">${this._esc(ruleLabel)}</span></span>
          <span><span class="orch-badge orch-badge-${backendType}" title="${this._esc(backendLabel)}">${this._esc(backendLabel)}</span></span>
          <span>${e.latencyMs}ms</span>
          <span class="orch-log-meta">
            ${e.toolsPresent ? `<span class="orch-chip">🔧 ${e.toolCount}</span>` : ''}
            <span class="orch-chip">💬 ${e.messageCount}</span>
            <span class="orch-chip">~${e.estimatedTokens}t</span>
          </span>
          <span><button class="btn-tiny orch-log-test" data-id="${e.id}" type="button">Test rules →</button></span>
        </div>
        ${expandedHtml}
      </div>
    `;
  }

  // ── Simulate Dialog ───────────────────────────────────────────────────────

  // ── Rule Tester (client-side, lives inside the route dialog) ─────────────

  _clientEvalCondition(cond, snap) {
    const tools = snap?.tools || [];
    const messages = snap?.messages || [];
    const toolChoice = snap?.tool_choice;
    const val = (cond.value || '').toLowerCase();
    switch (cond.type) {
      case 'toolsPresent':
        return tools.length > 0 || toolChoice != null;
      case 'toolNameContains':
        return tools.some(t => (t?.function?.name || '').toLowerCase().includes(val));
      case 'toolCalledContains': {
        // Only the most recent assistant message — mirrors server-side logic.
        // Fires mid-loop; resets when model gives a final answer.
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') {
            return Array.isArray(messages[i].toolCalls) &&
              messages[i].toolCalls.some(tc => (tc.name || '').toLowerCase().includes(val));
          }
        }
        return false;
      }
      case 'systemPromptContains': {
        const sys = messages.find(m => m.role === 'system');
        return typeof sys?.content === 'string' && sys.content.toLowerCase().includes(val);
      }
      case 'messageContains':
        return messages.some(m => typeof m.content === 'string' && m.content.toLowerCase().includes(val));
      case 'estimatedTokens': {
        const est = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0) / 4;
        return cond.op === 'lt' ? est < Number(cond.value) : est > Number(cond.value);
      }
      case 'multiTurnDepth':
        return cond.op === 'lt' ? messages.length < Number(cond.value) : messages.length > Number(cond.value);
      default:
        return false;
    }
  }

  _clientMatchRules(rules, snap) {
    const trace = [];
    let matched = null;
    for (const rule of rules) {
      const condResults = (rule.conditions || []).map(c => ({
        ...c,
        result: this._clientEvalCondition(c, snap)
      }));
      const ruleMatched = condResults.length > 0 && condResults.every(c => c.result);
      trace.push({ ruleId: rule.id, conditions: condResults, matched: ruleMatched });
      if (ruleMatched && !matched) matched = { backend: rule.backend, ruleId: rule.id };
    }
    return { matched, trace };
  }

  _renderTestEntries() {
    const el = this.querySelector('#orchTestEntries');
    if (!el) return;
    if (this._log.length === 0) {
      el.innerHTML = '<p class="orch-empty" style="font-size:12px">No requests logged yet. Send a request through this route to test rules against real traffic.</p>';
      return;
    }
    el.innerHTML = this._log.slice(0, 30).map(e => {
      const t = new Date(e.at);
      const time = `${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}:${t.getSeconds().toString().padStart(2,'0')}`;
      const isSelected = this._testEntry?.id === e.id;
      const snap = e.requestSnapshot;
      const toolNames = snap?.tools?.map(t => t.function?.name).filter(Boolean) || [];
      return `
        <button class="orch-test-entry ${isSelected ? 'orch-test-entry-selected' : ''}" data-entry-id="${e.id}" type="button">
          <span class="orch-test-entry-time">${time}</span>
          <span class="orch-test-entry-route">${this._esc(e.routeName)}</span>
          <span class="orch-test-entry-chips">
            ${snap?.tools?.length ? `<span class="orch-chip">🔧 ${toolNames.slice(0,3).map(n=>this._esc(n)).join(', ')}${toolNames.length > 3 ? '…' : ''}</span>` : ''}
            <span class="orch-chip">💬 ${snap?.messages?.length ?? e.messageCount}msg</span>
            <span class="orch-chip">~${e.estimatedTokens}t</span>
          </span>
        </button>
      `;
    }).join('');
    el.querySelectorAll('.orch-test-entry').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = this._log.find(e => e.id === btn.dataset.entryId);
        this._testEntry = this._testEntry?.id === entry?.id ? null : entry;
        this._renderTestEntries();
        this._renderTestResult();
      });
    });
    this._renderTestResult();
  }

  _renderTestResult() {
    const el = this.querySelector('#orchTestResult');
    if (!el) return;
    if (!this._testEntry?.requestSnapshot) { el.hidden = true; return; }
    el.hidden = false;

    const snap = this._testEntry.requestSnapshot;
    const { matched, trace } = this._clientMatchRules(this._rules, snap);
    const defaultBackend = this._parseBackendSelect(this.querySelector('#orchDefaultBackend select')?.value);
    const resolvedBackend = matched?.backend || defaultBackend;
    const ruleId = matched?.ruleId || 'default';

    const traceRows = trace.map(t => {
      const rule = this._rules.find(r => r.id === t.ruleId);
      return `
        <div class="orch-sim-rule ${t.matched ? 'orch-sim-matched' : 'orch-sim-miss'}">
          <span class="orch-sim-icon">${t.matched ? '✓' : '✗'}</span>
          <span class="orch-sim-conditions">
            ${t.conditions.map(c =>
              `<span class="orch-chip ${c.result ? 'orch-chip-pass' : 'orch-chip-fail'}">${this._esc(c.type)}${c.op ? ' '+c.op : ''}${c.value ? ' '+c.value : ''}: ${c.result ? 'yes' : 'no'}</span>`
            ).join(' ')}
          </span>
          <span class="orch-sim-arrow">→ <b>${this._esc(this._backendLabel(rule?.backend))}</b></span>
        </div>
      `;
    }).join('');

    const originalBackend = this._testEntry.backend;
    const changed = originalBackend?.type !== resolvedBackend?.type ||
      originalBackend?.model !== resolvedBackend?.model ||
      originalBackend?.backendId !== resolvedBackend?.backendId;

    el.innerHTML = `
      <div class="orch-sim-trace">${traceRows || '<p class="orch-empty" style="font-size:12px">No rules — all requests use default backend.</p>'}</div>
      <div class="orch-sim-verdict ${changed ? 'orch-sim-changed' : 'orch-sim-same'}">
        ${changed
          ? `⚠ Would now route to <b>${this._esc(this._backendLabel(resolvedBackend))}</b> — was <b>${this._esc(this._backendLabel(originalBackend))}</b> when logged`
          : `✓ Routes to <b>${this._esc(this._backendLabel(resolvedBackend))}</b> via <b>${ruleId}</b>`
        }
      </div>
    `;
  }

  _backendLabel(backend) {
    if (!backend) return 'none';
    if (backend.type === 'local') return `local:${this._esc(backend.model)}`;
    if (backend.type === 'config') {
      const cfg = this._instanceConfigs.find(c => c.id === backend.configId);
      return `config:${this._esc(cfg?.name || backend.configName || backend.configId)}`;
    }
    const fb = this._frontierBackends.find(b => b.id === backend.backendId);
    return `frontier:${this._esc(fb?.name || backend.backendId)}`;
  }

  // ── Route Dialog ─────────────────────────────────────────────────────────

  _routeDialogTemplate() {
    return `
      <dialog class="orch-dialog" id="orchRouteDialog">
        <form class="orch-dialog-form" method="dialog">
          <h3 class="orch-dialog-title">Orchestration Route</h3>
          <label class="orch-label">Name <span class="orch-hint">(this is the model name clients will use)</span>
            <input class="orch-input" id="orchRouteName" type="text" placeholder="e.g. opencode" autocomplete="off" required />
          </label>
          <label class="orch-label">Description <span class="orch-hint">(optional)</span>
            <input class="orch-input" id="orchRouteDesc" type="text" placeholder="Short description" autocomplete="off" />
          </label>

          <div class="orch-rules-section">
            <div class="orch-rules-header">
              <span class="orch-label-text">Rules <span class="orch-hint">(evaluated top-down; first match wins)</span></span>
              <button class="btn-small" type="button" id="orchAddRule">+ Add Rule</button>
            </div>
            <div id="orchRulesList" class="orch-rules-list"></div>
          </div>

          <div class="orch-backend-row">
            <label class="orch-label orch-label-grow">Default backend <span class="orch-hint">(used when no rule matches)</span>
              <div class="orch-backend-picker" id="orchDefaultBackend"></div>
            </label>
            <label class="orch-label orch-label-grow">Fallback backend <span class="orch-hint">(if primary errors)</span>
              <div class="orch-backend-picker" id="orchFallbackBackend"></div>
            </label>
          </div>

          <p class="orch-shadow-warning" id="orchShadowWarning" hidden>
            ⚠ A broad <code>toolsPresent</code> rule appears before a <code>toolNameContains</code> rule — the specific rule will never fire.
          </p>

          <div class="orch-test-panel">
            <div class="orch-test-header">
              <span class="orch-label-text">Test rules against real requests</span>
              <span class="orch-hint">Select a logged request below — results update as you edit rules above.</span>
            </div>
            <div id="orchTestEntries" class="orch-test-entries"></div>
            <div id="orchTestResult" class="orch-test-result" hidden></div>
          </div>

          <div class="orch-dialog-actions">
            <button class="btn-small btn-danger" type="button" id="orchRouteCancel">Cancel</button>
            <button class="btn-primary" type="button" id="orchRouteSave">Save Route</button>
          </div>
          <p class="orch-dialog-error" id="orchRouteError"></p>
        </form>
      </dialog>
    `;
  }

  _openRouteDialog(route, preloadEntry = null) {
    this._editingRoute = route || null;
    this._testEntry = preloadEntry;
    const dialog = this.querySelector('#orchRouteDialog');
    this.querySelector('#orchRouteName').value = route?.name || '';
    this.querySelector('#orchRouteDesc').value = route?.description || '';
    this._rules = route?.rules ? JSON.parse(JSON.stringify(route.rules)) : [];
    this._renderRulesList();
    this._renderBackendPicker('orchDefaultBackend', route?.defaultBackend || null);
    this._renderBackendPicker('orchFallbackBackend', route?.fallbackBackend || null, true);
    this.querySelector('#orchRouteError').textContent = '';
    this._checkShadowWarning();
    this._renderTestEntries();
    dialog.showModal();
  }

  _renderRulesList() {
    const list = this.querySelector('#orchRulesList');
    if (!list) return;
    if (this._rules.length === 0) {
      list.innerHTML = '<p class="orch-empty-rules">No rules — all requests use the default backend.</p>';
      return;
    }
    list.innerHTML = this._rules.map((rule, i) => this._ruleRow(rule, i)).join('');
    list.querySelectorAll('.orch-rule-up').forEach(btn => {
      btn.onclick = () => { const i = +btn.dataset.i; if (i > 0) { [this._rules[i-1], this._rules[i]] = [this._rules[i], this._rules[i-1]]; this._renderRulesList(); this._checkShadowWarning(); } };
    });
    list.querySelectorAll('.orch-rule-down').forEach(btn => {
      btn.onclick = () => { const i = +btn.dataset.i; if (i < this._rules.length - 1) { [this._rules[i], this._rules[i+1]] = [this._rules[i+1], this._rules[i]]; this._renderRulesList(); this._checkShadowWarning(); } };
    });
    list.querySelectorAll('.orch-rule-delete').forEach(btn => {
      btn.onclick = () => { this._rules.splice(+btn.dataset.i, 1); this._renderRulesList(); this._checkShadowWarning(); };
    });
    list.querySelectorAll('.orch-rule-cond-type').forEach(sel => {
      sel.onchange = () => { const i = +sel.dataset.i; this._rules[i].conditions[0].type = sel.value; this._renderRulesList(); this._checkShadowWarning(); };
    });
    list.querySelectorAll('.orch-rule-cond-op').forEach(sel => {
      sel.onchange = () => { const i = +sel.dataset.i; this._rules[i].conditions[0].op = sel.value; this._renderTestResult(); };
    });
    list.querySelectorAll('.orch-rule-cond-value').forEach(inp => {
      inp.oninput = () => { const i = +inp.dataset.i; this._rules[i].conditions[0].value = inp.value; this._renderTestResult(); };
    });
    list.querySelectorAll('.orch-rule-backend-picker').forEach(div => {
      const i = +div.dataset.i;
      this._renderBackendPicker(null, this._rules[i].backend, false, div, (b) => { this._rules[i].backend = b; });
    });
  }

  _ruleRow(rule, i) {
    const cond = rule.conditions?.[0] || { type: 'toolsPresent' };
    const condDef = CONDITION_TYPES.find(c => c.value === cond.type) || CONDITION_TYPES[0];
    return `
      <div class="orch-rule-row">
        <div class="orch-rule-order">
          <button class="btn-tiny orch-rule-up" data-i="${i}" type="button" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn-tiny orch-rule-down" data-i="${i}" type="button" ${i === this._rules.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
        <div class="orch-rule-cond">
          <select class="orch-select orch-rule-cond-type" data-i="${i}">
            ${CONDITION_TYPES.map(c => `<option value="${c.value}" ${c.value === cond.type ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select>
          ${condDef.hasOp ? `
            <select class="orch-select orch-rule-cond-op" data-i="${i}">
              <option value="gt" ${(cond.op || 'gt') === 'gt' ? 'selected' : ''}>&gt;</option>
              <option value="lt" ${cond.op === 'lt' ? 'selected' : ''}>&lt;</option>
            </select>` : ''}
          ${condDef.hasValue ? `
            <input class="orch-input orch-rule-cond-value" data-i="${i}" type="text"
              value="${this._esc(cond.value || '')}" placeholder="${condDef.placeholder || ''}" />` : ''}
        </div>
        <span class="orch-rule-arrow">→</span>
        <div class="orch-rule-backend-picker" data-i="${i}"></div>
        <button class="btn-tiny btn-danger orch-rule-delete" data-i="${i}" type="button">✕</button>
      </div>
    `;
  }

  _renderBackendPicker(id, currentBackend, allowNull = false, containerEl = null, onChange = null) {
    const el = containerEl || this.querySelector(`#${id}`);
    if (!el) return;
    const nullOption = allowNull ? '<option value="">None</option>' : '';

    // Compute stem for each instance (strip path + extension, same logic as routing.js)
    const stemOf = (effectiveModel) => {
      if (!effectiveModel) return null;
      const base = effectiveModel.replace(/\\/g, '/').split('/').pop();
      return base.replace(/\.(gguf|bin|safetensors|pt|pth|ggml)$/i, '');
    };

    // Pools — stems shared by 2+ running instances
    const stemGroups = new Map();
    for (const inst of this._runningInstances) {
      const stem = stemOf(inst.effectiveModel);
      if (!stem) continue;
      if (!stemGroups.has(stem)) stemGroups.set(stem, []);
      stemGroups.get(stem).push(inst);
    }
    const poolOptions = [...stemGroups.entries()]
      .filter(([, insts]) => insts.length >= 2)
      .map(([stem, insts]) => {
        const isSelected = currentBackend?.type === 'local' && currentBackend?.model === stem;
        return `<option value="local::${this._esc(stem)}" ${isSelected ? 'selected' : ''}>⇄ ${this._esc(stem)} (${insts.length} inst · least-loaded)</option>`;
      }).join('');

    // Running instances — deduplicated by route name, show profile + GPU + state
    const seenRoutes = new Set();
    const runningOptions = this._runningInstances.map(inst => {
      const routeName = inst.modelRouteName || inst.effectiveModel || inst.id;
      if (seenRoutes.has(routeName)) return '';
      seenRoutes.add(routeName);
      const gpuLabel = Array.isArray(inst.gpus) && inst.gpus.length > 0 ? `GPU ${inst.gpus.join(',')}` : 'CPU';
      const isSelected = currentBackend?.type === 'local' && currentBackend?.model === routeName;
      const stateStr = inst.state === 'ready' ? '● ' : '◌ ';
      return `<option value="local::${this._esc(routeName)}" ${isSelected ? 'selected' : ''}>${stateStr}${this._esc(inst.profileName || routeName)} — ${gpuLabel}</option>`;
    }).filter(Boolean).join('');

    // Saved instance configs
    const configOptions = this._instanceConfigs.map(cfg => {
      const isSelected = currentBackend?.type === 'config' && currentBackend?.configId === cfg.id;
      return `<option value="config::${this._esc(cfg.id)}" ${isSelected ? 'selected' : ''}>${this._esc(cfg.name)} (${cfg.instanceCount} inst)</option>`;
    }).join('');

    // Frontier backends
    const frontierOptions = this._frontierBackends.map(b =>
      `<option value="frontier::${b.id}" ${currentBackend?.type === 'frontier' && currentBackend?.backendId === b.id ? 'selected' : ''}>${this._esc(b.name)}</option>`
    ).join('');

    el.innerHTML = `
      <select class="orch-select orch-backend-select">
        ${nullOption}
        ${poolOptions ? `<optgroup label="Pools">${poolOptions}</optgroup>` : ''}
        ${runningOptions
          ? `<optgroup label="Running Instances">${runningOptions}</optgroup>`
          : `<option disabled>(no instances running)</option>`}
        ${configOptions ? `<optgroup label="Saved Configs">${configOptions}</optgroup>` : ''}
        ${frontierOptions ? `<optgroup label="Frontier">${frontierOptions}</optgroup>` : ''}
      </select>
    `;
    const sel = el.querySelector('select');
    // Set initial value
    if (currentBackend?.type === 'local') sel.value = `local::${currentBackend.model}`;
    else if (currentBackend?.type === 'config') sel.value = `config::${currentBackend.configId}`;
    else if (currentBackend?.type === 'frontier') sel.value = `frontier::${currentBackend.backendId}`;
    else sel.value = '';

    if (onChange) {
      sel.onchange = () => onChange(this._parseBackendSelect(sel.value));
    }
  }

  _parseBackendSelect(value) {
    if (!value) return null;
    const [type, ...rest] = value.split('::');
    const id = rest.join('::');
    if (type === 'local') return { type: 'local', model: id };
    if (type === 'config') {
      const cfg = this._instanceConfigs.find(c => c.id === id);
      return { type: 'config', configId: id, configName: cfg?.name || id };
    }
    if (type === 'frontier') return { type: 'frontier', backendId: id };
    return null;
  }

  _checkShadowWarning() {
    const warning = this.querySelector('#orchShadowWarning');
    if (!warning) return;
    let foundToolsPresent = false;
    let shadowed = false;
    for (const rule of this._rules) {
      const type = rule.conditions?.[0]?.type;
      if (type === 'toolsPresent') foundToolsPresent = true;
      else if (type === 'toolNameContains' && foundToolsPresent) { shadowed = true; break; }
    }
    warning.hidden = !shadowed;
  }

  _bindDialogEvents() {
    const routeDialog = this.querySelector('#orchRouteDialog');
    if (!routeDialog) return;

    this.querySelector('#orchAddRule').onclick = () => {
      this._rules.push({ id: `rule_${Date.now()}`, conditions: [{ type: 'toolsPresent' }], backend: null });
      this._renderRulesList();
    };

    this.querySelector('#orchRouteCancel').onclick = () => routeDialog.close();

    this.querySelector('#orchRouteSave').onclick = async () => {
      const name = this.querySelector('#orchRouteName').value.trim();
      const desc = this.querySelector('#orchRouteDesc').value.trim();
      const defaultVal = this._parseBackendSelect(this.querySelector('#orchDefaultBackend select')?.value);
      const fallbackVal = this._parseBackendSelect(this.querySelector('#orchFallbackBackend select')?.value);
      const errEl = this.querySelector('#orchRouteError');

      if (!name) { errEl.textContent = 'Name is required.'; return; }
      if (!defaultVal) { errEl.textContent = 'Default backend is required.'; return; }

      // Validate all rules have backends set
      for (let i = 0; i < this._rules.length; i++) {
        if (!this._rules[i].backend) { errEl.textContent = `Rule ${i + 1} has no backend set.`; return; }
      }

      errEl.textContent = '';
      try {
        const payload = {
          id: this._editingRoute?.id,
          name, description: desc,
          rules: this._rules,
          defaultBackend: defaultVal,
          fallbackBackend: fallbackVal || null
        };
        const method = this._editingRoute ? 'PUT' : 'POST';
        const path = this._editingRoute
          ? `/api/orchestration-routes/${this._editingRoute.id}`
          : '/api/orchestration-routes';
        await api(path, { method, body: JSON.stringify(payload) });
        routeDialog.close();
        await this._load();
      } catch (e) {
        errEl.textContent = e.message;
      }
    };

    const backendDialog = this.querySelector('#orchBackendDialog');
    this.querySelector('#orchBackendCancel').onclick = () => backendDialog.close();
    this.querySelector('#orchBackendSave').onclick = () => this._saveBackend();
  }

  async _deleteRoute(id) {
    if (!confirm('Delete this orchestration route?')) return;
    try {
      await api(`/api/orchestration-routes/${id}`, { method: 'DELETE' });
      await this._load();
    } catch (e) {
      this.querySelector('.orch-error').textContent = e.message;
    }
  }

  // ── Frontier Backend Dialog ───────────────────────────────────────────────

  _backendDialogTemplate() {
    return `
      <dialog class="orch-dialog" id="orchBackendDialog">
        <form class="orch-dialog-form" method="dialog">
          <h3 class="orch-dialog-title">Frontier Backend</h3>
          <label class="orch-label">Name <input class="orch-input" id="orchBackendName" type="text" placeholder="e.g. OpenRouter Kimi2" required /></label>
          <label class="orch-label">Base URL <input class="orch-input" id="orchBackendBaseUrl" type="text" placeholder="https://openrouter.ai/api/v1" required /></label>
          <label class="orch-label">Model <input class="orch-input" id="orchBackendModel" type="text" placeholder="moonshotai/moonlight-16a-a3b-instruct:free" required /></label>
          <label class="orch-label">API Key <input class="orch-input" id="orchBackendApiKey" type="password" placeholder="Leave blank to keep existing" autocomplete="off" /></label>
          <p class="orch-field-hint">Enter the key directly, or use <code>$ENV_VAR_NAME</code> to read from a server environment variable (keeps the key off disk).</p>
          <div class="orch-backend-cost-row">
            <label class="orch-label orch-label-half">$/1k input tokens <input class="orch-input" id="orchBackendCostIn" type="number" step="0.0001" min="0" placeholder="0.0014" /></label>
            <label class="orch-label orch-label-half">$/1k output tokens <input class="orch-input" id="orchBackendCostOut" type="number" step="0.0001" min="0" placeholder="0.0014" /></label>
          </div>
          <label class="orch-label">Extra headers <span class="orch-hint">(JSON, e.g. {"HTTP-Referer":"https://myapp"})</span>
            <textarea class="orch-textarea" id="orchBackendHeaders" rows="2" placeholder='{"HTTP-Referer": "https://myapp", "X-Title": "MyApp"}'></textarea>
          </label>
          <label class="orch-label">Request defaults <span class="orch-hint">(JSON, merged into outgoing body; caller values win)</span>
            <textarea class="orch-textarea" id="orchBackendDefaults" rows="2" placeholder='{"temperature": 0.7, "max_tokens": 4096}'></textarea>
          </label>
          <div class="orch-dialog-actions">
            <button class="btn-small btn-danger" type="button" id="orchBackendCancel">Cancel</button>
            <button class="btn-primary" type="button" id="orchBackendSave">Save Backend</button>
          </div>
          <p class="orch-dialog-error" id="orchBackendError"></p>
        </form>
      </dialog>
    `;
  }

  _openBackendDialog(backend) {
    this._editingBackend = backend || null;
    const dialog = this.querySelector('#orchBackendDialog');
    this.querySelector('#orchBackendName').value = backend?.name || '';
    this.querySelector('#orchBackendBaseUrl').value = backend?.baseUrl || '';
    this.querySelector('#orchBackendModel').value = backend?.model || '';
    this.querySelector('#orchBackendApiKey').value = '';
    this.querySelector('#orchBackendCostIn').value = backend?.costPer1kInputTokens ?? '';
    this.querySelector('#orchBackendCostOut').value = backend?.costPer1kOutputTokens ?? '';
    this.querySelector('#orchBackendHeaders').value = backend?.extraHeaders ? JSON.stringify(backend.extraHeaders, null, 2) : '';
    this.querySelector('#orchBackendDefaults').value = backend?.requestDefaults ? JSON.stringify(backend.requestDefaults, null, 2) : '';
    this.querySelector('#orchBackendError').textContent = '';
    dialog.showModal();
  }

  async _saveBackend() {
    const errEl = this.querySelector('#orchBackendError');
    const name = this.querySelector('#orchBackendName').value.trim();
    const baseUrl = this.querySelector('#orchBackendBaseUrl').value.trim();
    const model = this.querySelector('#orchBackendModel').value.trim();
    const apiKey = this.querySelector('#orchBackendApiKey').value;
    const costIn = this.querySelector('#orchBackendCostIn').value;
    const costOut = this.querySelector('#orchBackendCostOut').value;
    const headersRaw = this.querySelector('#orchBackendHeaders').value.trim();
    const defaultsRaw = this.querySelector('#orchBackendDefaults').value.trim();

    if (!name) { errEl.textContent = 'Name is required.'; return; }
    if (!baseUrl) { errEl.textContent = 'Base URL is required.'; return; }
    if (!model) { errEl.textContent = 'Model is required.'; return; }

    let extraHeaders = null, requestDefaults = null;
    if (headersRaw) {
      try { extraHeaders = JSON.parse(headersRaw); } catch { errEl.textContent = 'Extra headers must be valid JSON.'; return; }
    }
    if (defaultsRaw) {
      try { requestDefaults = JSON.parse(defaultsRaw); } catch { errEl.textContent = 'Request defaults must be valid JSON.'; return; }
    }

    errEl.textContent = '';
    try {
      const payload = {
        id: this._editingBackend?.id,
        name, baseUrl, model,
        ...(apiKey ? { apiKey } : {}),
        costPer1kInputTokens: costIn !== '' ? Number(costIn) : null,
        costPer1kOutputTokens: costOut !== '' ? Number(costOut) : null,
        extraHeaders,
        requestDefaults
      };
      const method = this._editingBackend ? 'PUT' : 'POST';
      const path = this._editingBackend
        ? `/api/frontier-backends/${this._editingBackend.id}`
        : '/api/frontier-backends';
      await api(path, { method, body: JSON.stringify(payload) });
      this.querySelector('#orchBackendDialog').close();
      await this._load();
    } catch (e) {
      errEl.textContent = e.message;
    }
  }

  async _deleteBackend(id) {
    if (!confirm('Delete this frontier backend? Any routes using it will need to be updated.')) return;
    try {
      await api(`/api/frontier-backends/${id}`, { method: 'DELETE' });
      await this._load();
    } catch (e) {
      this.querySelector('.orch-error').textContent = e.message;
    }
  }

  _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

customElements.define('lf-orchestration-panel', LfOrchestrationPanel);
