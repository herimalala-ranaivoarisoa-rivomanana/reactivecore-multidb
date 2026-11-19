import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SignJWT } from 'jose';
import { createConnection } from 'mysql2/promise';
import { ReactiveCoreClient } from '@reactivecore/client';
import { checkItemWrites } from './test-fixtures/check-item-writes.mjs';

const exec = promisify(execFile);
const base = process.env.RC_MYSQL_TEST_URL;
const redisUrl =
  process.env.REDIS_URL ??
  (process.env.REDIS_PORT &&
    process.env.REDIS_PASSWORD &&
    `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD)}@127.0.0.1:${process.env.REDIS_PORT}`);
assert.ok(
  base && redisUrl,
  'Set RC_MYSQL_TEST_URL and REDIS_URL (or use the integration Redis environment)',
);
const name = `mysql-items-${randomBytes(4).toString('hex')}`;
const database = `reactivecore_${name.replaceAll('-', '_')}`;
const target = new URL(base);
target.pathname = `/${database}`;
const adminUrl = target.href;
const password = process.env.RC_MYSQL_TEST_ROLE_PASSWORD ?? 'mysql_test_only';
const runtimeUrl = (role) => {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  return url.href;
};
const origin = 'http://127.0.0.1:4405';
const issuer = 'urn:reactivecore:mysql-test';
const audience = `reactivecore:${name}`;
const jwt = randomBytes(32).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'reactivecore-mysql-'));
const admin = await createConnection(base);
const children = [];
const logs = [];
const tenant = randomUUID();
const otherTenant = randomUUID();
const env = {
  ...process.env,
  NODE_ENV: 'development',
  RC_JWKS_URL: '',
  RC_JWT_DEV_SECRET: jwt,
  RC_JWT_ISSUER: issuer,
  RC_JWT_AUDIENCE: audience,
  RC_HOST: '127.0.0.1',
  PORT: '4405',
  RC_CORS_ORIGINS:
    process.env.RC_BROWSER_CONFLICT_TEST === '1' ? 'http://127.0.0.1:4173' : '',
  REDIS_URL: redisUrl,
};
delete env.RC_MYSQL_TEST_URL;
delete env.RC_MYSQL_TEST_ROLE_PASSWORD;
const cli = (...args) =>
  exec(process.execPath, ['scripts/reactivecore.mjs', ...args], {
    env: { ...env, RC_PROVISION_ADMIN_URL: adminUrl },
    timeout: 20000,
  });

