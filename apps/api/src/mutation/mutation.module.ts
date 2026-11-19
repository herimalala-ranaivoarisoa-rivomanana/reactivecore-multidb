import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DatabaseModule } from '../database/database.module.js';
import { ChangeLogModule } from '../reactive/changelog/change-log.module.js';
import { MutationCommitService } from './mutation-commit.service.js';
import { MutationEngineService } from './mutation-engine.service.js';
import { MutationRegistryService } from './mutation-registry.service.js';
import { MutationStore } from './mutation-store.js';
import { PostgresMutationStore } from './postgres-mutation-store.js';

import { databaseEngine } from '../database/database-engine.js';
import { MysqlModule } from '../database/mysql/mysql.module.js';
import { MysqlMutationStore } from '../database/mysql/mysql-mutation-store.js';

const mysql = databaseEngine() === 'mysql';

@Module({
  imports: [
    DiscoveryModule,
    ...(mysql ? [MysqlModule] : [DatabaseModule, ChangeLogModule]),
  ],
  providers: [
    MutationRegistryService,
    ...(mysql ? [] : [MutationCommitService]),
    MutationEngineService,
    {
      provide: MutationStore,
      useClass: mysql ? MysqlMutationStore : PostgresMutationStore,
    },
  ],
  exports: [MutationEngineService],
})
export class MutationModule {}
