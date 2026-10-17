import { buildApp } from './http/app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp({ config });

let shutdownPromise: Promise<void> | undefined;
const shutdown = (signal: string): void => {
  shutdownPromise ??= app.close().then(() => {
    app.log.info(`Google Lens API stopped after ${signal}`);
  });
  void shutdownPromise.catch((error) => {
    app.log.error(error);
    process.exitCode = 1;
  });
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Google Lens API listening on ${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
