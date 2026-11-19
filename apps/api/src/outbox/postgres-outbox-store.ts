import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { OutboxStore, type OutboxLease } from './outbox-store.js';

interface OutboxRow {
  event_id: string;
  tenant_id: string;
  event_type: string;
  aggregate_id: string;
  payload: unknown;
}

@Injectable()
export class PostgresOutboxStore extends OutboxStore {
  constructor(private readonly database: DatabaseService) {
    super();
  }

  async assertWorkerAccess(): Promise<void> {
    const { rows } = await this.database.query<{ safe: boolean }>(
      `SELECT current_user = 'reactivecore_worker'
              AND NOT rolsuper AND NOT rolbypassrls AS safe
       FROM pg_roles WHERE rolname = current_user`,
    );
    if (!rows[0]?.safe)
      throw new Error(
        'Outbox requires the restricted reactivecore_worker role',
      );
  }

  async claim(): Promise<OutboxLease | undefined> {
    const token = randomUUID();
    const {
      rows: [row],
    } = await this.database.query<OutboxRow>(
      `WITH candidate AS (
         SELECT id FROM event_outbox
         WHERE published_at IS NULL AND available_at <= now()
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       UPDATE event_outbox AS event
       SET lease_token = $1, available_at = now() + interval '30 seconds',
           attempts = attempts + 1
       FROM candidate WHERE event.id = candidate.id
       RETURNING event.event_id, event.tenant_id, event.event_type,
                 event.aggregate_id, event.payload`,
      [token],
    );
    if (!row) return;

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
  }

  async retry({ event, token }: OutboxLease): Promise<void> {
    await this.database.query(
      `UPDATE event_outbox SET lease_token = NULL,
         available_at = now() + LEAST(attempts, 30) * interval '1 second'
       WHERE event_id = $1 AND lease_token = $2`,
      [event.eventId, token],
    );
  }

  async acknowledge({ event, token }: OutboxLease): Promise<void> {
    await this.database.query(
      `UPDATE event_outbox SET published_at = now(), lease_token = NULL
       WHERE event_id = $1 AND lease_token = $2 AND available_at > now()`,
      [event.eventId, token],
    );
  }
}
