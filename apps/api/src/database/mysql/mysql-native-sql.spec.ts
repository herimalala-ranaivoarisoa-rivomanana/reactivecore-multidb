import type { PoolConnection } from 'mysql2/promise';
import { mysqlNativeSql } from './mysql-native-sql.js';

afterEach(() => vi.unstubAllEnvs());

it('requires project opt-in and binds SQL values on the same connection', async () => {
  const execute = vi.fn().mockResolvedValue([[{ count: '2' }]]);
  const connection = { execute } as unknown as PoolConnection;
  vi.stubEnv('RC_MYSQL_NATIVE_SQL', undefined);
  expect(mysqlNativeSql(connection, false)).toBeUndefined();

  vi.stubEnv('RC_MYSQL_NATIVE_SQL', '1');
  const sql = mysqlNativeSql(connection, false)!;
  const statement = 'SELECT COUNT(*) AS count FROM items WHERE tenant_id = ?';
  expect(await sql.execute(statement, ['tenant-a'])).toEqual({
    rows: [{ count: '2' }],
    affectedRows: 0,
  });
  expect(execute).toHaveBeenCalledWith(statement, ['tenant-a']);
});

it('rejects mutation SQL in reads and transaction control in mutations', async () => {
  vi.stubEnv('RC_MYSQL_NATIVE_SQL', '1');
  const execute = vi.fn();
  const connection = { execute } as unknown as PoolConnection;
  await expect(
    mysqlNativeSql(connection, false)!.execute('UPDATE items SET title = ?'),
  ).rejects.toThrow('Unsupported native MySQL statement');
  await expect(
    mysqlNativeSql(connection, true)!.execute('COMMIT'),
  ).rejects.toThrow('Unsupported native MySQL statement');
  expect(execute).not.toHaveBeenCalled();
});
