import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { OutboxStore } from './outbox-store.js';
import { PostgresOutboxStore } from './postgres-outbox-store.js';
import { OutboxService } from './outbox.service.js';

import { databaseEngine } from '../database/database-engine.js';
import { MysqlModule } from '../database/mysql/mysql.module.js';
import { MysqlOutboxStore } from '../database/mysql/mysql-outbox-store.js';

const mysql = databaseEngine() === 'mysql';

@Module({
  imports: [mysql ? MysqlModule : DatabaseModule, RedisModule],
  providers: [
    OutboxService,
    {
      provide: OutboxStore,
      useClass: mysql ? MysqlOutboxStore : PostgresOutboxStore,
    },
  ],
})
export class OutboxModule {}
