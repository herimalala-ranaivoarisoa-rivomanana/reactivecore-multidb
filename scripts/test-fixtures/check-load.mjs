import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';

function setting(name, fallback, max) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(
    Number.isSafeInteger(value) && value >= 1 && value <= max,
    `${name} must be between 1 and ${max}`,
  );
  return value;
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(2));
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}

async function waitUntil(condition, signal) {
  for (;;) {
    signal.throwIfAborted();
    if (await condition()) return;
    await setTimeout(50, undefined, { signal });
  }
}

/** Issues the normal mutation request and retains the server reason for HTTP 503. */
export function loadWriter(origin, token) {
  return async (title, key, signal) => {
    const response = await fetch(new URL('/api/v1/mutation', origin), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ name: 'items.create', args: { title } }),
      signal,
    });
    const result = await response.json();
    if (response.ok) return result;
    throw Object.assign(
      new Error(`Mutation request failed (HTTP ${response.status})`),
      {
        status: response.status,
        retryExhausted: result?.message === 'Transaction retry limit exhausted',
      },
    );
  };
}

export function loadScenarios() {
  const writes = setting('RC_LOAD_WRITES', 40, 80);
  const gapWrites = setting('RC_LOAD_GAP_WRITES', 8, 20);
  if (process.env.RC_LOAD_MATRIX === '1') {
    return [
      [48, 2],
      [48, 4],
      [48, 8],
      [16, 4],
      [32, 4],
    ].map(([subscribers, concurrency]) => ({
      subscribers,
      concurrency,
      writes,
      gapWrites,
    }));
  }
  return [
    {
      subscribers: setting('RC_LOAD_SUBSCRIBERS', 16, 100),
      concurrency: setting('RC_LOAD_CONCURRENCY', 8, 20),
      writes,
      gapWrites,
    },
  ];
}

/** Measures a bounded load on a fresh test tenant using the regular HTTP and SSE endpoints. */
export async function checkLoad({
  engine,
  makeClient,
  makeWriter,
  findPublished,
  scenario,
}) {
  const { subscribers, writes, concurrency, gapWrites } = scenario;
  const signal = AbortSignal.timeout(90000);
  const clients = await Promise.all(
    Array.from({ length: subscribers }, makeClient),
  );
  const writers = await Promise.all(
    Array.from({ length: concurrency }, makeWriter),
  );
  const prefix = randomUUID();
  const observed = Array.from({ length: subscribers }, () => new Map());
  const published = new Map();
  const operations = [];
  let serviceUnavailableResponses = 0;
  let transactionRetryExhausted = 0;

  async function openStreams(onSnapshot) {
    const connected = performance.now();
    const controller = new AbortController();
    const streamSignal = AbortSignal.any([signal, controller.signal]);
    const streams = clients.map((client) =>
      client.subscribe('items.list', {}, streamSignal),
    );
    async function close() {
      controller.abort();
      await Promise.allSettled(streams.map((stream) => stream.return()));
    }
    try {
      const latency = await Promise.all(
        streams.map(async (stream, index) => {
          const first = await stream.next();
          assert.equal(first.done, false, 'Expected an initial SSE snapshot');
          onSnapshot(first.value, index);
          return performance.now() - connected;
        }),
      );
      return { streams, close, latency, controller };
    } catch (error) {
      await close();
      throw error;
    }
  }

  function observe(snapshot, index) {
    const now = performance.now();
    for (const item of snapshot.data)
      if (item.title.startsWith(prefix) && !observed[index].has(item.title))
        observed[index].set(item.title, now);
  }

  async function create(client, title) {
    const key = randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        return await client(title, key, signal);
      } catch (error) {
        if (error?.status !== 503) throw error;
        serviceUnavailableResponses++;
        if (error.retryExhausted) transactionRetryExhausted++;
        if (attempt === 3) throw error;
        await setTimeout(100 * 2 ** attempt, undefined, { signal });
      }
    }
  }

  async function sendBatch(count, startAt) {
    let next = 0;
    const results = await Promise.allSettled(
      writers.map(async (client) => {
        while (next < count) {
          const index = startAt + next++;
          const title = `${prefix}-${String(index).padStart(3, '0')}`;
          const start = performance.now();
          const reply = await create(client, title);
          assert.equal(reply.data.title, title);
          operations[index] = {
            title,
            id: reply.data.id,
            start,
            end: performance.now(),
          };
        }
      }),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  const initial = await openStreams((snapshot) =>
    assert.deepEqual(snapshot.data, []),
  );
  let streamFailure;
  const pumps = initial.streams.map(async (stream, index) => {
    try {
      for await (const snapshot of stream) observe(snapshot, index);
    } catch (error) {
      if (!initial.controller.signal.aborted) streamFailure ??= error;
    }
  });
  const polling = new AbortController();
  const pollSignal = AbortSignal.any([signal, polling.signal]);
  let pollFailure;
  const poll = waitUntil(async () => {
    const pending = operations
      .filter(Boolean)
      .filter(({ id }) => !published.has(id));
    if (pending.length) {
      const ids = await findPublished(pending.map(({ id }) => id));
      const now = performance.now();
      for (const id of ids) published.set(id, now);
    }
    return published.size === writes + gapWrites;
  }, pollSignal).catch((error) => {
    if (!polling.signal.aborted) pollFailure = error;
  });

  try {
    try {
      await sendBatch(writes, 0);
      await waitUntil(() => {
        if (streamFailure) throw streamFailure;
        return observed.every((entries) => entries.size === writes);
      }, signal);
    } finally {
      await initial.close();
      await Promise.all(pumps);
    }

    await sendBatch(gapWrites, writes);
    const expectedIds = operations.map(({ id }) => id).sort();
    const reconnected = await openStreams((snapshot) => {
      assert.deepEqual(snapshot.data.map(({ id }) => id).sort(), expectedIds);
    });
    await reconnected.close();
    await poll;
    if (pollFailure) throw pollFailure;
    assert.equal(published.size, operations.length);

    console.log(
      JSON.stringify({
        engine,
        subscribers,
        writes,
        gapWrites,
        concurrency,
        serviceUnavailableResponses,
        transactionRetryExhausted,
        initialFirstSnapshotMs: summarize(initial.latency),
        mutationMs: summarize(operations.map(({ start, end }) => end - start)),
        allSubscribersSseMs: summarize(
          operations
            .slice(0, writes)
            .map(
              ({ title, start }) =>
                Math.max(...observed.map((entries) => entries.get(title))) -
                start,
            ),
        ),
        workerObservedMs: summarize(
          operations.map(({ id, start }) => published.get(id) - start),
        ),
        reconnectFirstSnapshotMs: summarize(reconnected.latency),
      }),
    );
  } finally {
    polling.abort();
    await poll;
  }
}
