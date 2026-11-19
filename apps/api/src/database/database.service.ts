import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { postgresTenantData } from './postgres-tenant-data.js';
import type { QueryContext } from '../reactive/contracts/query-context.js';
import type { QuerySnapshotStore } from '../reactive/contracts/query-snapshot-store.js';

@Injectable()
export class DatabaseService implements OnModuleDestroy, QuerySnapshotStore {
  private readonly pool: Pool;

  constructor(@Optional() connectionString = process.env.DATABASE_URL) {
    if (!connectionString) {
      throw new Error('DATABASE_URL is required');
    }

    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this.pool.on('error', (error) => {
      console.error('Idle PostgreSQL client error:', error);
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params);
  }

  async transaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.runTransaction(
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      callback,
    );
  }

  private async runTransaction<T>(
    begin: string,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();

    let discard: Error | undefined;
    try {
      await client.query(begin);

      const result = await callback(client);

      await client.query('COMMIT');

      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discard = new Error('Rollback failed', { cause: rollbackError });
        console.error(discard);
      }

      throw error;
    } finally {
      client.release(discard);
    }
  }

  async tenantTransaction<T>(
    tenantId: string,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction((client) =>
      this.withTenant(client, tenantId, callback),
    );
  }

  async serializableTenantTransaction<T>(
    tenantId: string,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.runTransaction('BEGIN ISOLATION LEVEL SERIALIZABLE', (client) =>
      this.withTenant(client, tenantId, callback),
    );
  }

  async readOnlyTenantTransaction<T>(
    tenantId: string,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.runTransaction(
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      (client) => this.withTenant(client, tenantId, callback),
    );
  }

  async snapshotTenantTransaction<T>(
    tenantId: string,
    callback: (
      access: Pick<QueryContext, 'client' | 'data' | 'mysqlSql'>,
      snapshotSeq: string,
    ) => Promise<T>,
  ): Promise<T> {
    return this.readOnlyTenantTransaction(tenantId, async (client) =>
      callback(
        { client, data: postgresTenantData(client, tenantId) },
        await this.currentCommitSeq(client),
      ),
    );
  }

  async currentCommitSeq(
    client: PoolClient | Pool = this.pool,
  ): Promise<string> {
    const { rows } = await client.query<{ seq: string }>(
      'SELECT last_seq::text AS seq FROM public.reactive_commit_clock WHERE id = 1',
    );
    if (!rows[0]) throw new Error('Commit clock unavailable');
    return rows[0].seq;
  }

  private async withTenant<T>(
    client: PoolClient,
    tenantId: string,
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const role = await client.query<{ safe: boolean }>(
      `SELECT current_user = 'reactivecore_app'
              AND NOT rolsuper AND NOT rolbypassrls AS safe
       FROM pg_roles WHERE rolname = current_user`,
    );
    if (!role.rows[0]?.safe) {
      throw new Error(
        'Tenant transactions require the restricted reactivecore_app role',
      );
    }
    await client.query(
      "SELECT set_config('app.tenant_id', $1::uuid::text, true)",
      [tenantId],
    );
    return callback(client);
  }

  async ping(): Promise<boolean> {
    const result = await this.query('SELECT 1 AS connected');

    return result.rows[0]?.connected === 1;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
