import { mysqlNativeSql } from './mysql-native-sql.js';
import { Injectable } from '@nestjs/common';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  MutationStore,
  type MutationScope,
  type MutationTransaction,
  type MutationRetryReason,
} from '../../mutation/mutation-store.js';
import { mysqlLegacyClient } from '../database-engine.js';
import { MysqlDatabase } from './mysql-database.js';
import { mysqlTenantData } from './mysql-tenant-data.js';

function errorCode(error: unknown) {
  return (error as { code?: string } | null)?.code;
}

@Injectable()
export class MysqlMutationStore extends MutationStore {
  constructor(private readonly database: MysqlDatabase) {
    super();
  }

  retryReason(error: unknown): MutationRetryReason | undefined {
    return errorCode(error) === 'ER_LOCK_DEADLOCK' ? 'deadlock' : undefined;
  }

  transaction<T>(
    scope: MutationScope,
    run: (transaction: MutationTransaction) => Promise<T>,
  ): Promise<T> {
    const key = [
      scope.tenantId,
      scope.principalId,
      scope.name,
      scope.idempotencyKey,
    ];
    return this.database.transaction(async (connection) =>
      run({
        get client() {
          return mysqlLegacyClient();
        },
        mysqlSql: mysqlNativeSql(connection, true),
        data: mysqlTenantData(connection, scope.tenantId),
        async reserve(requestHash) {
          try {
            await connection.execute(
              'INSERT INTO rc_receipts (tenant_id, principal_id, mutation_name, idempotency_key, request_hash) VALUES (?, ?, ?, ?, ?)',
              [...key, requestHash],
            );
            return;
          } catch (error) {
            if (errorCode(error) !== 'ER_DUP_ENTRY') throw error;
          }
          const [rows] = await connection.execute<RowDataPacket[]>(
            `SELECT request_hash, response, commit_seq FROM rc_receipts
           WHERE tenant_id = ? AND principal_id = ? AND mutation_name = ? AND idempotency_key = ? FOR UPDATE`,
            key,
          );
          const receipt = rows[0];
          if (receipt?.commit_seq == null)
            throw new Error('Incomplete mutation receipt');
          return {
            requestHash: receipt.request_hash,
            response: receipt.response,
            commitSeq: String(receipt.commit_seq),
          };
        },
        complete: async (response, changes) => {
          if (changes.length === 0 || changes.length > 100)
            throw new Error('Expected between 1 and 100 changes');

          await connection.query(
            'UPDATE rc_commit_clock SET last_seq = last_seq + 1 WHERE id = 1',
          );
          const seq = await this.database.currentSeq(connection);
          for (const [ordinal, change] of changes.entries()) {
            await connection.execute(
              `INSERT INTO rc_changes
               (seq, ordinal, event_id, tenant_id, table_name, document_id, operation, before_data, after_data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                seq,
                ordinal,
                change.eventId,
                scope.tenantId,
                change.table,
                change.documentId,
                change.operation,
                JSON.stringify(change.before ?? null),
                JSON.stringify(change.after ?? null),
              ],
            );
            await connection.execute(
              'INSERT INTO rc_outbox (event_id, tenant_id, event_type, aggregate_id, payload) VALUES (?, ?, ?, ?, ?)',
              [
                change.eventId,
                scope.tenantId,
                'reactive.changed',
                change.documentId,
                JSON.stringify({
                  ...change,
                  tenantId: scope.tenantId,
                  schemaVersion: 1,
                  commitSeq: seq,
                }),
              ],
            );
          }
          const [result] = await connection.execute<ResultSetHeader>(
            `UPDATE rc_receipts SET response = ?, commit_seq = ?
           WHERE tenant_id = ? AND principal_id = ? AND mutation_name = ? AND idempotency_key = ?`,
            [response, seq, ...key],
          );
          if (result.affectedRows !== 1)
            throw new Error('Mutation receipt could not be completed');
          return seq;
        },
      }),
    );
  }
}
