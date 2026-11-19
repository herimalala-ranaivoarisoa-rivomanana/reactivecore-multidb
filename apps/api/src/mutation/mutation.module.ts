import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DatabaseModule } from '../database/database.module.js';
import { ChangeLogModule } from '../reactive/changelog/change-log.module.js';
import { MutationCommitService } from './mutation-commit.service.js';
import { MutationEngineService } from './mutation-engine.service.js';
import { MutationRegistryService } from './mutation-registry.service.js';
import { MutationStore } from './mutation-store.js';
import { PostgresMutationStore } from './postgres-mutation-store.js';

@Module({
  imports: [DiscoveryModule, DatabaseModule, ChangeLogModule],
  providers: [
    MutationRegistryService,
    MutationCommitService,
    MutationEngineService,
    { provide: MutationStore, useClass: PostgresMutationStore },
  ],
  exports: [MutationCommitService, MutationEngineService],
})
export class MutationModule {}
