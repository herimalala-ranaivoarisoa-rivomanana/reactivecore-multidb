import { Injectable } from '@nestjs/common';

import { QuerySnapshotStore } from '../contracts/query-snapshot-store.js';

import { QueryRegistryService } from '../registry/query-registry.service.js';
import { DependencyTrackerService } from './dependency-tracker.service.js';

import type { QueryPrincipal } from '../contracts/query-context.js';

import type { Dependency } from '../contracts/dependency.types.js';

export interface ExecutedQuery {
  data: unknown;
  snapshotSeq: string;
  dependencies: Dependency[];
}

@Injectable()
export class QueryExecutorService {
  constructor(
    private readonly snapshots: QuerySnapshotStore,
    private readonly registry: QueryRegistryService,
    private readonly tracker: DependencyTrackerService,
  ) {}

  async execute(
    principal: QueryPrincipal,
    name: string,
    args: unknown,
  ): Promise<ExecutedQuery> {
    const handler = this.registry.get(name);

    const collector = this.tracker.createCollector();

    return this.snapshots.snapshotTenantTransaction(
      principal.tenantId,
      async (access, snapshotSeq) => {
        const data = await handler(
          {
            principal,
            get client() {
              return access.client;
            },
            data: access.data,
            dependencies: collector,
          },
          args,
        );
        return { data, snapshotSeq, dependencies: collector.snapshot() };
      },
    );
  }
}
