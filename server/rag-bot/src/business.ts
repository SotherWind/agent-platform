import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertToolRegistry,
  defaultTools,
  FakeBackend,
  type AgentTool,
  type Backend,
  type TicketService,
} from "@agent-platform/rag-boot";
import type { ServerConfig } from "./config.js";

export async function resolveBusinessTools(
  config: ServerConfig,
  ticketService: TicketService,
  localBackend?: Backend,
): Promise<AgentTool[]> {
  if (!config.businessModule) {
    if (config.environment === "production") throw new Error("Production business tools are not configured.");
    // 开发环境默认接入持久化本地 CRM；FakeBackend 只保留给单测/显式注入。
    return defaultTools(localBackend ?? new FakeBackend(), (input) => ticketService.create(input));
  }
  const module = await import(pathToFileURL(resolve(config.businessModule)).href);
  if (typeof module.createTools !== "function") {
    throw new Error("RAGBOT_BUSINESS_MODULE must export createTools({ ticketService }).");
  }
  const tools = await module.createTools({ ticketService });
  if (!Array.isArray(tools) || tools.length === 0) throw new Error("Business module returned no tools.");
  assertToolRegistry(tools);
  return tools;
}
