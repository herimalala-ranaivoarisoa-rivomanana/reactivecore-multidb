import type { PoolClient } from 'pg';
import type { QuerySnapshotStore } from '../contracts/query-snapshot-store.js';
import type { QueryContext } from '../contracts/query-context.js';
import type { QueryRegistryService } from '../registry/query-registry.service.js';
import { DependencyTrackerService } from './dependency-tracker.service.js';
import { QueryExecutorService } from './query-executor.service.js';

it('executes the registered handler on the tenant connection and returns its dependencies', async () => {
  const principal = { userId: 'user-a', tenantId: 'tenant-a', roles: [] };
  const client = {} as PoolClient;
  const data = { get: vi.fn(), list: vi.fn(), report: vi.fn() };
  const dependency = {
    kind: 'table',
    table: 'stocks',
    tenantId: 'tenant-a',
  } as const;
  const request = { table: 'stocks', columns: ['id'], limit: 10 };
  const handler = vi.fn(async (ctx: QueryContext, args: unknown) => {
    expect(ctx.client).toBe(client);
    await ctx.data.list(request);
    expect(ctx.principal).toBe(principal);
    return args;
  });
  const registry = { get: vi.fn().mockReturnValue(handler) };
  const snapshots = {
    snapshotTenantTransaction: vi.fn(
      async (
        _tenant: string,
        run: (
          access: Pick<QueryContext, 'client' | 'data' | 'mysqlSql'>,
          seq: string,
        ) => Promise<unknown>,
      ) => run({ client, data }, '42'),
    ),
  };
  const executor = new QueryExecutorService(
    snapshots as unknown as QuerySnapshotStore,
    registry as unknown as QueryRegistryService,
    new DependencyTrackerService(),
  );

  expect(
    await executor.execute(principal, 'stocks.list', { mock: true }),
  ).toEqual({
    data: { mock: true },
    snapshotSeq: '42',
    dependencies: [dependency],
  });
  expect(data.list).toHaveBeenCalledExactlyOnceWith(request);
  expect(registry.get).toHaveBeenCalledWith('stocks.list');
  expect(snapshots.snapshotTenantTransaction).toHaveBeenCalledWith(
    'tenant-a',
    expect.any(Function),
  );
});
