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
  let nvidiaKeys = config.keys?.nvidia || [];
  let openRouterKeys = config.keys?.openrouter || [];
  let mistralKeys = config.keys?.mistral || [];
  let geminiKeys = config.keys?.gemini || [];
  let groqKeys = config.keys?.groq || [];
  
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
      models: config.groqModels || ['llama-3.1-70b-versatile'],
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

function maskKey(key: string | undefined): string {
  return key ? key.substring(0, 8) + '...' : 'none';
}

function logUsage(provider: string, model: string, key: string | undefined, attempts: number, failoverReason: string, anthropicReq: any) {
  try {
    let query = "";
    if (anthropicReq.messages && anthropicReq.messages.length > 0) {
      const lastMsg = anthropicReq.messages[anthropicReq.messages.length - 1];
      if (typeof lastMsg.content === 'string') {
        query = lastMsg.content;
      } else if (Array.isArray(lastMsg.content)) {
        query = lastMsg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(" ");
      }
    }
    query = query.replace(/\n/g, " ");
    const shortQuery = query.length > 100 ? query.substring(0, 100) + '...' : query;
    const maskedKeyStr = maskKey(key);
    
    let statusStr = attempts > 1 ? `[FAILOVER #${attempts} | Prev Reason: ${failoverReason}]` : `[PRIMARY TRY #1]`;
    
    const logLine = `[${new Date().toISOString()}] ${statusStr.padEnd(50)} | Provider: ${provider.padEnd(10)} | Key: ${maskedKeyStr.padEnd(15)} | Model: ${model.padEnd(30)} | Query: ${shortQuery}\n`;
    const logPath = path.join(os.homedir(), '.claude', 'queries.log');
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

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

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

    if (req.method === "POST" && req.url === "/v1/keymux/reload") {
      (global as any).isConfigReloading = true;
      config = loadConfig(configPath);
      router = createRouterInstance(config);
      console.log("[keymux] Proxy settings reloaded");
      (global as any).isConfigReloading = false;
      return sendJson(res, 200, { status: "reloaded" });
    }

    if (req.method === "GET" && req.url === "/v1/keymux/lastRoute") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      const lastRoute = typeof router.getLastRoute === 'function' ? router.getLastRoute() : null;
      res.end(JSON.stringify(lastRoute || {}));
      return;
    }

    if (req.method === "GET" && req.url === "/v1/keymux/stats") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(router.getStats()));
      return;
    }

    if (req.method === "GET" && req.url === "/v1/keymux/usage") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ 
        session: globalUsageTracker.getSessionUsage(), 
        today: globalUsageTracker.getTodayUsage() 
      }));
      return;
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
            id: "claude-3-5-sonnet-codestral-latest",
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
      req.on("data", (chunk) => {
        bodyStr += chunk;
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

                let targetModel = config.strictMode ? config.defaultModel : (anthropicReq.model || ep.model || MODEL_NAME);
                
                if (targetModel.startsWith('claude-3-5-sonnet-') && targetModel !== 'claude-3-5-sonnet-20240620') {
                    targetModel = targetModel.replace('claude-3-5-sonnet-', '');
                }
                
                if (!config.strictMode) {
                  // Automatic Provider-Model Translation for Failovers
                  if (ep.provider === 'nvidia' && !targetModel.startsWith('nvidia/')) {
                    targetModel = 'nvidia/nemotron-3-ultra-550b-a55b'; // massive context
                  } else if (ep.provider === 'mistral' && !targetModel.startsWith('mistral') && !targetModel.startsWith('codestral')) {
                    targetModel = 'codestral-latest';
                  } else if (ep.provider === 'gemini' && !targetModel.startsWith('gemini')) {
                    targetModel = 'gemini-1.5-flash';
                  } else if (ep.provider === 'groq' && !targetModel.startsWith('llama-3.1')) {
                    targetModel = 'llama-3.1-70b-versatile';
                  } else if (ep.provider === 'openrouter' && (targetModel.startsWith('nvidia/') || targetModel.startsWith('mistral') || targetModel.startsWith('codestral') || targetModel.startsWith('gemini') || targetModel.startsWith('llama') || targetModel.startsWith('claude'))) {
                    targetModel = 'minimax/minimax-m3';
                  }
                }

                openaiReq.model = targetModel;
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
                   customMessage = `[Keymux Gateway] All API keys are exhausted, out of credits, or rate-limited. Tried all failover options. Please wait or add fresh keys via 'keymux -d'.`;
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
            }

            router.reportSuccess(ep.endpointId, ttftMs);
            
            let inputTokens = streamUsage?.prompt_tokens || 0;
            let outputTokens = streamUsage?.completion_tokens || 0;
            
            if (inputTokens === 0 && outputTokens === 0) {
              // Fallback token counting
              inputTokens = Math.ceil(JSON.stringify(anthropicReq.messages || []).length / 4);
              outputTokens = Math.ceil(generatedText.length / 4);
            }
            
            if (globalUsageTracker) globalUsageTracker.recordRequest(ep.provider, inputTokens, outputTokens, 0);
            
            translator.finish(streamUsage, streamUsage ? "stop" : null);
            res.end();

          } catch (error: any) {
            console.error("[PROXY] fetchWithFailover Error:", error);
            
            let customMessage = "[Keymux Gateway] API Error occurred.";
            
            if (error.message?.includes("timeout") || error.name === 'AbortError') {
              customMessage = "[Keymux Gateway] The model provider is not responding (Timeout > 60s). The server might be down or overloaded. Please try changing your Default Model or Provider via 'keymux -d'.";
            } else if (error.message?.includes("exhausted") || error.name === 'RateLimitError') {
              customMessage = "[Keymux Gateway] All API keys are currently rate-limited or blocked. Tried all failover options but none succeeded. Please wait a few minutes for the cooldown, or add fresh keys via 'keymux -d'.";
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

  serverInstance.listen(port, () => {
    console.log(`[keymux] HTTP Proxy Server listening on port ${port}`);
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
