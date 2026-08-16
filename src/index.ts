import { createApp } from "./app.js";
import { createConfiguredOAuthRuntime } from "./auth/runtime.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const oauth = await createConfiguredOAuthRuntime();
const app = createApp({ oauth });

app.listen(config.port, () => {
  logger.info("server.started", {
    port: config.port,
    endpoint: `/mcp`,
    baseUrl: config.fakturaXlBaseUrl,
    authentication: oauth ? ["legacy-bearer", "oauth"] : ["legacy-bearer"],
  });
});
