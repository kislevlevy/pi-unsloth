import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ProviderChatModelConfig,
} from "@earendil-works/pi-coding-agent";

type Config = {
  baseURL: string;
  apiKey: string;
  contextWindow?: number;
  maxTokens?: number;
  timeoutMs?: number;
  modelOverrides?: Record<string, Partial<ProviderChatModelConfig>>;
};

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

export default async function (pi: ExtensionAPI) {
  const configPath =
    process.env.UNSLOTH_CONFIG ?? join(getAgentDir(), "unsloth.json");
  const config: Config = JSON.parse(await readFile(configPath, "utf8"));
  const baseUrl = (process.env.UNSLOTH_BASE_URL ?? config.baseURL).replace(
    /\/+$/,
    "",
  );
  const apiKey = process.env.UNSLOTH_API_KEY ?? config.apiKey;
  const endpoint = new URL(`${baseUrl}/models`);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error(
      "Unsloth: baseURL must be an HTTP(S) URL without embedded credentials.",
    );
  }
  if (!apiKey) throw new Error("Unsloth: configure apiKey or UNSLOTH_API_KEY.");

  let models: ProviderChatModelConfig[] = [];
  let lastFetch = 0;
  let startupError: string | undefined;

  async function discover(
    signal?: AbortSignal,
    force = false,
  ): Promise<ProviderChatModelConfig[]> {
    if (!force && lastFetch && Date.now() - lastFetch < 30_000) return models;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: signal
          ? AbortSignal.any([
              signal,
              AbortSignal.timeout(positive(config.timeoutMs, 5000)),
            ])
          : AbortSignal.timeout(positive(config.timeoutMs, 5000)),
        redirect: "error",
      });
    } catch {
      if (signal?.aborted) throw new Error("Unsloth: discovery cancelled.");
      throw new Error(
        "Unsloth: model discovery failed. Check server availability, LAN access, and baseURL.",
      );
    }
    if (!response.ok)
      throw new Error(`Unsloth: /models returned HTTP ${response.status}.`);
    let payload: { data?: unknown };
    try {
      payload = await response.json();
    } catch {
      throw new Error("Unsloth: /models returned invalid JSON.");
    }
    if (!Array.isArray(payload?.data))
      throw new Error("Unsloth: /models must return a data array.");
    const seen = new Set<string>();
    const next: ProviderChatModelConfig[] = [];
    for (const item of payload.data) {
      if (
        !item ||
        typeof item.id !== "string" ||
        !item.id.trim() ||
        seen.has(item.id)
      )
        continue;
      seen.add(item.id);
      // Use the server’s active context, not the model’s theoretical/native maximum.
      const serverContext = [
        item.context_length,
        item.context_window,
        item.max_model_len,
        item.max_seq_length,
      ].find((value) => positive(value, 0) > 0);
      const contextWindow = positive(
        serverContext,
        positive(config.contextWindow, 8192),
      );
      const maxTokens = Math.min(
        contextWindow,
        positive(item.max_output_tokens, positive(config.maxTokens, 2048)),
      );
      const override = config.modelOverrides?.[item.id] ?? {};
      const displayName =
        override.name ??
        (typeof item.name === "string" && item.name.trim()
          ? item.name
          : item.id);
      next.push({
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens,
        ...override,
        name: item.loaded === true ? `[loaded] ${displayName}` : displayName,
        id: item.id,
      });
    }
    if (payload.data.length && !next.length)
      throw new Error("Unsloth: /models contained no valid model IDs.");
    models = next;
    lastFetch = Date.now();
    startupError = undefined;
    return models;
  }

  const offline =
    /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "") ||
    process.argv.includes("--offline");
  if (!offline) {
    try {
      await discover();
    } catch (error) {
      startupError =
        error instanceof Error
          ? error.message
          : "Unsloth: model discovery failed.";
      console.error(startupError);
    }
  }

  pi.registerProvider("unsloth", {
    name: "Unsloth (local)",
    baseUrl,
    apiKey,
    api: "openai-completions",
    models,
    refreshModels: async (context) => {
      if (!context.allowNetwork) return models;
      return discover(context.signal, context.force);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (startupError)
      ctx.ui.notify(
        `${startupError} Run /unsloth-refresh when the server is available.`,
        "warning",
      );
  });

  pi.registerCommand("unsloth-model", {
    description: "Choose an Unsloth model with fresh loaded-status tags",
    handler: async (_args, ctx) => {
      const result = await ctx.modelRegistry.refresh({
        providers: ["unsloth"],
        allowNetwork: true,
        force: true,
      });
      const error = result.errors.get("unsloth");
      if (result.aborted || error) {
        ctx.ui.notify(error?.message ?? "Unsloth refresh cancelled.", "error");
        return;
      }
      const choices = ctx.modelRegistry
        .getAll()
        .filter((model) => model.provider === "unsloth")
        .sort(
          (a, b) =>
            Number(b.name.startsWith("[loaded] ")) -
            Number(a.name.startsWith("[loaded] ")),
        );
      if (!choices.length) {
        ctx.ui.notify("Unsloth: no available models.", "warning");
        return;
      }
      const labels = choices.map((model) =>
        model.name.startsWith("[loaded] ")
          ? `[loaded] ${model.id}`
          : `[available] ${model.id}`,
      );
      const selected = await ctx.ui.select(
        "Unsloth models — current server status",
        labels,
      );
      if (selected === undefined) return;
      const model = choices[labels.indexOf(selected)];
      if (model && !(await pi.setModel(model)))
        ctx.ui.notify("Unsloth: could not select model.", "error");
    },
  });

  pi.registerCommand("unsloth-refresh", {
    description: "Fetch Unsloth's available models again",
    handler: async (_args, ctx) => {
      const result = await ctx.modelRegistry.refresh({
        providers: ["unsloth"],
        allowNetwork: true,
        force: true,
      });
      const error = result.errors.get("unsloth");
      if (result.aborted || error) {
        ctx.ui.notify(error?.message ?? "Unsloth refresh cancelled.", "error");
        return;
      }
      const count = ctx.modelRegistry
        .getAll()
        .filter((model) => model.provider === "unsloth").length;
      ctx.ui.notify(
        `Unsloth: discovered ${count} model(s). Select one with /model.`,
        "info",
      );
    },
  });
}
