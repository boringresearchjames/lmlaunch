import { state } from "./state.js";

// ---------------------------------------------------------------------------
// Token estimation (chars / 4 heuristic)
// ---------------------------------------------------------------------------

export function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (typeof m?.content === "string") chars += m.content.length;
    else if (Array.isArray(m?.content)) {
      for (const part of m.content) {
        if (typeof part?.text === "string") chars += part.text.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

function evaluateCondition(condition, body) {
  const { type, op, value } = condition;
  switch (type) {
    case "toolsPresent": {
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const hasToolChoice = body.tool_choice !== undefined && body.tool_choice !== null;
      return hasTools || hasToolChoice;
    }
    case "toolNameContains": {
      if (!Array.isArray(body.tools) || !value) return false;
      const needle = String(value).toLowerCase();
      return body.tools.some((t) => String(t?.function?.name || "").toLowerCase().includes(needle));
    }
    case "toolCalledContains": {
      // Only check the MOST RECENT assistant message.
      // This fires while the model is actively in a tool loop, but resets once
      // it gives a final answer (no tool_calls in last assistant msg).
      if (!value || !Array.isArray(body.messages)) return false;
      const needle = String(value).toLowerCase();
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i];
        if (m?.role === "assistant") {
          return Array.isArray(m.tool_calls) &&
            m.tool_calls.some((tc) => String(tc?.function?.name || "").toLowerCase().includes(needle));
        }
      }
      return false;
    }
    case "systemPromptContains": {
      if (!value || !Array.isArray(body.messages)) return false;
      const sys = body.messages.find((m) => m?.role === "system");
      const content = typeof sys?.content === "string" ? sys.content : "";
      return content.toLowerCase().includes(String(value).toLowerCase());
    }
    case "messageContains": {
      if (!value || !Array.isArray(body.messages)) return false;
      const needle = String(value).toLowerCase();
      return body.messages.some((m) => {
        const c = m?.content;
        if (typeof c === "string") return c.toLowerCase().includes(needle);
        if (Array.isArray(c)) return c.some((p) => typeof p?.text === "string" && p.text.toLowerCase().includes(needle));
        return false;
      });
    }
    case "estimatedTokens": {
      const tokens = estimateTokens(body.messages);
      const threshold = Number(value);
      if (!Number.isFinite(threshold)) return false;
      return op === "gt" ? tokens > threshold : tokens < threshold;
    }
    case "multiTurnDepth": {
      const depth = Array.isArray(body.messages) ? body.messages.length : 0;
      const threshold = Number(value);
      if (!Number.isFinite(threshold)) return false;
      return op === "gt" ? depth > threshold : depth < threshold;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate all conditions in a rule (AND logic).
 */
function evaluateRule(rule, body) {
  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) return false;
  return rule.conditions.every((c) => evaluateCondition(c, body));
}

/**
 * Walk rules in order; return the first matching rule's backend, or null.
 */
export function evaluateStaticRules(route, body) {
  if (!Array.isArray(route.rules)) return null;
  for (const rule of route.rules) {
    if (evaluateRule(rule, body)) return { backend: rule.backend, ruleId: rule.id };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classifier rule evaluation
// ---------------------------------------------------------------------------

/**
 * Call a local model to classify intent.
 * Returns the mapped backend or null (never throws).
 */
export async function evaluateClassifier(classifierRule, body) {
  if (!classifierRule?.model || !classifierRule?.mapping) return null;

  const systemPrompt = classifierRule.systemPrompt ||
    "You are a routing classifier. Reply with exactly one word: the task category.";

  // Build a compact representation of the request for classification
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: (Array.isArray(body.messages) ? body.messages : [])
        .map((m) => {
          const content = typeof m?.content === "string" ? m.content :
            Array.isArray(m?.content) ? m.content.map((p) => p?.text || "").join(" ") : "";
          return `[${m?.role}] ${content}`;
        })
        .slice(-4) // last 4 turns only to keep it fast
        .join("\n")
    }
  ];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    // Determine base URL for local model call — use state to find instance
    const modelName = classifierRule.model;
    const instance = (state.instances || []).find(
      (inst) => inst.state === "ready" &&
        (inst.modelRouteName === modelName || inst.effectiveModel === modelName)
    );
    if (!instance) return null;

    const baseUrl = instance.proxyBaseUrl || `http://${instance.host}:${instance.port}`;

    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, messages, max_tokens: 20, temperature: 0 }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) return null;
    const data = await resp.json();
    const label = data?.choices?.[0]?.message?.content?.trim().toLowerCase();
    if (!label) return null;

    // Check mapping (case-insensitive key match)
    const mapping = classifierRule.mapping;
    for (const key of Object.keys(mapping)) {
      if (label.includes(key.toLowerCase())) return { backend: mapping[key], ruleId: "classifier" };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

/**
 * Look up an orchestration route by virtual model name.
 * Returns the route object or null.
 */
export function matchOrchestrationRoute(modelName) {
  if (!modelName || !Array.isArray(state.orchestrationRoutes)) return null;
  return state.orchestrationRoutes.find((r) => r.name === modelName) || null;
}

/**
 * Resolve which backend to use for a given route and request body.
 * Order: static rules → classifier (if configured) → defaultBackend.
 * Always returns a backend object — never throws.
 */
export async function resolveBackend(route, body) {
  // 1. Static rules
  const staticMatch = evaluateStaticRules(route, body);
  if (staticMatch) return staticMatch;

  // 2. Classifier
  if (route.classifierRule) {
    const classifierMatch = await evaluateClassifier(route.classifierRule, body);
    if (classifierMatch) return classifierMatch;
  }

  // 3. Default
  return { backend: route.defaultBackend, ruleId: "default" };
}

// ---------------------------------------------------------------------------
// System prompt injection
// ---------------------------------------------------------------------------

/**
 * Append a configured suffix to the system message of a request body.
 * If no system message exists one is created. Returns a new body object;
 * the original is not mutated.
 */
export function injectSystemPrompt(body, route) {
  const suffix = String(route.systemPromptSuffix || "").trim();
  if (!suffix || !Array.isArray(body.messages)) return body;

  const messages = [...body.messages];
  const sysIdx = messages.findIndex((m) => m?.role === "system");

  if (sysIdx >= 0) {
    const existing = typeof messages[sysIdx].content === "string" ? messages[sysIdx].content : "";
    messages[sysIdx] = { ...messages[sysIdx], content: `${existing}\n\n${suffix}` };
  } else {
    messages.unshift({ role: "system", content: suffix });
  }

  return { ...body, messages };
}

/**
 * Look up a frontier backend by id.
 */
export function getFrontierBackend(backendId) {
  return (state.frontierBackends || []).find((b) => b.id === backendId) || null;
}

// ---------------------------------------------------------------------------
// Routing log — in-memory ring buffer, resets on restart, never persisted
// ---------------------------------------------------------------------------

const LOG_MAX = 200;
const _log = [];

export function appendOrchestrationLog(entry) {
  _log.push(entry);
  if (_log.length > LOG_MAX) _log.shift();
}

export function getOrchestrationLog() {
  return [..._log].reverse(); // newest first
}

// ---------------------------------------------------------------------------
// Simulate — dry-run rule evaluation without dispatching
// ---------------------------------------------------------------------------

export function simulateRoute(routeId, body) {
  const route = (state.orchestrationRoutes || []).find((r) => r.id === routeId);
  if (!route) return null;

  const trace = [];
  let matched = null;

  for (const rule of (route.rules || [])) {
    const condResults = (rule.conditions || []).map((c) => ({
      ...c,
      result: evaluateCondition(c, body)
    }));
    const ruleMatched = condResults.length > 0 && condResults.every((c) => c.result);
    trace.push({ ruleId: rule.id, conditions: condResults, matched: ruleMatched });
    if (ruleMatched && !matched) {
      matched = { backend: rule.backend, ruleId: rule.id };
    }
  }

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const hasToolChoice = body.tool_choice !== undefined && body.tool_choice !== null;

  return {
    routeId: route.id,
    routeName: route.name,
    resolvedBackend: matched ? matched.backend : route.defaultBackend,
    ruleId: matched ? matched.ruleId : "default",
    trace,
    classifierConfigured: Boolean(route.classifierRule),
    estimatedTokens: estimateTokens(body.messages),
    toolsPresent: hasTools || hasToolChoice,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
  };
}
