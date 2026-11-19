import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import type { RowValue } from '../tenant-data.js';

export interface MysqlNativeSql {
  /**
   * Runs one prepared statement in the current transaction.
   * The caller must scope all tables and writes to the verified tenant.
   */
  execute(
    sql: string,
    values?: readonly RowValue[],
  ): Promise<{
    rows: Record<string, unknown>[];
    affectedRows: number;
  }>;
}

/** Enables engine-specific SQL only when the project operator opts in. */
export function mysqlNativeSql(
  connection: PoolConnection,
  writable: boolean,
): MysqlNativeSql | undefined {
  if (process.env.RC_MYSQL_NATIVE_SQL !== '1') return;
  return {
    async execute(sql, values = []) {
      const allowed = writable
        ? /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i
        : /^\s*SELECT\b/i;
      if (!allowed.test(sql))
        throw new Error(
          'Unsupported native MySQL statement for this transaction',
        );
      const [result] = await connection.execute<
        RowDataPacket[] | ResultSetHeader
      >(sql, [...values]);
      return Array.isArray(result)
        ? { rows: result, affectedRows: 0 }
        : { rows: [], affectedRows: result.affectedRows };
    },
  };
}
