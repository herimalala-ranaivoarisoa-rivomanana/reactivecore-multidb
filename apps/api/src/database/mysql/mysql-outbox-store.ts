import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { OutboxStore, type OutboxLease } from '../../outbox/outbox-store.js';
import { MysqlDatabase } from './mysql-database.js';

@Injectable()
export class MysqlOutboxStore extends OutboxStore {
  constructor(private readonly database: MysqlDatabase) {
    super();
  }

  assertWorkerAccess(): Promise<void> {
    return this.database.assertAccount('reactivecore_worker');
  }

  claim(): Promise<OutboxLease | undefined> {
    return this.database.transaction(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT event_id, tenant_id, event_type, aggregate_id, payload FROM rc_outbox
         WHERE published_at IS NULL AND available_at <= CURRENT_TIMESTAMP(6)
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const row = rows[0];
      if (!row) return;
      const token = randomUUID();
      await connection.execute(
        `UPDATE rc_outbox SET lease_token = ?, available_at = TIMESTAMPADD(SECOND, 30, CURRENT_TIMESTAMP(6)),
           attempts = attempts + 1 WHERE event_id = ?`,
        [token, row.event_id],
      );
      return {
        token,
        event: {
          eventId: row.event_id,
          tenantId: row.tenant_id,
          type: row.event_type,
          aggregateId: row.aggregate_id,
          payload: row.payload,
        },
      };
    });
  }

  async retry({ event, token }: OutboxLease): Promise<void> {
    await this.database.transaction(async (connection) => {
      await connection.execute(
        `UPDATE rc_outbox SET lease_token = NULL,
           available_at = TIMESTAMPADD(SECOND, LEAST(attempts, 30), CURRENT_TIMESTAMP(6))
         WHERE event_id = ? AND lease_token = ?`,
        [event.eventId, token],
      );
    });
  }

  async acknowledge({ event, token }: OutboxLease): Promise<void> {
    await this.database.transaction(async (connection) => {
      await connection.execute(
        `UPDATE rc_outbox SET published_at = CURRENT_TIMESTAMP(6), lease_token = NULL
         WHERE event_id = ? AND lease_token = ? AND available_at > CURRENT_TIMESTAMP(6)`,
        [event.eventId, token],
      );
    });
  }
}
