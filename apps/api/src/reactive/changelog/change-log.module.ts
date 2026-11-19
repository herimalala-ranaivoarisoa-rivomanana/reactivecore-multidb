import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { ChangeFeed } from '../contracts/change-feed.js';
import { ChangeLogService } from './change-log.service.js';

import { databaseEngine } from '../../database/database-engine.js';
import { MysqlModule } from '../../database/mysql/mysql.module.js';
import { MysqlReactiveStore } from '../../database/mysql/mysql-reactive-store.js';
import { QuerySnapshotStore } from '../contracts/query-snapshot-store.js';

const mysql = databaseEngine() === 'mysql';

@Module({
  imports: mysql ? [MysqlModule] : [DatabaseModule],
  providers: mysql
    ? [
        MysqlReactiveStore,
        { provide: ChangeFeed, useExisting: MysqlReactiveStore },
        { provide: QuerySnapshotStore, useExisting: MysqlReactiveStore },
      ]
    : [
        ChangeLogService,
        { provide: ChangeFeed, useExisting: ChangeLogService },
      ],
  exports: mysql
    ? [ChangeFeed, QuerySnapshotStore]
    : [ChangeLogService, ChangeFeed],
})
export class ChangeLogModule {}
