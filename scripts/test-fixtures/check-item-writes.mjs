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

export async function checkReservations(client, peer, otherClient, signal) {
  const first = await client.mutate(
    'items.create',
    { title: 'A slot' },
    randomUUID(),
    signal,
  );
  const second = await client.mutate(
    'items.create',
    { title: 'B slot' },
    randomUUID(),
    signal,
  );
  const page = (offset) => ({ offset, limit: 1 });
  assert.deepEqual(
    (await client.query('items.available', page(0), signal)).data,
    [{ ...first.data, version: 1 }],
  );
  assert.deepEqual(
    (await client.query('items.available', page(1), signal)).data,
    [{ ...second.data, version: 1 }],
  );
  assert.deepEqual(
    (await otherClient.query('items.available', page(0), signal)).data,
    [],
  );
  const args = { id: first.data.id };
  await assert.rejects(
    otherClient.mutate('items.reserve', args, randomUUID(), signal),
    { status: 404 },
  );

  const stream = client.subscribe('items.available', page(0), signal);
  try {
    assert.deepEqual((await stream.next()).value.data, [
      { ...first.data, version: 1 },
    ]);
    const contenders = [client, peer].map((actor) => ({
      actor,
      key: randomUUID(),
    }));
    const results = await Promise.allSettled(
      contenders.map(({ actor, key }) =>
        actor.mutate('items.reserve', args, key, signal),
      ),
    );
    const winnerIndex = results.findIndex(
      (result) => result.status === 'fulfilled',
    );
    assert.notEqual(winnerIndex, -1);
    const winner = results[winnerIndex].value;
    assert.equal(results[1 - winnerIndex].reason?.status, 409);
    assert.equal(winner.data.version, 2);
    const { actor, key } = contenders[winnerIndex];
    assert.deepEqual(await actor.mutate('items.reserve', args, key, signal), {
      ...winner,
      replayed: true,
    });
    assert.deepEqual((await stream.next()).value.data, [
      { ...second.data, version: 1 },
    ]);
  } finally {
    await stream.return();
  }
}

export async function checkBilling(client, other, signal) {
  const item = await client.mutate(
    'items.create',
    { title: 'Billed item' },
    randomUUID(),
    signal,
  );
  const hidden = await other.mutate(
    'items.create',
    { title: 'Other tenant item' },
    randomUUID(),
    signal,
  );
  const period = '2026-11';
  const add = (actor, itemId, amountCents) =>
    actor.mutate(
      'billing.add_charge',
      { itemId, period, amountCents },
      randomUUID(),
      signal,
    );

  await add(other, hidden.data.id, 9000);
  await assert.rejects(add(other, item.data.id, 400), { status: 404 });
  const stream = client.subscribe('billing.monthly', {}, signal);
  try {
    assert.deepEqual((await stream.next()).value.data, []);
    await add(client, item.data.id, 125);
    assert.deepEqual((await stream.next()).value.data, [
      { period, count: '1', total_cents: '125' },
    ]);
    await add(client, item.data.id, 375);
    assert.deepEqual((await stream.next()).value.data, [
      { period, count: '2', total_cents: '500' },
    ]);
    assert.deepEqual((await other.query('billing.monthly', {}, signal)).data, [
      { period, count: '1', total_cents: '9000' },
    ]);
  } finally {
    await stream.return();
  }
}
