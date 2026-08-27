import dotenv from "dotenv";
import {
  attachLiveDataSources,
  bootstrapRuntime,
} from "./bootstrap/index.js";
import { startRuntime } from "./runtime/start.js";

dotenv.config();

async function main(): Promise<void> {
  const bootstrap = await attachLiveDataSources(bootstrapRuntime());
  await startRuntime(bootstrap);
}

void main().catch((error) => {
  console.error("[bi-analyst] development startup failed", error);
  process.exit(1);
});
