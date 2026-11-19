import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { performance } from 'node:perf_hooks';

/** Exercises an existing SSE stream across an API shutdown through a stable local endpoint. */
export async function checkReplicaFailover({
  engine,
  Client,
  primary,
  secondary,
  token,
  stopPrimary,
}) {
  let target = primary;
  const proxy = createServer((req, res) => {
    const upstream = request(
      new URL(req.url, target),
      {
        method: req.method,
        headers: req.headers,
      },
      (incoming) => {
        incoming.on('error', () => res.destroy());
        res.writeHead(incoming.statusCode, incoming.headers);
        res.flushHeaders();
        incoming.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(30000),
  ]);
  const proxied = new Client(
    `http://127.0.0.1:${proxy.address().port}`,
    () => token,
  );
  const firstApi = new Client(primary, () => token);
  const liveApi = new Client(secondary, () => token);
  const states = [];
  const first = proxied.subscribe('items.list', {}, signal, (state) =>
    states.push(state),
  );
  const second = proxied.subscribe('items.list', {}, signal);

  try {
    assert.deepEqual((await first.next()).value.data, []);
    target = secondary;
    assert.deepEqual((await second.next()).value.data, []);

    const key = randomUUID();
    const args = { title: 'Committed on the first API' };
    const committed = await firstApi.mutate('items.create', args, key, signal);
    for (const stream of [first, second]) {
      assert.deepEqual((await stream.next()).value.data, [
        { ...committed.data, version: 1 },
      ]);
    }

    const disconnectedAt = performance.now();
    await stopPrimary();
    const replay = await liveApi.mutate('items.create', args, key, signal);
    assert.deepEqual(replay, { ...committed, replayed: true });
    const duringFailover = await liveApi.mutate(
      'items.create',
      { title: 'Committed on the surviving API' },
      randomUUID(),
      signal,
    );
    const expected = [committed.data.id, duringFailover.data.id].sort();

    async function catchUp(stream) {
      for (;;) {
        const snapshot = await stream.next();
        assert.equal(
          snapshot.done,
          false,
          'Expected SSE recovery after stopping the first API',
        );
        if (BigInt(snapshot.value.seq) < BigInt(duringFailover.commitSeq))
          continue;
        assert.deepEqual(
          snapshot.value.data.map(({ id }) => id).sort(),
          expected,
        );
        return performance.now() - disconnectedAt;
      }
    }
    const [recoveredMs] = await Promise.all([catchUp(first), catchUp(second)]);
    assert.deepEqual(states, ['live', 'reconnecting', 'live']);
    assert.deepEqual(
      (await liveApi.query('items.list', {}, signal)).data
        .map(({ id }) => id)
        .sort(),
      expected,
    );
    console.log(
      JSON.stringify({
        scenario: `${engine}-replica-failover`,
        resumedOriginalStream: true,
        replayedAcrossApis: replay.replayed,
        committedRows: expected.length,
        recoveryMs: Number(recoveredMs.toFixed(2)),
      }),
    );
  } finally {
    controller.abort();
    await Promise.allSettled([first.return(), second.return()]);
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
}
