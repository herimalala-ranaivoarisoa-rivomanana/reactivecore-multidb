import type { ChangeFeed } from '../contracts/change-feed.js';
import type {
  ChangeDescriptor,
  Dependency,
} from '../contracts/dependency.types.js';
import type {
  ExecutedQuery,
  QueryExecutorService,
} from '../engine/query-executor.service.js';
import { InvalidationService } from '../invalidation/invalidation.service.js';
import { SubscriptionManagerService } from './subscription-manager.service.js';

const principal = { tenantId: 'tenant-a', userId: 'user-a', roles: [] };
const dependency: Dependency = {
  tenantId: principal.tenantId,
  table: 'stocks',
  kind: 'document',
  documentId: 'initial-stock',
};
const change: ChangeDescriptor = {
  tenantId: principal.tenantId,
  table: 'stocks',
  documentId: 'initial-stock',
  operation: 'update',
};

function deferredQuery() {
  let resolve!: (result: ExecutedQuery) => void;
  const promise = new Promise<ExecutedQuery>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function scenario() {
  const execute = vi.fn<QueryExecutorService['execute']>();
  const journal = {
    currentSeq: vi.fn().mockResolvedValue('0'),
    hasChanges: vi.fn().mockResolvedValue(false),
    readBatch: vi.fn().mockResolvedValue({ changes: [], coveredSeq: '0' }),
  };
  const manager = new SubscriptionManagerService(
    { execute } as unknown as QueryExecutorService,
    new InvalidationService(),
    journal as unknown as ChangeFeed,
  );
  return { execute, journal, manager, listener: vi.fn() };
}

it('retries an initial snapshot invalidated while it was reading', async () => {
  const { execute, manager, listener } = scenario();
  const first = deferredQuery();
  execute.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
    data: 2,
    snapshotSeq: '2',
    dependencies: [dependency],
  });
  const subscription = manager.subscribe(
    principal,
    'stocks.list',
    {},
    listener,
  );
  manager.invalidate(change);
  first.resolve({ data: 1, snapshotSeq: '1', dependencies: [dependency] });
  const id = await subscription;
  expect(listener).toHaveBeenCalledExactlyOnceWith({
    subscriptionId: id,
    data: 2,
    revision: 1,
    snapshotSeq: '2',
  });
  manager.unsubscribe(id);
});

it('rechecks a snapshot when a change affects a newly discovered dependency', async () => {
  const { execute, manager, listener } = scenario();
  const pending = deferredQuery();
  const nextDependency = { ...dependency, documentId: 'new-stock' };
  execute
    .mockResolvedValueOnce({
      data: 1,
      snapshotSeq: '1',
      dependencies: [dependency],
    })
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({
      data: 3,
      snapshotSeq: '3',
      dependencies: [nextDependency],
    });
  const id = await manager.subscribe(principal, 'stocks.list', {}, listener);

  manager.invalidate({ ...change, tenantId: 'tenant-b' });
  expect(execute).toHaveBeenCalledTimes(1);

  manager.invalidate(change);
  manager.invalidate({ ...change, documentId: 'new-stock' });
  pending.resolve({
    data: 2,
    snapshotSeq: '2',
    dependencies: [nextDependency],
  });
  await vi.waitFor(() =>
    expect(listener).toHaveBeenLastCalledWith({
      subscriptionId: id,
      data: 3,
      revision: 2,
      snapshotSeq: '3',
    }),
  );
  expect(listener).toHaveBeenCalledTimes(2);
  manager.unsubscribe(id);
});

it('reconciles without emitting identical results and respects unsubscribe', async () => {
  const { execute, journal, manager, listener } = scenario();
  execute.mockResolvedValue({
    data: { a: 1, b: 2 },
    snapshotSeq: '0',
    dependencies: [dependency],
  });
  const id = await manager.subscribe(principal, 'stocks.list', {}, listener);
  execute.mockResolvedValueOnce({
    data: { b: 2, a: 1 },
    snapshotSeq: '1',
    dependencies: [dependency],
  });
  journal.currentSeq.mockResolvedValue('1');
  journal.readBatch.mockResolvedValue({ changes: [change], coveredSeq: '1' });
  manager.reconcileAll();
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
  expect(listener).toHaveBeenCalledTimes(1);
  manager.unsubscribe(id);
  manager.invalidate(change);
  expect(execute).toHaveBeenCalledTimes(2);
});

it('checks the durable journal after reading its initial snapshot, without a Redis signal', async () => {
  const { execute, journal, manager, listener } = scenario();
  journal.currentSeq.mockResolvedValue('11');
  journal.hasChanges.mockResolvedValueOnce(true);
  execute
    .mockResolvedValueOnce({
      data: 1,
      snapshotSeq: '10',
      dependencies: [dependency],
    })
    .mockResolvedValueOnce({
      data: 2,
      snapshotSeq: '11',
      dependencies: [dependency],
    });
  const id = await manager.subscribe(principal, 'stocks.list', {}, listener);
  expect(journal.hasChanges).toHaveBeenCalledWith(
    principal.tenantId,
    '10',
    '11',
  );
  expect(listener).toHaveBeenCalledExactlyOnceWith({
    subscriptionId: id,
    data: 2,
    revision: 1,
    snapshotSeq: '11',
  });
  manager.unsubscribe(id);
});

it('advances past an unrelated journal batch without executing the query again', async () => {
  const { execute, journal, manager, listener } = scenario();
  execute.mockResolvedValue({
    data: 1,
    snapshotSeq: '0',
    dependencies: [dependency],
  });
  const id = await manager.subscribe(principal, 'stocks.list', {}, listener);
  journal.currentSeq.mockResolvedValue('4');
  journal.readBatch.mockResolvedValue({
    changes: [{ ...change, documentId: 'unrelated-stock' }],
    coveredSeq: '4',
  });
  manager.reconcileAll();
  await vi.waitFor(() => expect(journal.readBatch).toHaveBeenCalledTimes(1));
  manager.reconcileAll();
  await Promise.resolve();
  expect(journal.readBatch).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(1);
  manager.unsubscribe(id);
});

it('releases an initializing subscription if the connection closes', async () => {
  const { execute, manager, listener } = scenario();
  const pending = deferredQuery();
  execute.mockReturnValueOnce(pending.promise);
  const connection = new AbortController();
  const subscribed = manager.subscribe(
    principal,
    'stocks.list',
    {},
    listener,
    connection.signal,
  );
  connection.abort();
  pending.resolve({ data: 1, snapshotSeq: '1', dependencies: [dependency] });
  await expect(subscribed).rejects.toThrow('Subscription closed');
  manager.invalidate(change);
  expect(listener).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledTimes(1);
});
