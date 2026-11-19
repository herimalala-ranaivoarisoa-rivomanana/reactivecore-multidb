import type { PoolClient } from 'pg';
import {
  matchedTenantRow,
  updateColumns,
  versionedWrites,
  type TenantReader,
  type TenantWriter,
} from './tenant-data.js';

function identifier(name: string): string {
  if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(name))
    throw new Error(
      'Expected a lowercase SQL identifier of at most 63 characters',
    );
  return `"${name}"`;
}

/** Adapts the existing PostgreSQL transaction without borrowing another connection. */
export function postgresTenantData(
  client: PoolClient,
  tenantId: string,
): TenantReader & TenantWriter {
  const data: TenantReader &
    Pick<TenantWriter, 'insert' | 'update' | 'delete'> = {
    async get({ table, id, columns }) {
      if (!columns.length) throw new Error('A get requires columns');
      const { rows } = await client.query(
        `SELECT ${columns.map(identifier).join(', ')}
         FROM public.${identifier(table)} WHERE tenant_id = $1 AND id = $2 LIMIT 2`,
        [tenantId, id],
      );
      return matchedTenantRow(rows.length) ? rows[0] : null;
    },

    async list({ table, columns, orderBy, limit }) {
      if (!columns.length || !Number.isSafeInteger(limit) || limit < 1)
        throw new Error('A list requires columns and a positive integer limit');

      const order = orderBy?.map(({ column, direction }) => {
        if (direction !== 'asc' && direction !== 'desc')
          throw new Error('Unsupported sort direction');
        return `${identifier(column)} ${direction}`;
      });

      const { rows } = await client.query(
        `SELECT ${columns.map(identifier).join(', ')}
         FROM public.${identifier(table)} WHERE tenant_id = $1
         ${order?.length ? `ORDER BY ${order.join(', ')}` : ''}
         LIMIT $2`,
        [tenantId, limit],
      );
      return rows;
    },

    async insert(table, values) {
      const columns = Object.keys(values);
      if (!columns.length || columns.includes('tenant_id'))
        throw new Error(
          'An insert requires application columns and supplies tenant_id automatically',
        );

      const placeholders = columns.map((_, index) => `$${index + 2}`);
      await client.query(
        `INSERT INTO public.${identifier(table)} (tenant_id, ${columns.map(identifier).join(', ')})
         VALUES ($1, ${placeholders.join(', ')})`,
        [tenantId, ...columns.map((column) => values[column])],
      );
    },

    async update(table, id, values) {
      const columns = updateColumns(values);
      const assignments = columns.map(
        (column, index) => `${identifier(column)} = $${index + 3}`,
      );
      const result = await client.query(
        `UPDATE public.${identifier(table)} SET ${assignments.join(', ')}
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id, ...columns.map((column) => values[column])],
      );
      return matchedTenantRow(result.rowCount);
    },

    async delete(table, id) {
      const result = await client.query(
        `DELETE FROM public.${identifier(table)} WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      return matchedTenantRow(result.rowCount);
    },
  };

  return {
    ...data,
    ...versionedWrites(data, async (table, id) => {
      const { rows } = await client.query<{ version: number }>(
        `SELECT version FROM public.${identifier(table)} WHERE tenant_id = $1 AND id = $2 LIMIT 2 FOR UPDATE`,
        [tenantId, id],
      );
      return matchedTenantRow(rows.length) ? rows[0].version : null;
    }),
  };
}
