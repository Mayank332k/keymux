export function translateMessages(anthropicMessages: any[], systemPrompt: any): any[] {
  const openaiMessages: any[] = [];
  if (systemPrompt) {
    let sysContent = systemPrompt;
    if (Array.isArray(systemPrompt)) {
      sysContent = systemPrompt.map((b: any) => b.text || "").join("\n");
    }
    openaiMessages.push({ role: "system", content: sysContent });
  }

  for (const msg of anthropicMessages || []) {
    const role = msg.role;

    if (typeof msg.content === "string") {
      openaiMessages.push({ role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const contentParts: any[] = [];
      const calls: any[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          contentParts.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          contentParts.push({ type: "text", text: `<thinking>${block.thinking}</thinking>` });
        } else if (block.type === "image") {
          contentParts.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
          });
        } else if (block.type === "tool_use") {
          calls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        } else if (block.type === "document") {
          let title = block.title || 'document';
          if (typeof title === 'string' && (title.includes('../') || title.includes('..\\') || title.includes('/etc/') || title.startsWith('/'))) {
             title = "sanitized_document";
          }
          if (block.source && block.source.type === "base64" && block.source.data) {
            let docText = `[Attached File: ${title}]\n`;
            if (block.source.media_type === "application/pdf") {
              docText += "[PDF extraction via proxy is limited. Try pasting text if it fails]";
            } else if (block.source.media_type && !block.source.media_type.startsWith("text/")) {
              docText += "[Binary content unsupported by translation layer]";
            } else {
              try {
                docText += Buffer.from(block.source.data, 'base64').toString('utf8');
              } catch(e) {
                docText += "[Binary file cannot be read]";
              }
            }
            contentParts.push({ type: "text", text: docText });
          } else if (block.source && block.source.type === "text") {
            contentParts.push({ type: "text", text: `[Attached File: ${title}]\n${block.source.data}` });
          }
        } else if (block.type === "tool_result") {
          let toolText = "";
          if (typeof block.content === "string") {
            toolText = block.content;
          } else if (Array.isArray(block.content)) {
            toolText = block.content.map((c: any) => {
              if (c.type === "text") return c.text;
              if (c.type === "image") return "[Tool output included an image]";
              return typeof c === "string" ? c : JSON.stringify(c);
            }).join("\n");
          }
          if (block.is_error) {
             toolText = `[Error executing tool]\n${toolText}`;
          }
          openaiMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: toolText || "Executed successfully"
          });
        }
      }

      if (contentParts.length > 0 || calls.length > 0) {
        const messageObj: any = { role };
        if (contentParts.length > 0) {
          messageObj.content = contentParts;
        }
        if (calls.length > 0) {
          messageObj.tool_calls = calls;
          messageObj.thought_signature = "skip_thought_signature_validator";
        }
        openaiMessages.push(messageObj);
      }
    }
  }
  return openaiMessages;
}

export function translateTools(anthropicTools: any[]): any[] | undefined {
  if (!anthropicTools) return undefined;
  return anthropicTools.map((t: any) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export function translateAnthropicToOpenAI(anthropicReq: any): any {
  if (anthropicReq.model) {
    if (anthropicReq.model === 'claude-3-5-sonnet-minimax-m3') {
      anthropicReq.model = 'minimax/minimax-m3:free';
    } else if (anthropicReq.model === 'claude-3-5-sonnet-minimax-m2.7') {
      anthropicReq.model = 'minimax/minimax-m2.7:free';
    } else if (anthropicReq.model === 'claude-3-5-sonnet-glm-5.2') {
      anthropicReq.model = 'z-ai/glm-5.2:free';
    } else if (anthropicReq.model === 'claude-3-5-sonnet-nemotron-3-super-120b-a12b') {
      anthropicReq.model = 'nvidia/nemotron-3-super-120b-a12b';
    } else if (anthropicReq.model === 'claude-3-5-sonnet-nemotron-3-ultra-550b-a55b') {
      anthropicReq.model = 'nvidia/nemotron-3-ultra-550b-a55b';
    }
  }

  const openaiReq: any = {
    messages: translateMessages(anthropicReq.messages, anthropicReq.system),
    stream: anthropicReq.stream !== undefined ? anthropicReq.stream : false,
  };
  
  if (openaiReq.stream) {
    openaiReq.stream_options = { include_usage: true };
  }
  
  const tools = translateTools(anthropicReq.tools);
  if (tools) openaiReq.tools = tools;

  if (anthropicReq.temperature !== undefined) {
    openaiReq.temperature = anthropicReq.temperature;
  }
  if (anthropicReq.max_tokens !== undefined) {
    openaiReq.max_tokens = anthropicReq.max_tokens;
  }
  
  if (anthropicReq.stop_sequences) {
    openaiReq.stop = anthropicReq.stop_sequences;
  }

  if (anthropicReq.tool_choice) {
    if (anthropicReq.tool_choice.type === 'tool') {
      openaiReq.tool_choice = { type: 'function', function: { name: anthropicReq.tool_choice.name } };
    } else if (anthropicReq.tool_choice.type === 'auto') {
      openaiReq.tool_choice = 'auto';
    }
  }
  
  return openaiReq;
}
