import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import { mysqlIdentifier } from '../database-engine.js';
import {
  matchedTenantRow,
  updateColumns,
  type GetRow,
  type TenantReader,
  type TenantWriter,
} from '../tenant-data.js';

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

  return {
    async get<Row extends Record<string, unknown>>({
      table,
      id,
      columns,
    }: GetRow) {
      if (!columns.length) throw new Error('A get requires columns');
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT ${columns.map(mysqlIdentifier).join(', ')}
         FROM ${tableName(table)} WHERE tenant_id = ? AND id = ? LIMIT 2`,
        [tenantId, id],
      );
      return matchedTenantRow(rows.length) ? (rows[0] as Row) : null;
    },

    async list<Row extends Record<string, unknown>>({
      table,
      columns,
      orderBy,
      limit,
    }: Parameters<TenantReader['list']>[0]) {
      if (!columns.length || !Number.isSafeInteger(limit) || limit < 1)
        throw new Error('A list requires columns and a positive integer limit');
      const order = orderBy?.map(({ column, direction }) => {
        if (direction !== 'asc' && direction !== 'desc')
          throw new Error('Unsupported sort direction');
        return `${mysqlIdentifier(column)} ${direction}`;
      });
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT ${columns.map(mysqlIdentifier).join(', ')} FROM ${tableName(table)}
         WHERE tenant_id = ? ${order?.length ? `ORDER BY ${order.join(', ')}` : ''} LIMIT ${limit}`,
        [tenantId],
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
}
