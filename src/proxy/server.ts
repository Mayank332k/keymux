import fs from "fs";
import path from "path";
import http from "http";
import os from "os";

import { MultiProviderRouter } from "../core/multiProviderRouter";
import { fetchWithFailover } from "../core/fetcher";
import { UsageTracker } from "../core/usageTracker";
import {
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropic,
  OpenRouterStreamTranslator,
  NvidiaStreamTranslator
} from "./translators";
import { maskKey } from "../utils/helpers";

export interface ProxyServerOptions {
  port?: number;
  configPath?: string;
}

const DEFAULT_PORT = 3002;
const MODEL_NAME = process.env['ANTHROPIC_MODEL'] || "nvidia/nemotron-3-ultra-550b-a55b";
let serverInstance: http.Server | null = null;
let router: MultiProviderRouter;
let config: any;
let globalUsageTracker = new UsageTracker();

function parseKeyList(raw: string | undefined): string[] {
  return String(raw || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function loadConfig(configPath: string) {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch(e) {
    console.error("Failed to read config:", e);
  }
  return { defaultProvider: null, defaultModel: "", keys: { openrouter: [], nvidia: [] } };
}

function createRouterInstance(config: any) {
  const keysObj = config?.keys || {};
  let nvidiaKeys = Array.isArray(keysObj.nvidia) ? keysObj.nvidia : [];
  let openRouterKeys = Array.isArray(keysObj.openrouter) ? keysObj.openrouter : [];
  let mistralKeys = Array.isArray(keysObj.mistral) ? keysObj.mistral : [];
  let geminiKeys = Array.isArray(keysObj.gemini) ? keysObj.gemini : [];
  let groqKeys = Array.isArray(keysObj.groq) ? keysObj.groq : [];

  if (nvidiaKeys.length === 0) {
    nvidiaKeys = parseKeyList(process.env['NVIDIA_KEYS']);
  }
  if (openRouterKeys.length === 0) {
    openRouterKeys = parseKeyList(process.env['OPENROUTER_KEYS']);
  }
  if (mistralKeys.length === 0) {
    mistralKeys = parseKeyList(process.env['MISTRAL_KEYS']);
  }
  if (geminiKeys.length === 0) {
    geminiKeys = parseKeyList(process.env['GEMINI_KEYS']);
  }
  if (groqKeys.length === 0) {
    groqKeys = parseKeyList(process.env['GROQ_KEYS']);
  }

  return new MultiProviderRouter([
    {
      provider: 'openrouter',
      keys: openRouterKeys,
      models: config.openrouterModels || ['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free', 'z-ai/glm-5.2:free'],
    },
    {
      provider: 'nvidia',
      keys: nvidiaKeys,
    },
    {
      provider: 'mistral',
      keys: mistralKeys,
    },
    {
      provider: 'gemini',
      keys: geminiKeys,
    },
    {
      provider: 'groq',
      keys: groqKeys,
      models: config.groqModels || ['qwen/qwen3.8-27b'],
    }
  ], {
    strategy: config.strategy || 'smart',
    trackLatency: config.trackLatency !== undefined ? config.trackLatency : true,
    failureThreshold: config.failureThreshold || 2,
    cooldownMs: config.cooldownMs || 60000,
    windowMs: config.windowMs || 60000,
    onDebug: (event: any) => {
      if (event.type === "all_exhausted" || event.type === "circuit_opened" || event.type === "key_recovered") {
        console.log(`[keymux] ${event.type}`, event.details || {});
      }
    }
  });
}

function logUsage(provider: string, model: string, key: string | undefined, attempts: number, failoverReason: string, anthropicReq: any) {
  if (process.env['KEYMUX_ENABLE_LOGGING'] !== 'true') return;

  try {
    const maskedKeyStr = key ? maskKey(key) : 'none';
    let statusStr = attempts > 1 ? `[FAILOVER #${attempts} | Prev Reason: ${failoverReason}]` : `[PRIMARY TRY #1]`;

    // Privacy: Do not log the user's prompt text
    const logLine = `[${new Date().toISOString()}] ${statusStr.padEnd(50)} | Provider: ${provider.padEnd(10)} | Key: ${maskedKeyStr.padEnd(15)} | Model: ${model.padEnd(30)} | Query: <redacted for privacy>\n`;

    const logDir = path.join(os.homedir(), '.claude');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const logPath = path.join(logDir, 'queries.log');
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) {
      fs.renameSync(logPath, logPath.replace('queries.log', 'queries.old.log'));
    }
    fs.appendFileSync(logPath, logLine);
  } catch(e) {
    console.error("Failed to log usage", e);
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: any) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  });
  res.end(JSON.stringify(payload));
}

