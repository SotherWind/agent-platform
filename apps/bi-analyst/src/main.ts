import dotenv from "dotenv";
import { bootstrapRuntime, logBootstrapSummary } from "./bootstrap/index.js";
import { startAppServer } from "./api/server.js";

dotenv.config();

const bootstrap = bootstrapRuntime();
logBootstrapSummary(bootstrap);

const app = startAppServer(bootstrap, bootstrap.config.port);

process.on("SIGINT", () => {
  void app.close().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void app.close().finally(() => process.exit(0));
});
