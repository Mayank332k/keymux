export function translateOpenAIToAnthropic(openaiRes: any, requestedModel: string): any {
  const choice = openaiRes.choices && openaiRes.choices[0];
  const message = choice && choice.message;
  
  let stop_reason = choice?.finish_reason || "end_turn";
  if (stop_reason === "stop") stop_reason = "end_turn";
  if (stop_reason === "tool_calls" || stop_reason === "function_call") stop_reason = "tool_use";
  if (stop_reason === "length") stop_reason = "max_tokens";
  if (stop_reason === "content_filter") stop_reason = "end_turn";
  
  const anthropicRes: any = {
    id: "msg_" + Math.random().toString(36).slice(2, 11),
    type: "message",
    role: "assistant",
    content: [],
    model: requestedModel,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiRes.usage?.prompt_tokens || 0,
      output_tokens: openaiRes.usage?.completion_tokens || 0,
    }
  };

  if (message) {
    if (message.content) {
      anthropicRes.content.push({
        type: "text",
        text: message.content,
      });
    }
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
          let parsedInput;
          if (typeof tc.function.arguments === 'string') {
            try {
              parsedInput = JSON.parse(tc.function.arguments);
            } catch (e) {
              parsedInput = { _error: "Malformed JSON from model", _raw: tc.function.arguments };
            }
          } else {
            parsedInput = tc.function.arguments;
          }
          anthropicRes.content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
      }
    }
  }

  return anthropicRes;
}
