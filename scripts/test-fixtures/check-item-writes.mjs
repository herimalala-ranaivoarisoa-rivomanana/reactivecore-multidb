import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function checkItemWrites(client, otherClient, signal) {
  const [item] = (await client.query('items.list', {}, signal)).data;
  assert.ok(item);
  const detail = { id: item.id };
  assert.equal(
    (await otherClient.query('items.get', detail, signal)).data,
    null,
  );

  const stream = client.subscribe('items.get', detail, signal);
  try {
    assert.deepEqual((await stream.next()).value.data, item);
    const updated = { id: item.id, title: 'Updated on both engines' };

    await assert.rejects(
      otherClient.mutate('items.update', updated, randomUUID(), signal),
      { status: 404 },
    );
    await assert.rejects(
      otherClient.mutate('items.delete', { id: item.id }, randomUUID(), signal),
      { status: 404 },
    );
    assert.deepEqual((await client.query('items.list', {}, signal)).data, [
      item,
    ]);

    await client.mutate('items.update', updated, randomUUID(), signal);
    assert.deepEqual((await stream.next()).value.data, updated);
    const noChange = await client.mutate(
      'items.update',
      updated,
      randomUUID(),
      signal,
    );
    assert.deepEqual(noChange.data, updated);
    const key = randomUUID();
    const deleted = await client.mutate(
      'items.delete',
      { id: item.id },
      key,
      signal,
    );
    assert.deepEqual(
      await client.mutate('items.delete', { id: item.id }, key, signal),
      { ...deleted, replayed: true },
    );
    for (;;) {
      const result = await stream.next();
      assert.ok(!result.done, 'Expected an SSE snapshot after deletion');
      if (BigInt(result.value.seq) >= BigInt(deleted.commitSeq)) {
        assert.equal(result.value.data, null);
        break;
      }
    }
    assert.deepEqual(
      (await otherClient.query('items.list', {}, signal)).data,
      [],
    );
  } finally {
    await stream.return();
  }
}
