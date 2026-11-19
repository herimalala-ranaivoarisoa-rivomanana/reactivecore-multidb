import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service.js';
import type { ChangeFeed } from '../contracts/change-feed.js';
import type { ChangeDescriptor } from '../contracts/dependency.types.js';

export type JournalChange = Omit<ChangeDescriptor, 'tenantId'> & {
  eventId: string;
};

interface JournalRow {
  seq: string;
  ordinal: number;
  event_id: string;
  table_name: string;
  document_id: string;
  operation: ChangeDescriptor['operation'];
  before_data: ChangeDescriptor['before'];
  after_data: ChangeDescriptor['after'];
}

@Injectable()
export class ChangeLogService implements ChangeFeed {
  constructor(private readonly database: DatabaseService) {}

  /** Allocates a commit sequence and appends changes using the caller’s transaction. */
  async append(
    client: PoolClient,
    changes: readonly JournalChange[],
  ): Promise<string> {
    const { rows } = await client.query<{ seq: string }>(
      'SELECT public.reactive_append_changes($1::jsonb)::text AS seq',
      [JSON.stringify(changes)],
    );
    return rows[0].seq;
  }

  currentSeq(): Promise<string> {
    return this.database.currentCommitSeq();
  }

  async hasChanges(
    tenantId: string,
    afterSeq: string,
    throughSeq: string,
  ): Promise<boolean> {
    if (BigInt(afterSeq) >= BigInt(throughSeq)) return false;
    return this.database.readOnlyTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<{ changed: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM public.reactive_change_log
           WHERE tenant_id = $1 AND seq > $2::bigint AND seq <= $3::bigint
         ) AS changed`,
        [tenantId, afterSeq, throughSeq],
      );
      return rows[0].changed;
    });
  }

  /** Reads up to 100 whole commit sequences and returns the high-water mark covered by the batch. */
  async readBatch(tenantId: string, afterSeq: string, throughSeq: string) {
    const limit = 100;
    const changes = await this.readAfter(tenantId, afterSeq, throughSeq, limit);
    const full = new Set(changes.map(({ seq }) => seq)).size === limit;
    return {
      changes,
      coveredSeq: full ? changes[changes.length - 1].seq : throughSeq,
    };
  }

  /** Reads changes in (afterSeq, throughSeq], limiting whole commit sequences when requested. */
  async readAfter(
    tenantId: string,
    afterSeq: string,
    throughSeq: string,
    limit?: number,
  ) {
    return this.database.readOnlyTenantTransaction(tenantId, async (client) => {
      const { rows } = await client.query<JournalRow>(
        `WITH commits AS (
           SELECT DISTINCT seq FROM public.reactive_change_log
           WHERE tenant_id = $1 AND seq > $2::bigint AND seq <= $3::bigint
           ORDER BY seq LIMIT $4
         )
         SELECT log.seq::text, ordinal, event_id, table_name, document_id,
                operation, before_data, after_data
         FROM public.reactive_change_log AS log JOIN commits USING (seq)
         WHERE log.tenant_id = $1
         ORDER BY log.seq, ordinal`,
        [tenantId, afterSeq, throughSeq, limit ?? null],
      );
      return rows.map((row) => ({
        seq: row.seq,
        ordinal: row.ordinal,
        eventId: row.event_id,
        tenantId,
        table: row.table_name,
        documentId: row.document_id,
        operation: row.operation,
        before:
          row.operation === 'insert' ? null : (row.before_data ?? undefined),
        after:
          row.operation === 'delete' ? null : (row.after_data ?? undefined),
      }));
    });
  }
}