export function startProxyServer(options?: ProxyServerOptions): http.Server {
  const port = options?.port || Number(process.env['NVIDIA_PROXY_PORT']) || DEFAULT_PORT;
  const configPath = options?.configPath || path.join(os.homedir(), '.keymux', 'config.json');

  config = loadConfig(configPath);
  router = createRouterInstance(config);
  console.log("[keymux] Multi-Provider proxy initialized");

  (global as any).isConfigReloading = false;

  serverInstance = http.createServer(async (req, res) => {
    if ((global as any).isConfigReloading) {
      await new Promise(r => setTimeout(r, 100));
    }

    if (!req.url?.startsWith("/v1/keymux/")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/api/hello") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ message: "hello" }));
      return;
    }

    // Health / Reachability check
    if (req.method === "GET" && (req.url === "/" || req.url === "/api" || req.url === "/api/")) {
      return sendJson(res, 200, { status: "ok", service: "keymux-proxy" });
    }

    // Admin routes
    if (req.url?.startsWith("/v1/keymux/")) {
      const adminToken = process.env['KEYMUX_ADMIN_TOKEN'];
      if (adminToken) {
         const authHeader = req.headers.authorization || '';
         if (authHeader !== `Bearer ${adminToken}`) {
            return sendJson(res, 401, { error: "Unauthorized" });
         }
      }

      if (req.method === "POST" && req.url === "/v1/keymux/reload") {
        try {
          const newConfig = loadConfig(configPath);
          const newRouter = createRouterInstance(newConfig);

          (global as any).isConfigReloading = true;
          config = newConfig;
          router = newRouter;
          console.log("[keymux] Proxy settings reloaded");
          return sendJson(res, 200, { status: "reloaded" });
        } catch (err: any) {
          console.error("[keymux] Proxy reload failed:", err);
          return sendJson(res, 500, { error: "reload failed", details: err.message });
        } finally {
          (global as any).isConfigReloading = false;
        }
      }

      if (req.method === "GET" && req.url === "/v1/keymux/lastRoute") {
        res.writeHead(200, { "Content-Type": "application/json" });
        const lastRoute = typeof router.getLastRoute === 'function' ? router.getLastRoute() : null;
        res.end(JSON.stringify(lastRoute || {}));
        return;
      }

      if (req.method === "GET" && req.url === "/v1/keymux/activeModel") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          mode: config.strictMode ? 'STRICT' : 'AUTO',
          model: config.defaultModel || 'auto',
          provider: config.defaultProvider || 'auto',
        }));
        return;
      }

      if (req.method === "GET" && req.url === "/v1/keymux/stats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(router.getStats()));
        return;
      }

      if (req.method === "GET" && req.url === "/v1/keymux/usage") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          session: globalUsageTracker.getSessionUsage(),
          today: globalUsageTracker.getTodayUsage()
        }));
        return;
      }
    }

    // Model discovery for Claude Desktop / Gateway
    if (req.method === "GET" && (req.url?.includes("/v1/models") || req.url?.includes("/models"))) {
      return sendJson(res, 200, {
        data: [
          {
            id: "claude-3-5-sonnet-minimax/minimax-m3",
            type: "model",
            created: 1715000000,
            display_name: "MiniMax M3",
            anthropic_family_tier: "sonnet"
          },
          {
            id: "claude-3-5-sonnet-minimax/minimax-m2.7",
            type: "model",
            created: 1715000000,
            display_name: "MiniMax M2.7",
            anthropic_family_tier: "sonnet"
          },
          {
            id: "claude-3-5-sonnet-nvidia/nemotron-3-super-120b-a12b",
            type: "model",
            created: 1715000000,
            display_name: "Nemotron Super",
            anthropic_family_tier: "sonnet"
          },
          {
            id: "claude-3-5-sonnet-nvidia/nemotron-3-ultra-550b-a55b",
            type: "model",
            created: 1715000000,
            display_name: "Nemotron Ultra",
            anthropic_family_tier: "sonnet"
          },
          {
            id: "claude-3-5-sonnet-codestral-2508",
            type: "model",
            created: 1715000000,
            display_name: "Codestral",
            anthropic_family_tier: "sonnet"
          },
          {
            id: "claude-3-5-sonnet-gemini-1.5-flash",
            type: "model",
            created: 1715000000,
            display_name: "Gemini 1.5 Flash",
            anthropic_family_tier: "sonnet"
          }
        ],
      });
    }

    // Token count probe for Claude Desktop
    if (req.method === "POST" && req.url?.includes("/count_tokens")) {
      return sendJson(res, 200, { input_tokens: 10 });
    }

    if (req.method === "POST" && req.url?.includes("/v1/messages")) {
      let bodyStr = "";
      const MAX_BODY_SIZE = 25 * 1024 * 1024; // 25MB limit for image attachments
      req.on("data", (chunk) => {
        bodyStr += chunk;
        if (bodyStr.length > MAX_BODY_SIZE) {
          req.destroy();
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload Too Large" }));
        }
      });

      req.on("end", async () => {
        try {
          const anthropicReq = JSON.parse(bodyStr);

          // Instant response for Claude Desktop health probe test (which sends ".")
          const isProbe =
            anthropicReq.messages &&
            anthropicReq.messages.length === 1 &&
            (anthropicReq.messages[0].content === "." ||
              anthropicReq.messages[0].content === "ping" ||
              anthropicReq.max_tokens <= 1);

          if (isProbe) {
            return sendJson(res, 200, {
              id: "msg_probe_" + Math.random().toString(36).slice(2, 9),
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "OK" }],
              model: anthropicReq.model || MODEL_NAME,
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          }

          const openaiReq = translateAnthropicToOpenAI(anthropicReq);
          openaiReq.model = anthropicReq.model || MODEL_NAME;
          if (openaiReq.stream) {
            openaiReq.stream_options = { include_usage: true };
          }

          const REQUEST_TIMEOUT_MS = Number(process.env['NVIDIA_PROXY_TIMEOUT']) || 60000;
          let attempts = 0;
          let lastErrorReason = "";
          let finalEp: any = null;
          let startedAt = 0;

          try {
            const fetchRes = await fetchWithFailover(
              (ep) => {
                const url = new URL(ep.baseURL + "/chat/completions");
                return url.toString();
              },
              (ep) => {
                attempts++;
                startedAt = Date.now();
                console.log(`[PROXY] Attempt ${attempts}: Routing to ${ep.provider} (${ep.model})`);
                logUsage(ep.provider, ep.model, ep.key, attempts, lastErrorReason, anthropicReq);

                let targetModel = config.defaultModel || anthropicReq.model || ep.model || MODEL_NAME;

                if (targetModel.startsWith('claude-3-5-sonnet-') && targetModel !== 'claude-3-5-sonnet-20240620') {
                    targetModel = targetModel.replace('claude-3-5-sonnet-', '');
                }

                // AUTO MODE: Smart Provider-Model Translation
                if (!config.strictMode) {
                  if (ep.provider === 'nvidia' && !targetModel.startsWith('nvidia/') && !targetModel.startsWith('deepseek')) {
                    targetModel = 'nvidia/nemotron-3-super-120b-a12b';
                  } else if (ep.provider === 'mistral' && !targetModel.startsWith('mistral') && !targetModel.startsWith('codestral') && !targetModel.startsWith('devstral')) {
                    targetModel = 'codestral-2508';
                  } else if (ep.provider === 'gemini' && !targetModel.startsWith('gemini')) {
                    targetModel = 'gemini-3.5-flash-lite';
                  } else if (ep.provider === 'groq' && !targetModel.startsWith('qwen/') && !targetModel.startsWith('groq/') && !targetModel.startsWith('openai/')) {
                    targetModel = 'qwen/qwen3.8-27b';
                  } else if (ep.provider === 'openrouter') {
                    if (targetModel.startsWith('nvidia/')) {
                      targetModel = 'qwen/qwen3.8-27b';
                    } else if (targetModel === 'codestral-2508') {
                      targetModel = 'mistralai/codestral-2501';
                    } else if (!targetModel.includes('/')) {
                      // If the model name doesn't have a slash, it's likely a native provider model name. Let's use a safe fallback.
                      targetModel = 'qwen/qwen3.8-27b';
                    }
                  }
                }

                openaiReq.model = targetModel;

                // Only enable reasoning for providers/models that support it
                if (ep.provider === 'openrouter' || targetModel.includes('deepseek')) {
                  openaiReq.include_reasoning = true;
                } else {
                  delete openaiReq.include_reasoning;
                }

                const postData = JSON.stringify(openaiReq);
                finalEp = ep;
                return {
                  method: "POST",
                  headers: {
                    "Authorization": `Bearer ${ep.key}`,
                    "Content-Type": "application/json"
                  },
                  body: postData,
                  signal: AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined
                };
              },
              {
                router,
                maxRetries: 10,
                preferProviders: config.defaultProvider ? [config.defaultProvider] : undefined,
                excludeProviders: (config.strictMode && config.defaultProvider) ? router.getProviderNames().filter((p: string) => p !== config.defaultProvider) : undefined
              }
            );

            const ep = finalEp;

            if (!fetchRes.ok) {
               const errorData = await fetchRes.text();
               if (globalUsageTracker) {
                 globalUsageTracker.recordRequest(ep.provider, 0, 0, 0);
               }
               lastErrorReason = `${ep.provider} HTTP ${fetchRes.status}`;
               console.error(`[PROXY] Provider ${ep.provider} failed with ${fetchRes.status}: ${errorData}`);

               let customMessage = `[Keymux Gateway] Provider error (${fetchRes.status}): ${errorData.substring(0, 150)}`;
               const lowerErr = errorData.toLowerCase();

               if (lowerErr.includes("tokens limit") || lowerErr.includes("context") || lowerErr.includes("too large")) {
                   customMessage = `[Keymux Gateway] Context window exceeded! Your prompt is too large for the current model. Please clear some history or switch to a larger model via 'keymux -d'. (Details: ${errorData.substring(0, 150)})`;
               } else if (fetchRes.status === 402 || fetchRes.status === 429) {
                   customMessage = `[Keymux Gateway] All available APIs for this model are currently exhausted (rate-limited or out of credits). Please try again in a few minutes, or change your Provider/Model via 'keymux -d'.`;
               }

               res.writeHead(fetchRes.status, { "Content-Type": "application/json" });
               res.end(JSON.stringify({
                 type: "error",
                 error: {
                   type: "api_error",
                   message: customMessage
                 }
               }));
               return;
            }

            if (!openaiReq.stream) {
               const responseData = await fetchRes.text();
               try {
                  const openaiRes = JSON.parse(responseData);
                  const inputTokens = openaiRes.usage?.prompt_tokens || 0;
                  const outputTokens = openaiRes.usage?.completion_tokens || 0;
                  if (globalUsageTracker && openaiRes.usage) globalUsageTracker.recordRequest(ep.provider, inputTokens, outputTokens, 0);

                  const anthropicRes = translateOpenAIToAnthropic(openaiRes, anthropicReq.model || MODEL_NAME);

                  router.reportSuccess(ep.endpointId, Date.now() - startedAt);
                  sendJson(res, 200, anthropicRes);
                } catch (e: any) {
                  router.reportFailure(ep.endpointId, false);
                  sendJson(res, 500, { error: e.message });
                }
                return;
            }

            // Handle Streaming Response
            res.writeHead(fetchRes.status, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });

            const TranslatorClass = ep.provider === 'nvidia' ? NvidiaStreamTranslator : OpenRouterStreamTranslator;
            const translator = new TranslatorClass(res as any, anthropicReq.model || MODEL_NAME);

            let buffer = "";
            let streamUsage: any = null;
            let generatedText = "";

            if (!fetchRes.body) {
               res.end();
               return;
            }

            const reader = (fetchRes.body as any).getReader();
            const decoder = new TextDecoder();

            let ttftRecorded = false;
            let ttftMs = Date.now() - startedAt;

            let streamFailed = false;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                if (!ttftRecorded) {
                    ttftRecorded = true;
                    ttftMs = Date.now() - startedAt;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || ""; // keep last incomplete line in buffer

                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;
                  if (trimmed === "data: [DONE]") continue;

                  if (trimmed.startsWith("data: ")) {
                    const jsonStr = trimmed.slice(6);
                    try {
                      const chunkObj = JSON.parse(jsonStr);
                      if (chunkObj.usage) streamUsage = chunkObj.usage;
                      if (chunkObj.choices?.[0]?.delta?.content) {
                        generatedText += chunkObj.choices[0].delta.content;
                      }
                      translator.handleChunk(chunkObj);
                    } catch (e) {
                      // ignore parse error
                    }
                  }
                }
              }
            } catch(e) {
               console.error("[PROXY] Stream read error:", e);
               router.reportFailure(ep.endpointId, false);
               streamFailed = true;
            }

            if (!streamFailed) {
              router.reportSuccess(ep.endpointId, ttftMs);

              let inputTokens = streamUsage?.prompt_tokens || 0;
              let outputTokens = streamUsage?.completion_tokens || 0;

              if (inputTokens === 0 && outputTokens === 0) {
                inputTokens = Math.ceil(JSON.stringify(anthropicReq.messages || []).length / 4);
                outputTokens = Math.ceil(generatedText.length / 4);
              }

              if (globalUsageTracker) {
                globalUsageTracker.recordRequest(ep.provider, inputTokens, outputTokens, 0);
              }
              translator.finish(streamUsage, streamUsage ? "stop" : null);
            }
            res.end();

          } catch (error: any) {
            console.error("[PROXY] fetchWithFailover Error:", error);

            let customMessage = "[Keymux Gateway] API Error occurred.";

            if (error.message?.includes("timeout") || error.name === 'AbortError') {
              customMessage = "[Keymux Gateway] The model provider is not responding (Timeout > 60s). The server might be down or overloaded. Please try changing your Default Model or Provider via 'keymux -d'.";
            } else if (error.message?.includes("exhausted") || error.name === 'RateLimitError') {
              customMessage = "[Keymux Gateway] All available APIs for this model are currently exhausted (rate-limited or down). Please try again in a few minutes, or change your Provider/Model via 'keymux -d'.";
            } else {
              customMessage = `[Keymux Gateway] ${error.message}`;
            }

            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              type: "error",
              error: {
                type: "api_error",
                message: customMessage
              }
            }));
          }

        } catch (err) {
          sendJson(res, 400, { error: "Invalid JSON" });
        }
      });
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });

  serverInstance.listen(port, '127.0.0.1', () => {
    console.log(`[keymux] HTTP Proxy Server listening on 127.0.0.1:${port}`);
  });

  return serverInstance;
}

export function stopProxyServer() {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
    console.log("[keymux] HTTP Proxy Server stopped");
  }
}
