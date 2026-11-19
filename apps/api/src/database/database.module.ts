import { Module } from '@nestjs/common';
import { QuerySnapshotStore } from '../reactive/contracts/query-snapshot-store.js';
import { DatabaseHealth } from './database-engine.js';
import { DatabaseService } from './database.service.js';

@Module({
  providers: [
    DatabaseService,
    { provide: DatabaseHealth, useExisting: DatabaseService },
    { provide: QuerySnapshotStore, useExisting: DatabaseService },
  ],
  exports: [DatabaseService, QuerySnapshotStore, DatabaseHealth],
})
export class DatabaseModule {}
