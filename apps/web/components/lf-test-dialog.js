/**
 * lf-test-dialog.js — plain ES module (not a custom element).
 * Mini streaming chat dialog against a running instance.
 */
import { settings } from '../api.js';
import { store } from '../store.js';

let instanceTestTargetId = null;
let chatHistory = []; // { role: 'user' | 'assistant', content: string }[]
let isSending = false;

const $ = (id) => document.getElementById(id);

// ── Markdown renderer ────────────────────────────────────────────────────────

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInline(s) {
  s = escHtml(s);
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  return s;
}

function renderMarkdown(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();

    // Fenced code block
    if (/^```/.test(line)) {
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
      i++;
      out.push(`<pre class="md-pre"><code>${escHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // Table: header row followed by a separator (dashes/pipes/colons)
    if (line.includes('|') && i + 1 < lines.length && /^[\s|:\-]+$/.test(lines[i + 1])) {
      const parseRow = (r) => {
        const parts = r.split('|').map(c => c.trim());
        // Strip empty leading/trailing cells produced by surrounding pipes
        if (parts[0] === '') parts.shift();
        if (parts[parts.length - 1] === '') parts.pop();
        return parts;
      };
      const headers = parseRow(line);
      i += 2;
      let tbl = '<table class="md-table"><thead><tr>';
      headers.forEach(h => { tbl += `<th>${renderInline(h)}</th>`; });
      tbl += '</tr></thead><tbody>';
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = parseRow(lines[i]);
        tbl += '<tr>';
        cells.forEach(c => { tbl += `<td>${renderInline(c)}</td>`; });
        tbl += '</tr>';
        i++;
      }
      tbl += '</tbody></table>';
      out.push(tbl);
      continue;
    }

    // Heading
    const hm = line.match(/^(#{1,3}) (.+)/);
    if (hm) {
      const lv = hm[1].length;
      out.push(`<h${lv} class="md-h md-h${lv}">${renderInline(hm[2])}</h${lv}>`);
      i++; continue;
    }

    // Horizontal rule
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      out.push('<hr class="md-hr">');
      i++; continue;
    }

    // Blockquote
    if (/^> /.test(line)) {
      out.push(`<blockquote class="md-blockquote">${renderInline(line.slice(2))}</blockquote>`);
      i++; continue;
    }

    // Unordered list
    if (/^\s*[*\-+] /.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[*\-+] /.test(lines[i])) {
        items.push(renderInline(lines[i].replace(/^\s*[*\-+] /, '')));
        i++;
      }
      out.push(`<ul class="md-list">${items.map(x => `<li>${x}</li>`).join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(renderInline(lines[i].replace(/^\d+\. /, '')));
        i++;
      }
      out.push(`<ol class="md-list">${items.map(x => `<li>${x}</li>`).join('')}</ol>`);
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      if (out.length && out[out.length - 1] !== '<div class="md-gap"></div>') {
        out.push('<div class="md-gap"></div>');
      }
      i++; continue;
    }

    // Plain line
    out.push(`<div class="md-line">${renderInline(line)}</div>`);
    i++;
  }
  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────

function toast(msg) {
  $('toast')?.notify(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function scrollToBottom() {
  const msgs = $('instanceTestMessages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

/**
 * Append a chat bubble. Returns the bubble content element for incremental streaming updates.
 * Pass text=null to show the typing indicator instead of text.
 */
function appendMessage(role, text) {
  const msgs = $('instanceTestMessages');
  if (!msgs) return null;
  const wrap = document.createElement('div');
  wrap.className = `chat-msg chat-msg-${role}`;
  const label = document.createElement('span');
  label.className = 'chat-msg-role';
  label.textContent = role === 'user' ? 'You' : 'Assistant';
  const bubble = document.createElement('div');
  bubble.className = 'chat-msg-bubble';
  if (text === null) {
    bubble.innerHTML = '<span class="chat-typing"><span></span><span></span><span></span></span>';
  } else {
    bubble.textContent = text;
  }
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  msgs.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

export function closeInstanceTestDialog() {
  const dialog = $('instanceTestDialog');
  if (!dialog) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

export function openInstanceTestDialog(instanceId) {
  const dialog = $('instanceTestDialog');
  const meta = $('instanceTestMeta');
  const msgs = $('instanceTestMessages');
  if (!dialog || !meta || !msgs) { toast('Chat dialog unavailable'); return; }

  const inst = (store.get('instances') || []).find((x) => String(x.id) === String(instanceId));
  if (!inst) { toast('Instance not found'); return; }

  instanceTestTargetId = String(instanceId);
  chatHistory = [];
  msgs.innerHTML = '';

  const serverArgs = Array.isArray(inst.runtime?.serverArgs) && inst.runtime.serverArgs.length > 0
    ? inst.runtime.serverArgs.join(' ') : '(none)';
  const ctxLen = inst.contextLength != null ? String(inst.contextLength) : 'auto';
  const gpuList = Array.isArray(inst.gpus) && inst.gpus.length > 0 ? inst.gpus.join(', ') : 'none';
  const backend = inst.runtime?.hardware || 'auto';
  meta.textContent = [
    `id: ${inst.id}  •  model: ${inst.effectiveModel || 'unknown'}  •  port: ${inst.port}`,
    `server args: ${serverArgs}`,
    `context: ${ctxLen}  •  backend: ${backend}  •  gpus: ${gpuList}`
  ].join('\n');

  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', 'open');
  $('instanceTestPrompt')?.focus();
}

export async function sendInstanceDiagnosticPrompt() {
  if (isSending) return;
  const sendBtn = $('instanceTestSend');
  const promptInput = $('instanceTestPrompt');
  const targetId = String(instanceTestTargetId || '').trim();

  if (!targetId) { toast('Select an instance first'); return; }

  const inst = (store.get('instances') || []).find((x) => String(x.id) === targetId);
  if (!inst) { toast('Instance is no longer available'); return; }

  const userContent = String(promptInput?.value || '').trim();
  if (!userContent) return;

  const modelId = String(inst.effectiveModel || inst.pendingModel || '').trim();
  if (!modelId) { toast('Instance model is unknown'); return; }

  promptInput.value = '';
  appendMessage('user', userContent);
  chatHistory.push({ role: 'user', content: userContent });

  const bubble = appendMessage('assistant', null);

  isSending = true;
  if (sendBtn) sendBtn.disabled = true;

  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    ...chatHistory
  ];

  let accumulated = '';
  try {
    const url = `${settings.apiBase}/v1/instances/${encodeURIComponent(targetId)}/proxy/v1/chat/completions`;
    const headers = { 'content-type': 'application/json' };
    if (settings.token) headers.authorization = `Bearer ${settings.token}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelId, messages, temperature: 0.7, stream: true })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || `HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === '[DONE]') break;
        try {
          const chunk = JSON.parse(jsonStr);
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') {
            accumulated += delta;
            if (bubble) bubble.textContent = accumulated;
            scrollToBottom();
          }
        } catch { /* ignore bad JSON */ }
      }
    }

    if (!accumulated) accumulated = '(empty response)';
    if (bubble) bubble.innerHTML = renderMarkdown(accumulated);
    chatHistory.push({ role: 'assistant', content: accumulated });
    scrollToBottom();
  } catch (error) {
    const errMsg = `Error: ${error.message}`;
    if (bubble) bubble.textContent = errMsg;
    chatHistory.push({ role: 'assistant', content: errMsg });
    toast(`Chat failed: ${error.message}`);
  } finally {
    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
    promptInput?.focus();
  }
}

export async function runInstanceSpeedTest() {
  if (isSending) return;
  const sendBtn = $('instanceTestSend');
  const speedBtn = $('instanceTestSpeedTest');
  const targetId = String(instanceTestTargetId || '').trim();

  if (!targetId) { toast('Select an instance first'); return; }

  const inst = (store.get('instances') || []).find((x) => String(x.id) === targetId);
  if (!inst) { toast('Instance not found'); return; }

  const modelId = String(inst.effectiveModel || inst.pendingModel || '').trim();
  if (!modelId) { toast('Instance model is unknown'); return; }

  isSending = true;
  if (sendBtn) sendBtn.disabled = true;
  if (speedBtn) speedBtn.disabled = true;

  const bubble = appendMessage('assistant', 'Running speed test — streaming 300 tokens…');

  const payload = {
    model: modelId,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Write a detailed, thorough explanation of how transformer neural networks work, covering self-attention, positional encoding, feed-forward layers, and training.' }
    ],
    temperature: 0.7,
    max_tokens: 300,
    stream: true,
    stream_options: { include_usage: true }
  };

  const startMs = Date.now();
  let firstTokenMs = null;
  let lastTokenMs = null;
  let chunkCount = 0;
  let fullText = '';
  let usage = null;
  let timings = null;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (settings.token) headers['Authorization'] = `Bearer ${settings.token}`;
    const url = `${settings.apiBase}/v1/instances/${encodeURIComponent(targetId)}/proxy/v1/chat/completions`;

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const chunk = JSON.parse(raw);
          if (chunk.usage) usage = chunk.usage;
          if (chunk.timings) timings = chunk.timings;
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            if (firstTokenMs === null) firstTokenMs = Date.now();
            lastTokenMs = Date.now();
            chunkCount++;
            fullText += delta;
          }
        } catch { /* ignore malformed chunks */ }
      }
    }

    const totalMs = Date.now() - startMs;
    const ttftMs = firstTokenMs !== null ? firstTokenMs - startMs : null;
    const genMs = (firstTokenMs !== null && lastTokenMs !== null) ? (lastTokenMs - firstTokenMs) : totalMs;
    const completionTokens = usage?.completion_tokens ?? chunkCount;
    const promptTokens = usage?.prompt_tokens ?? 'n/a';
    const serverTps = timings?.predicted_per_second;
    const serverPrefillTps = timings?.prompt_per_second;
    const tps = serverTps != null
      ? serverTps.toFixed(1) + ' tok/s (server)'
      : completionTokens > 0 && genMs > 50
        ? (completionTokens / (genMs / 1000)).toFixed(1) + ' tok/s (wall-clock)'
        : 'n/a';
    const modelBasename = modelId.split('/').pop().split('\\').pop();

    const resultText = [
      '=== SPEED TEST RESULTS ===',
      '',
      `  tokens/sec (gen):     ${tps}`,
      `  tokens/sec (prefill): ${serverPrefillTps != null ? serverPrefillTps.toFixed(1) + ' tok/s (server)' : 'n/a'}`,
      `  time to 1st token:    ${ttftMs !== null ? ttftMs + ' ms' : 'n/a'}`,
      `  total latency:        ${totalMs} ms`,
      `  completion tokens:    ${completionTokens}`,
      `  prompt tokens:        ${promptTokens}`,
      `  generation time:      ${timings?.predicted_ms != null ? timings.predicted_ms.toFixed(0) + ' ms (server)' : genMs + ' ms (wall-clock)'}`,
      '',
      `  model: ${modelBasename}`,
      '',
      '--- response preview ---',
      fullText.trim().slice(0, 300) || '(empty)'
    ].join('\n');

    if (bubble) bubble.textContent = resultText;
    scrollToBottom();
    toast(`Speed test done: ${serverTps != null ? serverTps.toFixed(1) + ' tok/s' : tps}`);
  } catch (error) {
    const elapsed = Date.now() - startMs;
    if (bubble) bubble.textContent = `Speed test failed after ${elapsed}ms\n\nerror: ${error.message}`;
    toast(`Speed test failed: ${error.message}`);
  } finally {
    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
    if (speedBtn) speedBtn.disabled = false;
  }
}

export function initTestDialog() {
  if ($('instanceTestSend')) {
    $('instanceTestSend').onclick = () => { void sendInstanceDiagnosticPrompt(); };
  }
  if ($('instanceTestPrompt')) {
    $('instanceTestPrompt').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void sendInstanceDiagnosticPrompt();
      }
    });
  }
  if ($('instanceTestSpeedTest')) {
    $('instanceTestSpeedTest').onclick = () => { void runInstanceSpeedTest(); };
  }
  if ($('instanceTestClear')) {
    $('instanceTestClear').onclick = () => {
      chatHistory = [];
      const msgs = $('instanceTestMessages');
      if (msgs) msgs.innerHTML = '';
      $('instanceTestPrompt')?.focus();
    };
  }
  if ($('instanceTestClose')) {
    $('instanceTestClose').onclick = closeInstanceTestDialog;
  }
  if ($('instanceTestDialog')) {
    $('instanceTestDialog').addEventListener('click', (event) => {
      const dialog = $('instanceTestDialog');
      const rect = dialog.getBoundingClientRect();
      const inside = rect.top <= event.clientY
        && event.clientY <= rect.bottom
        && rect.left <= event.clientX
        && event.clientX <= rect.right;
      if (!inside) closeInstanceTestDialog();
    });
  }
}
