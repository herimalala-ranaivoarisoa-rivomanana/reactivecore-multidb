import { MutationEngineService } from './mutation-engine.service.js';
import type { MutationRegistryService } from './mutation-registry.service.js';

const scope = {
  tenantId: 'tenant',
  principalId: 'user',
  name: 'items.create',
  idempotencyKey: 'key',
};

function scenario() {
  const transaction = vi.fn();
  const engine = new MutationEngineService(
    {
      transaction,
      retryReason: (error) => {
        const code = (error as { code: string }).code;
        if (code === 'serialization' || code === 'deadlock') return code;
      },
    },
    {} as MutationRegistryService,
  );
  return { engine, transaction };
}

it('retries the whole transaction on serialization failures and deadlocks', async () => {
  const { engine, transaction } = scenario();
  transaction
    .mockRejectedValueOnce({ code: 'serialization' })
    .mockRejectedValueOnce({ code: 'deadlock' })
    .mockResolvedValueOnce('committed');
  const write = vi.fn();
  await expect(engine.runSerializable(scope, write)).resolves.toBe('committed');
  expect(engine.retryMetrics()).toEqual({
    serializationFailures: 1,
    deadlocks: 1,
    retries: 2,
    exhausted: 0,
  });
  expect(transaction.mock.calls).toEqual(
    Array.from({ length: 3 }, () => [scope, write]),
  );
});

it('surfaces an ambiguous connection failure without automatically retrying', async () => {
  const { engine, transaction } = scenario();
  const error = Object.assign(new Error('connection lost'), {
    code: 'connection lost',
  });
  transaction.mockRejectedValue(error);
  await expect(engine.runSerializable(scope, vi.fn())).rejects.toBe(error);
  expect(transaction).toHaveBeenCalledTimes(1);
});

it('bounds retries and reports an exhausted transaction as unavailable', async () => {
  const { engine, transaction } = scenario();
  transaction.mockRejectedValue({ code: 'serialization' });
  await expect(engine.runSerializable(scope, vi.fn())).rejects.toHaveProperty(
    'status',
    503,
  );
  expect(transaction).toHaveBeenCalledTimes(6);
  expect(engine.retryMetrics()).toEqual({
    serializationFailures: 6,
    deadlocks: 0,
    retries: 5,
    exhausted: 1,
  });
});
