import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer as httpServer, request } from 'node:http';
import { createServer, connect } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';

async function createLink(targetUrl, defaultPort) {
  const target = new URL(targetUrl);
  const sockets = new Set();
  let available = true;
  function track(socket) {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  }
  const server = createServer((socket) => {
    if (!available) {
      socket.destroy();
      return;
    }
    const downstream = track(socket);
    const upstream = track(
      connect(Number(target.port || defaultPort), target.hostname),
    );
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
    downstream.on('close', () => upstream.destroy());
    upstream.on('close', () => downstream.destroy());
    downstream.pipe(upstream).pipe(downstream);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const cut = () => {
    available = false;
    for (const socket of sockets) socket.destroy();
  };
  return {
    route(url) {
      const destination = new URL(url);
      destination.hostname = '127.0.0.1';
      destination.port = String(server.address().port);
      return destination.href;
    },
    cut,
    restore() {
      available = true;
    },
    async close() {
      cut();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function databaseLinks(url, defaultPort) {
  const api = await createLink(url, defaultPort);
  try {
    const worker = await createLink(url, defaultPort);
    return {
      api,
      worker,
      async close() {
        await Promise.all([api.close(), worker.close()]);
      },
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}

async function waitFor(check, signal) {
  for (;;) {
    signal.throwIfAborted();
    if (await check()) return;
    await setTimeout(100, undefined, { signal });
  }
}

// Forward one mutation and drop its HTTP response after the API has committed.
async function loseResponse(origin, token, args, key, cut, signal) {
  let committed;
  let fault;
  const proxy = httpServer((req, res) => {
    const upstream = request(
      new URL('/api/v1/mutation', origin),
      {
        method: 'POST',
        headers: req.headers,
        signal,
      },
      async (response) => {
        try {
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          assert.equal(response.statusCode, 200);
          committed = JSON.parse(Buffer.concat(chunks).toString());
          cut();
        } catch (error) {
          fault = error;
        } finally {
          res.destroy();
        }
      },
    );
    upstream.on('error', (error) => {
      fault = error;
      res.destroy();
    });
    req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    await assert.rejects(
      fetch(`http://127.0.0.1:${proxy.address().port}/api/v1/mutation`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({ name: 'items.create', args }),
        signal,
      }),
      TypeError,
    );
    if (fault) throw fault;
    assert.ok(
      committed,
      'Expected the API to commit before the HTTP response was lost',
    );
    return committed;
  } finally {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
}

export async function checkDatabaseOutage({
  engine,
  Client,
  origin,
  token,
  links,
  findPublished,
}) {
  const client = new Client(origin, () => token);
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(45000),
  ]);
  const stream = client.subscribe('items.list', {}, signal);
  const health = (endpoint) =>
    fetch(`${origin}/api/health/${endpoint}`, { signal });

  try {
    assert.deepEqual((await stream.next()).value.data, []);
    const knownArgs = { title: 'Acknowledged before outage' };
    const knownKey = randomUUID();
    const known = await client.mutate(
      'items.create',
      knownArgs,
      knownKey,
      signal,
    );
    assert.deepEqual((await stream.next()).value.data, [
      { ...known.data, version: 1 },
    ]);
    await waitFor(
      async () => (await findPublished([known.data.id])).length === 1,
      signal,
    );

    links.worker.cut();
    const lostArgs = { title: 'Committed with response lost' };
    const lostKey = randomUUID();
    const lost = await loseResponse(
      origin,
      token,
      lostArgs,
      lostKey,
      links.api.cut,
      signal,
    );
    assert.deepEqual(await findPublished([lost.data.id]), []);
    assert.equal((await health('ready')).status, 503);
    assert.equal((await health('live')).status, 200);

    const gapArgs = { title: 'Submitted while database is inaccessible' };
    const gapKey = randomUUID();
    await assert.rejects(
      client.mutate('items.create', gapArgs, gapKey, signal),
      (error) => error.status >= 500,
    );

    const restored = performance.now();
    links.api.restore();
    links.worker.restore();
    await waitFor(async () => (await health('ready')).ok, signal);
    const readyMs = performance.now() - restored;
    assert.deepEqual(
      await client.mutate('items.create', knownArgs, knownKey, signal),
      { ...known, replayed: true },
    );
    assert.deepEqual(
      await client.mutate('items.create', lostArgs, lostKey, signal),
      { ...lost, replayed: true },
    );
    const gap = await client.mutate('items.create', gapArgs, gapKey, signal);
    assert.equal(gap.replayed, false);

    const ids = [known.data.id, lost.data.id, gap.data.id].sort();
    const recovered = await Promise.all([
      (async () => {
        for (;;) {
          const snapshot = await stream.next();
          assert.equal(snapshot.done, false);
          if (BigInt(snapshot.value.seq) < BigInt(gap.commitSeq)) continue;
          assert.deepEqual(snapshot.value.data.map(({ id }) => id).sort(), ids);
          return performance.now() - restored;
        }
      })(),
      (async () => {
        await waitFor(
          async () => (await findPublished(ids)).length === ids.length,
          signal,
        );
        return performance.now() - restored;
      })(),
    ]);
    console.log(
      JSON.stringify({
        scenario: `${engine}-database-outage`,
        readyMs: Math.round(readyMs),
        completeSseMs: Math.round(recovered[0]),
        outboxPublishedMs: Math.round(recovered[1]),
        committedRows: ids.length,
        lostResponseReplayed: true,
      }),
    );
  } finally {
    links.api.restore();
    links.worker.restore();
    controller.abort();
    await stream.return();
  }
}
