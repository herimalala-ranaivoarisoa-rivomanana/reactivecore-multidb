import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module.js';
import { databaseEngine } from '../database/database-engine.js';
import { MysqlModule } from '../database/mysql/mysql.module.js';
import { ChangeLogModule } from '../reactive/changelog/change-log.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    databaseEngine() === 'mysql' ? MysqlModule : DatabaseModule,
    RedisModule,
    ChangeLogModule,
  ],
  controllers: [HealthController],
})
export class HealthModule {}
