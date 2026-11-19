import { databaseEngine } from './database/database-engine.js';
import { MysqlDatabase } from './database/mysql/mysql-database.js';
import { NestFactory } from '@nestjs/core';
import { loadApplication } from './platform/load-application.js';
import { PlatformModule } from './platform/platform.module.js';
import type { Project } from './platform/project.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function run() {
  const project = await loadApplication(required('RC_APPLICATION_FILE'));

  const auth: Project['auth'] = process.env.RC_JWKS_URL
    ? { jwks: new URL(process.env.RC_JWKS_URL) }
    : {
        developmentKey: new TextEncoder().encode(required('RC_JWT_DEV_SECRET')),
      };
  const app = await NestFactory.create(
    PlatformModule.forProject({
      ...project,
      issuer: required('RC_JWT_ISSUER'),
      audience: required('RC_JWT_AUDIENCE'),
      auth,
    }),
    { forceCloseConnections: true },
  );
  if (databaseEngine() === 'mysql') {
    try { await app.get(MysqlDatabase).assertAccount('reactivecore_app'); }
    catch (error) { await app.close(); throw error; }
  }
  const origins = process.env.RC_CORS_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins?.length) app.enableCors({ origin: origins });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.listen(
    Number(process.env.PORT ?? 4000),
    process.env.RC_HOST ?? '127.0.0.1',
  );
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
