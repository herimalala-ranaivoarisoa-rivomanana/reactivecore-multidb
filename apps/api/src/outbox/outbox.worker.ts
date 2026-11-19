import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { setTimeout } from 'node:timers/promises';
import { OutboxStore } from './outbox-store.js';
import { OutboxModule } from './outbox.module.js';
import { OutboxService } from './outbox.service.js';

async function run() {
  const logger = new Logger('OutboxWorker');
  const app = await NestFactory.createApplicationContext(OutboxModule);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await app.get(OutboxStore).assertWorkerAccess();

    const outbox = app.get(OutboxService);
    while (!stopping) {
      try {
        if (await outbox.publishNext()) continue;
      } catch (error) {
        logger.warn(error);
      }
      if (!stopping) await setTimeout(1000);
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await app.close();
  }
}

run().catch((error: unknown) => {
  console.error('Outbox startup failed:', error);
  process.exitCode = 1;
});
