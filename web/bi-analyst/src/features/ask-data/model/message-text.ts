import type { AskDataUIMessage } from "../model/types";

export function messageText(message: AskDataUIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function lastAnalyzeQuery(messages: AskDataUIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    const previousAssistant = findPreviousAssistant(messages, index);
    const followsClarification = previousAssistant?.parts.some(
      (part) => part.type === "data-clarification",
    );
    if (followsClarification) continue;
    return messageText(message);
  }
  return "";
}

function findPreviousAssistant(
  messages: AskDataUIMessage[],
  before: number,
): AskDataUIMessage | undefined {
  for (let index = before - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}
