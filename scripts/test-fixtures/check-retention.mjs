import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function checkRetention({
  tenant,
  client,
  neighbor,
  databaseUrl,
  ageReceipt,
  readState,
}) {
  const signal = AbortSignal.timeout(15000);
  const key = randomUUID();
  const args = { title: 'Retained mutation key' };
  const [first, independent] = await Promise.all([
    client.mutate('items.create', args, key, signal),
    neighbor.mutate(
      'items.create',
      { title: 'Neighboring tenant' },
      randomUUID(),
      signal,
    ),
  ]);
  assert.equal(first.commitSeq, independent.commitSeq);
  const second = await client.mutate(
    'items.create',
    { title: 'Second' },
    randomUUID(),
    signal,
  );
  const third = await client.mutate(
    'items.create',
    { title: 'Third' },
    randomUUID(),
    signal,
  );
  assert.equal(BigInt(third.commitSeq), BigInt(first.commitSeq) + 2n);
  assert.equal(
    (await neighbor.query('items.list', {}, signal)).seq,
    independent.commitSeq,
  );
  await ageReceipt(key);
  const { stdout } = await exec(process.execPath, ['scripts/retain-data.mjs'], {
    env: {
      ...process.env,
      RC_RETENTION_DATABASE_URL: databaseUrl,
      RC_RETENTION_TENANT: tenant,
      RC_RETENTION_KEEP_COMMITS: '1',
      RC_RETENTION_RECEIPT_DAYS: '30',
    },
    signal,
  });
  assert.deepEqual(JSON.parse(stdout), {
    journalRowsPruned: 2,
    receiptResponsesCompacted: 1,
  });
  const { prunedThrough, remaining } = await readState();
  assert.equal(prunedThrough, second.commitSeq);
  assert.equal(remaining, 1);
  await assert.rejects(client.mutate('items.create', args, key, signal), {
    status: 410,
  });
  assert.equal((await client.query('items.list', {}, signal)).data.length, 3);
  assert.equal((await neighbor.query('items.list', {}, signal)).data.length, 1);
  console.log(
    'Tenant clocks, journal pruning, and retained idempotency key verified.',
  );
}
