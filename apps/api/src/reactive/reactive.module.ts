import { ChangeLogModule } from './changelog/change-log.module.js';
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { databaseEngine } from '../database/database-engine.js';
import { DatabaseModule } from '../database/database.module.js';

import { QueryRegistryService } from './registry/query-registry.service.js';
import { DependencyTrackerService } from './engine/dependency-tracker.service.js';
import { QueryExecutorService } from './engine/query-executor.service.js';
import { InvalidationService } from './invalidation/invalidation.service.js';
import { SubscriptionManagerService } from './subscriptions/subscription-manager.service.js';

import { ReactiveStreamService } from './reactive-stream.service.js';
import { RedisInvalidationService } from './invalidation/redis-invalidation.service.js';

@Module({
  imports: [
    DiscoveryModule,
    ChangeLogModule,
    ...(databaseEngine() === 'mysql' ? [] : [DatabaseModule]),
  ],
  providers: [
    QueryRegistryService,
    DependencyTrackerService,
    QueryExecutorService,
    InvalidationService,
    SubscriptionManagerService,
    RedisInvalidationService,
    ReactiveStreamService,
  ],
  exports: [
    QueryExecutorService,
    SubscriptionManagerService,
    InvalidationService,
    ReactiveStreamService,
  ],
})
export class ReactiveModule {}
