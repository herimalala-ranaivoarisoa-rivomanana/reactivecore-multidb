import type { QueryContext } from './query-context.js';

/** Runs a tenant read against a consistent snapshot and its matching commit sequence. */
export abstract class QuerySnapshotStore {
  abstract snapshotTenantTransaction<T>(
    tenantId: string,
    run: (
      access: Pick<QueryContext, 'client' | 'data'>,
      snapshotSeq: string,
    ) => Promise<T>,
  ): Promise<T>;
}
