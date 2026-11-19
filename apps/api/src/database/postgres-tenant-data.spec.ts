import type { PoolClient } from 'pg';
import { postgresTenantData } from './postgres-tenant-data.js';

function access() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return {
    query,
    data: postgresTenantData({ query } as unknown as PoolClient, 'tenant-a'),
  };
}

it('binds the tenant and write values on the supplied transaction', async () => {
  const { query, data } = access();
  await data.list({ table: 'items', columns: ['id', 'title'], limit: 10 });
  expect(query).toHaveBeenNthCalledWith(
    1,
    expect.stringContaining('WHERE tenant_id = $1'),
    ['tenant-a', 10],
  );
  await data.insert('items', { id: 'item-a', title: 'A title' });
  expect(query).toHaveBeenNthCalledWith(
    2,
    expect.stringContaining('VALUES ($1, $2, $3)'),
    ['tenant-a', 'item-a', 'A title'],
  );
});

it('rejects a tenant override and unsupported identifiers before issuing SQL', async () => {
  const { query, data } = access();
  await expect(data.insert('items', { tenant_id: 'tenant-b' })).rejects.toThrow(
    'tenant_id',
  );
  await expect(
    data.list({ table: 'other.items', columns: ['id'], limit: 10 }),
  ).rejects.toThrow('identifier');
  expect(query).not.toHaveBeenCalled();
});
