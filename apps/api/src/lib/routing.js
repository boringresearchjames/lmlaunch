import path from "path";
import { state } from "./state.js";

/**
 * Returns a short canonical name for a model path used as the routing key.
 * Strips directory prefix and common file extensions.
 */
export function resolveModelName(effectiveModel) {
  if (!effectiveModel) return null;
  const base = path.basename(effectiveModel);
  return base.replace(/\.(gguf|bin|safetensors|pt|pth|ggml)$/i, "");
}

const modelRoundRobinCounters = new Map();

/**
 * Resolves a model name from an OpenAI-compatible request to a single running instance.
 * Returns { instance } on success or { error, status } on failure.
 */
export function resolveInstanceByModelName(modelName) {
  if (!modelName) return { error: "model field is required", status: 400 };

  const running = state.instances.filter((x) => x.state !== "stopped" && !x.drain);
  const strippedMinus1 = modelName.endsWith("-1") ? modelName.slice(0, -2) : null;

  const matches = running.filter((inst) => {
    if (!inst.effectiveModel) return false;
    const stem = resolveModelName(inst.effectiveModel);
    const routeName = inst.modelRouteName || stem;
    return (
      routeName === modelName ||
      inst.effectiveModel === modelName ||
      path.basename(inst.effectiveModel) === modelName ||
      stem === modelName ||
      inst.profileName === modelName ||
      (strippedMinus1 !== null && routeName === strippedMinus1)
    );
  });

  if (matches.length === 0) {
    console.log(`[route] model="${modelName}" -> no match (running=${running.map(i => i.modelRouteName || i.profileName).join(",")})`);
    return { error: `No running instance found for model '${modelName}'`, status: 404 };
  }
  if (matches.length === 1) {
    console.log(`[route] model="${modelName}" -> ${matches[0].id.slice(0, 8)} port=${matches[0].port} routeName=${matches[0].modelRouteName}`);
    return { instance: matches[0] };
  }

  // Least-loaded routing: pick the candidate with the lowest in-flight count,
  // measured as a fraction of its own maxInflightRequests so heterogeneous
  // pools (e.g. fast CUDA + slow CPU) don't starve the small instance. Ties
  // are broken with a round-robin counter to keep load distribution fair when
  // every instance is idle.
  const scored = matches.map((inst) => {
    const inflight = Math.max(0, Number(inst.inflightRequests || 0));
    const cap = Math.max(1, Number(inst.maxInflightRequests || 1));
    return { inst, inflight, load: inflight / cap };
  });
  let minLoad = Infinity;
  for (const s of scored) if (s.load < minLoad) minLoad = s.load;
  const leastLoaded = scored.filter((s) => s.load === minLoad);

  let chosen;
  if (leastLoaded.length === 1) {
    chosen = leastLoaded[0].inst;
  } else {
    const counter = (modelRoundRobinCounters.get(modelName) || 0) % leastLoaded.length;
    modelRoundRobinCounters.set(modelName, counter + 1);
    chosen = leastLoaded[counter].inst;
  }
  console.log(`[route] model="${modelName}" -> ${chosen.id.slice(0, 8)} port=${chosen.port} routeName=${chosen.modelRouteName} (least-loaded ${chosen.inflightRequests || 0}/${chosen.maxInflightRequests || 1} of ${matches.length} matches)`);
  return { instance: chosen };
}

/**
 * Assigns a unique modelRouteName for a new/restarted instance.
 * Appends -2, -3, etc. if the base stem is already taken.
 */
export function uniqueModelRouteName(baseStem, excludeInstanceId, instances) {
  const usedNames = new Set(
    instances
      .filter((x) => x.id !== excludeInstanceId)
      .map((x) => x.modelRouteName || resolveModelName(x.effectiveModel) || x.effectiveModel)
      .filter(Boolean)
  );
  if (!usedNames.has(baseStem)) return baseStem;
  let n = 2;
  while (usedNames.has(`${baseStem}-${n}`)) n++;
  return `${baseStem}-${n}`;
}
