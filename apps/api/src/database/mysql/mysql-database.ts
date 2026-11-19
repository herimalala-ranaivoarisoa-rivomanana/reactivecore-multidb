import { isIP } from 'node:net';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  createPool,
  type PoolConnection,
  type RowDataPacket,
} from 'mysql2/promise';

@Injectable()
export class MysqlDatabase implements OnModuleDestroy {
  private readonly pool;

  constructor() {
    const uri = process.env.DATABASE_URL;
    if (!uri) throw new Error('DATABASE_URL is required');
    const url = new URL(uri);
    const tls = url.searchParams.get('ssl');
    if (
      [...url.searchParams.keys()].some((key) => key !== 'ssl') ||
      (tls !== null && tls !== 'verify-full')
    ) {
      throw new Error('MySQL DATABASE_URL supports only ssl=verify-full');
    }
    if (tls && isIP(url.hostname.replace(/^\[|\]$/g, '')))
      throw new Error('Use the certificate DNS hostname for MySQL TLS');
    url.search = '';
    this.pool = createPool({
      uri: url.href,
      connectTimeout: 5000,
      connectionLimit: 10,
      supportBigNumbers: true,
      bigNumberStrings: true,
      ...(tls
        ? { ssl: { rejectUnauthorized: true, verifyIdentity: true } }
        : {}),
    });
  }

  async transaction<T>(
    run: (connection: PoolConnection) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    let reusable = true;
    try {
      if (readOnly) {
        await connection.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
        );
        await connection.query(
          'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
        );
      } else {
        await connection.beginTransaction();
      }
      const result = await run(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        reusable = false;
        connection.destroy();
      }
      throw error;
    } finally {
      if (reusable) connection.release();
    }
  }

  async currentSeq(
    connection: PoolConnection | typeof this.pool = this.pool,
  ): Promise<string> {
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT last_seq AS seq FROM rc_commit_clock WHERE id = 1',
    );
    if (!rows[0]) throw new Error('Commit clock unavailable');
    return String(rows[0].seq);
  }

  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }

  async assertAccount(
    role: 'reactivecore_worker' | 'reactivecore_app',
  ): Promise<void> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT CURRENT_USER() AS account',
    );
    if (!String(rows[0]?.account).startsWith(role + '@'))
      throw new Error(`MySQL requires the dedicated ${role} account`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
