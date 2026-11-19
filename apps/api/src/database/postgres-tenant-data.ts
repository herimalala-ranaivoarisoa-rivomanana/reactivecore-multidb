import type { PoolClient } from 'pg';
import {
  matchedTenantRow,
  updateColumns,
  versionedWrites,
  type GetRow,
  type RowValue,
  type TenantReader,
  type TenantWriter,
} from './tenant-data.js';
import { tenantListSql } from './tenant-list-sql.js';
import { tenantReportSql } from './tenant-report-sql.js';

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
  async function read<Row extends Record<string, unknown>>(
    { table, id, columns }: GetRow,
    lock: boolean,
  ): Promise<Row | null> {
    if (!columns.length) throw new Error('A get requires columns');
    const { rows } = await client.query<Row>(
      `SELECT ${columns.map(identifier).join(', ')}
       FROM public.${identifier(table)} WHERE tenant_id = $1 AND id = $2 LIMIT 2 ${lock ? 'FOR UPDATE' : ''}`,
      [tenantId, id],
    );
    return matchedTenantRow(rows.length) ? rows[0] : null;
  }

  const data: TenantReader &
    Pick<TenantWriter, 'getForUpdate' | 'insert' | 'update' | 'delete'> = {
    get: (request) => read(request, false),
    getForUpdate: (request) => read(request, true),

    async report(request) {
      const values: RowValue[] = [tenantId];
      const sql = tenantReportSql(request, {
        identifier,
        table: (table) => `public.${identifier(table)}`,
        tenantParameter: '$1',
        bind: (value) => `$${values.push(value)}`,
        asText: (expression) => `CAST(${expression} AS TEXT)`,
      });
      const { rows } = await client.query(sql, values);
      return rows;
    },

    async list(request) {
      const values: RowValue[] = [tenantId];
      const bind = (value: RowValue) => `$${values.push(value)}`;
      const sql = tenantListSql(request, identifier, bind);
      const limit = bind(request.limit);
      const offset =
        request.offset === undefined ? '' : `OFFSET ${bind(request.offset)}`;
      const { rows } = await client.query(
        `SELECT ${sql.projection} FROM public.${identifier(request.table)}
         WHERE tenant_id = $1 ${sql.predicate} ${sql.order} LIMIT ${limit} ${offset}`,
        values,
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
    ...versionedWrites(
      data,
      async (table, id) =>
        (
          await data.getForUpdate<{ version: number }>({
            table,
            id,
            columns: ['version'],
          })
        )?.version ?? null,
    ),
  };
}
