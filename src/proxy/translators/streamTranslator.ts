import * as http from 'http';

export class OpenRouterStreamTranslator {
  res: http.ServerResponse;
  requestedModel: string;
  currentBlockType: string | null;
  currentBlockIndex: number;
  toolIndexMap: Record<number, number>;
  state: 'NORMAL' | 'POTENTIAL_START' | 'IN_THINKING' | 'POTENTIAL_END';
  buffer: string;
  _thinkTag: string;
  hasSentMessageStart: boolean;

  constructor(res: http.ServerResponse, requestedModel: string) {
    this.res = res;
    this.requestedModel = requestedModel;
    
    this.currentBlockType = null;
    this.currentBlockIndex = 0;
    this.toolIndexMap = {};
    this.state = 'NORMAL';
    this.buffer = '';
    this._thinkTag = '<thinking>';
    this.hasSentMessageStart = false;
  }
  
  writeEvent(type: string, dataObj: any) {
    this.res.write(`event: ${type}\ndata: ${JSON.stringify(dataObj)}\n\n`);
  }

  startMessage() {
    if (this.hasSentMessageStart) return;
    this.writeEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_" + Math.random().toString(36).slice(2, 11),
        type: "message",
        role: "assistant",
        content: [],
        model: this.requestedModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    this.hasSentMessageStart = true;
  }

  stopCurrentBlock() {
    if (this.currentBlockType !== null) {
      this.writeEvent("content_block_stop", {
        type: "content_block_stop",
        index: this.currentBlockIndex
      });
      this.currentBlockIndex++;
      this.currentBlockType = null;
    }
  }

  startBlock(type: string, extra: any = {}) {
    this.stopCurrentBlock();
    const content_block: any = { type, ...extra };
    if (type === 'thinking') {
      content_block.thinking = "";
      content_block.signature = "dummy_sig";
    } else if (type === 'text') {
      content_block.text = "";
    }
    
    this.writeEvent("content_block_start", {
      type: "content_block_start",
      index: this.currentBlockIndex,
      content_block
    });
    this.currentBlockType = type;
  }
  
  handleChunk(chunkObj: any) {
    this.startMessage();
    
    const choice = chunkObj.choices && chunkObj.choices[0];
    if (!choice) return;
    
    const delta = choice.delta;
    if (!delta) return;

    const reasoning = delta.reasoning || delta.reasoning_content;
    if (reasoning) {
      if (this.currentBlockType !== "thinking") {
        this.startBlock("thinking");
      }
      this.writeEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.currentBlockIndex,
        delta: {
          type: "thinking_delta",
          thinking: reasoning
        }
      });
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      for (const char of delta.content) {
        if (this.state === 'NORMAL') {
          if (char === '<') {
            this.state = 'POTENTIAL_START';
            this.buffer = char;
          } else {
            if (this.currentBlockType !== "text") {
              this.startBlock("text");
            }
            this.writeEvent("content_block_delta", {
              type: "content_block_delta",
              index: this.currentBlockIndex,
              delta: { type: "text_delta", text: char }
            });
          }
        } else if (this.state === 'POTENTIAL_START') {
          this.buffer += char;
          // Support both <thinking> and <think> tags
          const targets = ["<thinking>", "<think>"];
          const matchedTarget = targets.find(t => t === this.buffer);
          const partialMatch = targets.some(t => t.startsWith(this.buffer));
          
          if (matchedTarget) {
            this.state = 'IN_THINKING';
            this._thinkTag = matchedTarget; // remember which tag opened
            this.buffer = '';
            this.startBlock("thinking");
          } else if (!partialMatch || this.buffer.length > 20) {
            if (this.currentBlockType !== "text") {
              this.startBlock("text");
            }
            this.writeEvent("content_block_delta", {
              type: "content_block_delta",
              index: this.currentBlockIndex,
              delta: { type: "text_delta", text: this.buffer }
            });
            this.state = 'NORMAL';
            this.buffer = '';
          }
        } else if (this.state === 'IN_THINKING') {
          if (char === '<') {
            this.state = 'POTENTIAL_END';
            this.buffer = char;
          } else {
            if (this.currentBlockType !== "thinking") {
              this.startBlock("thinking");
            }
            this.writeEvent("content_block_delta", {
              type: "content_block_delta",
              index: this.currentBlockIndex,
              delta: { type: "thinking_delta", thinking: char }
            });
          }
        } else if (this.state === 'POTENTIAL_END') {
          this.buffer += char;
          // Build closing tag from whichever opening tag was used
          const closeTag = this._thinkTag === "<think>" ? "</think>" : "</thinking>";
          if (this.buffer === closeTag) {
            this.state = 'NORMAL';
            this.buffer = '';
            this.startBlock("text");
          } else if (!closeTag.startsWith(this.buffer) || this.buffer.length > 20) {
            if (this.currentBlockType !== "thinking") {
              this.startBlock("thinking");
            }
            this.writeEvent("content_block_delta", {
              type: "content_block_delta",
              index: this.currentBlockIndex,
              delta: { type: "thinking_delta", thinking: this.buffer }
            });
            this.state = 'IN_THINKING';
            this.buffer = '';
          }
        }
      }
    }
    
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.id) {
          let rawName = tc.function.name || "";
          let safeName = rawName.split("<")[0].replace(/[^a-zA-Z0-9_-]/g, "");
          this.startBlock("tool_use", { id: tc.id, name: safeName, input: {} });
          this.toolIndexMap[tc.index] = this.currentBlockIndex;
        }
        if (tc.function && tc.function.arguments) {
          const targetIndex = this.toolIndexMap[tc.index] !== undefined ? this.toolIndexMap[tc.index] : this.currentBlockIndex;
          this.writeEvent("content_block_delta", {
            type: "content_block_delta",
            index: targetIndex,
            delta: {
              type: "input_json_delta",
              partial_json: tc.function.arguments
            }
          });
        }
      }
    }
  }

  finish(streamUsage: any, finishReason: any) {
    this.startMessage(); 
    this.stopCurrentBlock();
    
    const stop_reason = finishReason === "stop" || finishReason === null ? ((this as any).stopSequences && (this as any).stopSequences.length > 0 ? "stop_sequence" : "end_turn") 
                      : (finishReason === "tool_calls" || finishReason === "function_call") ? "tool_use"
                      : finishReason === "length" ? "max_tokens"
                      : finishReason === "content_filter" ? "end_turn"
                      : finishReason || "end_turn";
                      
    const inputTokens = streamUsage?.prompt_tokens || 0;
    const outputTokens = streamUsage?.completion_tokens || 0;
    
    this.writeEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason, stop_sequence: stop_reason === "stop_sequence" ? (this as any).stopSequences[0] : null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    });
    
    this.writeEvent("message_stop", { type: "message_stop" });
  }
}

export class NvidiaStreamTranslator extends OpenRouterStreamTranslator {}
