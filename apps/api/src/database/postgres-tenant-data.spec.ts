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

it('binds list filters and offsets with a unique pagination order', async () => {
  const { query, data } = access();
  await data.list({
    table: 'items',
    columns: ['id'],
    where: [
      { column: 'title', op: 'eq', value: "A user's title" },
      { column: 'reserved_by', op: 'eq', value: null },
      { column: 'version', op: 'gte', value: 1 },
    ],
    orderBy: [{ column: 'title', direction: 'asc' }],
    limit: 5,
    offset: 2,
  });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining(
      'AND "title" = $2 AND "reserved_by" IS NULL AND "version" >= $3 ORDER BY "title" asc, "id" asc',
    ),
    ['tenant-a', "A user's title", 1, 5, 2],
  );
});

it('scopes every join in ON and binds the root tenant ahead of report filters', async () => {
  const { data, query } = access();
  await data.report({
    from: { table: 'items', as: 'i' },
    joins: [
      {
        table: 'charges',
        as: 'c',
        type: 'left',
        on: { left: 'i.id', right: 'item_id' },
      },
      {
        table: 'payments',
        as: 'p',
        type: 'inner',
        on: { left: 'c.id', right: 'charge_id' },
      },
    ],
    groupBy: [{ column: 'i.title', as: 'title' }],
    aggregates: [{ fn: 'sum', column: 'p.amount', as: 'total' }],
    where: [{ column: 'c.period', op: 'eq', value: '2026-11' }],
    limit: 30,
  });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining('AND "c"."tenant_id" = "i"."tenant_id"'),
    ['tenant-a', '2026-11'],
  );
  const sql = query.mock.calls[0][0];
  expect(sql).toContain('AND "p"."tenant_id" = "i"."tenant_id"');
  expect(sql).toContain('WHERE "i"."tenant_id" = $1');
  expect(sql).toContain('"c"."period" = $2');
});
