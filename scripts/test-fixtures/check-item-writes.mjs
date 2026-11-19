import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function checkItemWrites(client, peer, otherClient, signal) {
  const [item] = (await client.query('items.list', {}, signal)).data;
  assert.ok(item);
  const detail = { id: item.id };
  const expected = { ...detail, expectedVersion: item.version };
  assert.equal(
    (await otherClient.query('items.get', detail, signal)).data,
    null,
  );

  const stream = client.subscribe('items.get', detail, signal);
  try {
    assert.deepEqual((await stream.next()).value.data, item);
    await assert.rejects(
      otherClient.mutate(
        'items.update',
        { ...expected, title: 'Forbidden' },
        randomUUID(),
        signal,
      ),
      { status: 404 },
    );
    await assert.rejects(
      otherClient.mutate('items.delete', expected, randomUUID(), signal),
      { status: 404 },
    );
    assert.deepEqual(
      (await client.query('items.get', detail, signal)).data,
      item,
    );

    const writes = [client, peer].map((actor, index) => ({
      actor,
      args: { ...expected, title: `Concurrent edit ${index + 1}` },
      key: randomUUID(),
    }));
    const results = await Promise.allSettled(
      writes.map(({ actor, args, key }) =>
        actor.mutate('items.update', args, key, signal),
      ),
    );
    const winners = results.flatMap((result, index) =>
      result.status === 'fulfilled'
        ? [{ result: result.value, ...writes[index] }]
        : [],
    );
    assert.equal(winners.length, 1);
    const [winner] = winners;
    const losers = results.filter((result) => result.status === 'rejected');
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.status, 409);

    const updated = {
      ...detail,
      title: winner.args.title,
      version: item.version + 1,
    };
    assert.deepEqual(winner.result.data, updated);
    assert.deepEqual((await stream.next()).value.data, updated);
    await assert.rejects(
      client.mutate('items.delete', expected, randomUUID(), signal),
      { status: 409 },
    );
    assert.deepEqual(
      (await client.query('items.get', detail, signal)).data,
      updated,
    );

    const args = { ...detail, expectedVersion: updated.version };
    const key = randomUUID();
    const deleted = await client.mutate('items.delete', args, key, signal);
    assert.deepEqual(await client.mutate('items.delete', args, key, signal), {
      ...deleted,
      replayed: true,
    });
    assert.deepEqual(
      await winner.actor.mutate(
        'items.update',
        winner.args,
        winner.key,
        signal,
      ),
      { ...winner.result, replayed: true },
    );
    const snapshot = (await stream.next()).value;
    assert.equal(snapshot.data, null);
    assert.equal(snapshot.seq, deleted.commitSeq);
    assert.deepEqual(
      (await otherClient.query('items.list', {}, signal)).data,
      [],
    );
  } finally {
    await stream.return();
  }
}
