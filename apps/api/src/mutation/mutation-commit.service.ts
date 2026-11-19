import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ChangeLogService,
  type JournalChange,
} from '../reactive/changelog/change-log.service.js';

@Injectable()
export class MutationCommitService {
  constructor(private readonly journal: ChangeLogService) {}

  async commitChanges(
    client: PoolClient,
    tenantId: string,
    changes: readonly JournalChange[],
  ): Promise<string> {
    if (changes.length === 0 || changes.length > 100)
      throw new UnprocessableEntityException(
        'Expected between 1 and 100 recorded changes',
      );
    const seq = await this.journal.append(client, changes);
    const events = changes.map((change) => ({
      event_id: change.eventId,
      event_type: 'reactive.changed',
      aggregate_id: change.documentId,
      payload: {
        ...change,
        tenantId,
        schemaVersion: 1,
        commitSeq: seq,
      },
    }));
    await client.query(
      `INSERT INTO event_outbox (tenant_id, commit_seq, event_id, event_type, aggregate_id, payload)
       SELECT $1, $2, event_id, event_type, aggregate_id, payload
       FROM jsonb_to_recordset($3::jsonb)
         AS event(event_id uuid, event_type text, aggregate_id uuid, payload jsonb)`,
      [tenantId, seq, JSON.stringify(events)],
    );
    return seq;
  }
}
