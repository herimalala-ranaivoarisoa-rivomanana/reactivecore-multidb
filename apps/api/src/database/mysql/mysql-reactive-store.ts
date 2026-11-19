import { Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import type {
  ChangeFeed,
  SequencedChange,
} from '../../reactive/contracts/change-feed.js';
import type { QueryContext } from '../../reactive/contracts/query-context.js';
import type { QuerySnapshotStore } from '../../reactive/contracts/query-snapshot-store.js';
import { mysqlLegacyClient } from '../database-engine.js';
import { MysqlDatabase } from './mysql-database.js';
import { mysqlTenantData } from './mysql-tenant-data.js';

@Injectable()
export class MysqlReactiveStore implements QuerySnapshotStore, ChangeFeed {
  constructor(private readonly database: MysqlDatabase) {}

  snapshotTenantTransaction<T>(
    tenantId: string,
    run: (
      access: Pick<QueryContext, 'client' | 'data'>,
      seq: string,
    ) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(
      async (connection) =>
        run(
          {
            get client() {
              return mysqlLegacyClient();
            },
            data: mysqlTenantData(connection, tenantId),
          },
          await this.database.currentSeq(connection),
        ),
      true,
    );
  }

  currentSeq(): Promise<string> {
    return this.database.currentSeq();
  }

  async hasChanges(
    tenantId: string,
    afterSeq: string,
    throughSeq: string,
  ): Promise<boolean> {
    if (BigInt(afterSeq) >= BigInt(throughSeq)) return false;
    return this.database.transaction(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT 1 FROM rc_changes WHERE tenant_id = ? AND seq > CAST(? AS UNSIGNED) AND seq <= CAST(? AS UNSIGNED) LIMIT 1',
        [tenantId, afterSeq, throughSeq],
      );
      return rows.length > 0;
    }, true);
  }

  async readBatch(tenantId: string, afterSeq: string, throughSeq: string) {
    const limit = 100;
    return this.database.transaction(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `WITH commits AS (
           SELECT DISTINCT seq FROM rc_changes
           WHERE tenant_id = ? AND seq > CAST(? AS UNSIGNED) AND seq <= CAST(? AS UNSIGNED)
           ORDER BY seq LIMIT ${limit}
         )
         SELECT log.seq, ordinal, event_id, table_name, document_id, operation, before_data, after_data
         FROM rc_changes AS log JOIN commits USING (seq)
         WHERE log.tenant_id = ? ORDER BY log.seq, ordinal`,
        [tenantId, afterSeq, throughSeq, tenantId],
      );
      const changes: SequencedChange[] = rows.map((row) => ({
        seq: String(row.seq),
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
      const full = new Set(changes.map(({ seq }) => seq)).size === limit;
      return {
        changes,
        coveredSeq: full ? changes[changes.length - 1].seq : throughSeq,
      };
    }, true);
  }
}
