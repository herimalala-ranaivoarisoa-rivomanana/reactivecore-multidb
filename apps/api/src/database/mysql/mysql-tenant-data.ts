import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { mysqlIdentifier } from '../database-engine.js';
import {
  matchedTenantRow,
  updateColumns,
  versionedWrites,
  type GetRow,
  type RowValue,
  type TenantReader,
  type TenantWriter,
} from '../tenant-data.js';
import { tenantListSql } from '../tenant-list-sql.js';
import { tenantReportSql } from '../tenant-report-sql.js';

export function mysqlTenantData(
  connection: PoolConnection,
  tenantId: string,
): TenantReader & TenantWriter {
  function tableName(table: string) {
    if (
      table.startsWith('rc_') ||
      !process.env.RC_MYSQL_TABLES?.split(',').includes(table)
    )
      throw new Error('MySQL application table is not registered');
    return mysqlIdentifier(table);
  }

  async function read<Row extends Record<string, unknown>>(
    { table, id, columns }: GetRow,
    lock: boolean,
  ): Promise<Row | null> {
    if (!columns.length) throw new Error('A get requires columns');
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT ${columns.map(mysqlIdentifier).join(', ')}
       FROM ${tableName(table)} WHERE tenant_id = ? AND id = ? LIMIT 2 ${lock ? 'FOR UPDATE' : ''}`,
      [tenantId, id],
    );
    return matchedTenantRow(rows.length) ? (rows[0] as Row) : null;
  }

  const data: TenantReader &
    Pick<TenantWriter, 'getForUpdate' | 'insert' | 'update' | 'delete'> = {
    get: (request) => read(request, false),
    getForUpdate: (request) => read(request, true),

    async report(request) {
      const values: RowValue[] = [tenantId];
      const sql = tenantReportSql(request, {
        identifier: mysqlIdentifier,
        table: tableName,
        tenantParameter: '?',
        bind: (value) => {
          values.push(value);
          return '?';
        },
        asText: (expression) => `CAST(${expression} AS CHAR)`,
      });
      const [rows] = await connection.execute<RowDataPacket[]>(sql, values);
      return rows;
    },

    async list<Row extends Record<string, unknown>>(
      request: Parameters<TenantReader['list']>[0],
    ) {
      const values: RowValue[] = [tenantId];
      const sql = tenantListSql(request, mysqlIdentifier, (value) => {
        values.push(value);
        return '?';
      });
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT ${sql.projection} FROM ${tableName(request.table)}
         WHERE tenant_id = ? ${sql.predicate} ${sql.order}
         LIMIT ${request.limit} ${request.offset === undefined ? '' : `OFFSET ${request.offset}`}`,
        values,
      );
      return rows as Row[];
    },

    async insert(table, values) {
      const columns = Object.keys(values);
      if (!columns.length || columns.includes('tenant_id'))
        throw new Error(
          'An insert requires application columns and supplies tenant_id automatically',
        );
      await connection.execute(
        `INSERT INTO ${tableName(table)} (tenant_id, ${columns.map(mysqlIdentifier).join(', ')})
         VALUES (?, ${columns.map(() => '?').join(', ')})`,
        [tenantId, ...columns.map((column) => values[column])],
      );
    },

    async update(table, id, values) {
      const columns = updateColumns(values);
      const assignments = columns.map(
        (column) => `${mysqlIdentifier(column)} = ?`,
      );
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE ${tableName(table)} SET ${assignments.join(', ')} WHERE tenant_id = ? AND id = ?`,
        [...columns.map((column) => values[column]), tenantId, id],
      );
      return matchedTenantRow(result.affectedRows);
    },

    async delete(table, id) {
      const [result] = await connection.execute<ResultSetHeader>(
        `DELETE FROM ${tableName(table)} WHERE tenant_id = ? AND id = ?`,
        [tenantId, id],
      );
      return matchedTenantRow(result.affectedRows);
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
