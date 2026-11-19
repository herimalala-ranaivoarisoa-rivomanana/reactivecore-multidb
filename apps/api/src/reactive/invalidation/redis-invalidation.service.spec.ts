import { randomUUID } from 'node:crypto';
import { invalidationPayload } from '../../outbox/invalidation-payload.js';
import { parseChange } from './redis-invalidation.service.js';

const tenantId = randomUUID();
const documentId = randomUUID();
const event = {
  eventId: randomUUID(),
  tenantId,
  aggregateId: documentId,
  type: 'reactive.changed',
  payload: {
    schemaVersion: 1,
    tenantId,
    documentId,
    table: 'records',
    operation: 'update',
    before: { name: 'before', group_id: 'a' },
    after: { name: 'after', group_id: 'b' },
  },
};

it('preserves arbitrary before and after fields for predicate matching', () => {
  expect(parseChange(JSON.stringify(event))).toEqual({
    tenantId,
    documentId,
    table: 'records',
    operation: 'update',
    before: event.payload.before,
    after: event.payload.after,
  });
});

it('ignores malformed and inconsistent change envelopes', () => {
  expect(parseChange('invalid')).toBeUndefined();
  for (const patch of [
    { schemaVersion: 2 },
    { tenantId: randomUUID() },
    { operation: 'unknown' },
  ]) {
    expect(
      parseChange(
        JSON.stringify({ ...event, payload: { ...event.payload, ...patch } }),
      ),
    ).toBeUndefined();
  }
});

it('publishes only change metadata, including for older queued outbox events', () => {
  const payload = invalidationPayload(event.type, event.payload);
  const message = JSON.stringify({ ...event, payload });
  expect(message).not.toContain('group_id');
  expect(parseChange(message)).toMatchObject({
    tenantId,
    documentId,
    table: 'records',
  });
  expect(parseChange(message)?.before).toBeUndefined();
  expect(parseChange(message)?.after).toBeUndefined();
});
