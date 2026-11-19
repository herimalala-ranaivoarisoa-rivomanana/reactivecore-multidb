import { Module } from '@nestjs/common';
import { QuerySnapshotStore } from '../reactive/contracts/query-snapshot-store.js';
import { DatabaseService } from './database.service.js';

@Module({
  providers: [
    DatabaseService,
    { provide: QuerySnapshotStore, useExisting: DatabaseService },
  ],
  exports: [DatabaseService, QuerySnapshotStore],
})
export class DatabaseModule {}
