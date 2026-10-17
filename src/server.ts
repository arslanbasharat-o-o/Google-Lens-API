import { buildApp } from './http/app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp({ config });

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Google Lens API listening on ${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