function start(command, role) {
  const child = spawn(
    process.execPath,
    ['scripts/reactivecore.mjs', command, directory],
    {
      env: { ...env, DATABASE_URL: runtimeUrl(role) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (data) => logs.push(data.toString()));
  child.stderr.on('data', (data) => logs.push(data.toString()));
  children.push(child);
  return child;
}

async function tokenFor(tenantId) {
  return new SignJWT({
    tenant_id: tenantId,
    scope: 'query mutation subscribe',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(randomUUID())
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(jwt));
}
async function clientFor(tenantId) {
  const token = await tokenFor(tenantId);
  return new ReactiveCoreClient(origin, () => token);
}

let created = false;
try {
  await cp('scripts/test-fixtures/project', directory, { recursive: true });
  const fixture = await import('./test-fixtures/project/project.json', {
    with: { type: 'json' },
  });
  await writeFile(
    join(directory, 'project.json'),
    JSON.stringify({ ...fixture.default, name, mysql: { tables: ['items'] } }),
  );
  await admin.query(
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  );
  created = true;
  for (const role of ['reactivecore_app', 'reactivecore_worker']) {
    await admin.query(
      `CREATE USER IF NOT EXISTS '${role}'@'%' IDENTIFIED BY ?`,
      [password],
    );
  }

  const installed = await cli('provision', directory);
  assert.match(installed.stdout, /Applied project\/001_items.sql/);
  assert.doesNotMatch((await cli('provision', directory)).stdout, /Applied /);
  await cli('tenant', directory, tenant);
  await cli('tenant', directory, otherTenant);
  const appGrants = [
    ['rc_commit_clock', 'SELECT, UPDATE'],
    ['rc_receipts', 'SELECT, INSERT, UPDATE'],
    ['rc_changes', 'SELECT, INSERT'],
    ['rc_outbox', 'INSERT'],
    ['items', 'SELECT, INSERT'],
  ];
  for (const [table, grants] of appGrants) {
    await admin.query(
      `GRANT ${grants} ON \`${database}\`.\`${table}\` TO 'reactivecore_app'@'%'`,
    );
  }
  await admin.query(
    `GRANT UPDATE (title, version), DELETE ON \`${database}\`.items TO 'reactivecore_app'@'%'`,
  );
  await admin.query(
    `GRANT SELECT, UPDATE (lease_token, available_at, attempts, published_at)
     ON \`${database}\`.rc_outbox TO 'reactivecore_worker'@'%'`,
  );

  const api = start('serve', 'reactivecore_app');
  const signal = AbortSignal.timeout(30000);
  for (;;) {
    assert.equal(api.exitCode, null);
    if (
      (
        await fetch(`${origin}/api/health/ready`, { signal }).catch(
          () => undefined,
        )
      )?.ok
    )
      break;
    await setTimeout(100, undefined, { signal });
  }

  const client = await clientFor(tenant);
  const other = await clientFor(otherTenant);
  const stream = client.subscribe('items.list', {}, signal);
  let item;
  try {
    assert.deepEqual((await stream.next()).value.data, []);
    const key = randomUUID();
    const args = { title: 'Same application, MySQL' };
    await admin.query(
      `ALTER TABLE \`${database}\`.rc_outbox ADD CONSTRAINT reject_test_event CHECK (event_type <> 'reactive.changed')`,
    );
    try {
      await assert.rejects(client.mutate('items.create', args, key, signal), {
        status: 500,
      });
      assert.deepEqual(await client.query('items.list', {}, signal), {
        data: [],
        seq: '0',
      });
    } finally {
      await admin.query(
        `ALTER TABLE \`${database}\`.rc_outbox DROP CHECK reject_test_event`,
      );
    }
    const results = await Promise.all([
      client.mutate('items.create', args, key, signal),
      client.mutate('items.create', args, key, signal),
    ]);
    const committed = results.find(({ replayed }) => !replayed);
    assert.ok(committed);
    assert.deepEqual(
      results.find(({ replayed }) => replayed),
      { ...committed, replayed: true },
    );
    item = { ...committed.data, version: 1 };
    assert.deepEqual((await stream.next()).value.data, [item]);
    assert.deepEqual((await other.query('items.list', {}, signal)).data, []);
  } finally {
    await stream.return();
  }
  const reconnect = client.subscribe('items.list', {}, signal);
  try {
    assert.deepEqual((await reconnect.next()).value.data, [item]);
  } finally {
    await reconnect.return();
  }

  const worker = start('worker', 'reactivecore_worker');
  for (;;) {
    assert.equal(worker.exitCode, null);
    const [[outbox]] = await admin.execute(
      `SELECT COUNT(*) AS count FROM \`${database}\`.rc_outbox WHERE aggregate_id = ? AND published_at IS NOT NULL`,
      [item.id],
    );
    if (Number(outbox.count) === 1) break;
    await setTimeout(200, undefined, { signal });
  }
  await checkItemWrites(client, await clientFor(tenant), other, signal);
  if (process.env.RC_BROWSER_CONFLICT_TEST === '1') {
    const { checkBrowserConflict } =
      await import('../examples/next-offline-conflicts/check-conflict.mjs');
    await checkBrowserConflict({
      origin,
      client,
      tokens: [await tokenFor(tenant), await tokenFor(tenant)],
      signal: AbortSignal.timeout(90000),
    });
  }
  console.log(
    'MySQL verified: provision, tenant isolation, rollback, replay, SSE reconnect, and outbox delivery.',
  );
} catch (error) {
  if (logs.length) console.error(logs.join(''));
  throw error;
} finally {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, 'exit');
    child.kill('SIGTERM');
    await closed;
  }
  try {
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
  } finally {
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}
