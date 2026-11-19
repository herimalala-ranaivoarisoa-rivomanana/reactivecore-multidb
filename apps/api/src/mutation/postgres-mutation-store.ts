import { GoneException } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { postgresTenantData } from '../database/postgres-tenant-data.js';
import { DatabaseService } from '../database/database.service.js';
import { MutationCommitService } from './mutation-commit.service.js';
import {
  MutationStore,
  type MutationRetryReason,
  type MutationScope,
  type MutationTransaction,
} from './mutation-store.js';

import { PostgresMutationAdmission } from './postgres-mutation-admission.js';

@Injectable()
export class PostgresMutationStore extends MutationStore {
  private readonly admission = new PostgresMutationAdmission(
    Number(process.env.RC_PG_MUTATION_CONCURRENCY ?? 0),
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly commit: MutationCommitService,
  ) {
    super();
  }

  retryReason(error: unknown): MutationRetryReason | undefined {
    const code = (error as { code?: string } | null)?.code;
    if (code === '40001') return 'serialization';
    if (code === '40P01') return 'deadlock';
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
    return this.admission.run(() =>
      this.database.serializableTenantTransaction(
        scope.tenantId,
        async (client) => {
          await client.query(
            "SELECT set_config('app.principal_id', $1::uuid::text, true)",
            [scope.principalId],
          );
          return run({
            client,
            data: postgresTenantData(client, scope.tenantId),
            async reserve(requestHash) {
              const reserved = await client.query(
                `INSERT INTO mutation_execution_receipts
               (tenant_id, principal_id, mutation_name, idempotency_key, request_hash)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
                [...key, requestHash],
              );
              if (reserved.rowCount !== 0) return;

              const {
                rows: [receipt],
              } = await client.query<{
                request_hash: string;
                response: unknown;
                response_expired: boolean;
                commit_seq: string | null;
              }>(
                `SELECT request_hash, response, response_expired, commit_seq::text FROM mutation_execution_receipts
             WHERE tenant_id = $1 AND principal_id = $2 AND mutation_name = $3 AND idempotency_key = $4`,
                key,
              );
              if (!receipt?.commit_seq)
                throw new Error('Incomplete mutation receipt');
              if (receipt.response_expired)
                throw new GoneException(
                  'Mutation response retention has expired',
                );
              return {
                requestHash: receipt.request_hash,
                response: receipt.response,
                commitSeq: receipt.commit_seq,
              };
            },
            complete: async (response, changes) => {
              const seq = await this.commit.commitChanges(
                client,
                scope.tenantId,
                changes,
              );
              const completed = await client.query(
                `UPDATE mutation_execution_receipts SET response = $5::jsonb, commit_seq = $6
             WHERE tenant_id = $1 AND principal_id = $2 AND mutation_name = $3 AND idempotency_key = $4`,
                [...key, response, seq],
              );
              if (completed.rowCount !== 1)
                throw new Error('Mutation receipt could not be completed');
              return seq;
            },
          });
        },
      ),
    );
  }
}
