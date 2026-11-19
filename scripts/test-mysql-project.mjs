import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SignJWT } from 'jose';
import { createConnection } from 'mysql2/promise';
import { ReactiveCoreClient } from '@reactivecore/client';
import {
  checkBilling,
  checkItemWrites,
  checkReservations,
} from './test-fixtures/check-item-writes.mjs';

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
const replicaOrigin = 'http://127.0.0.1:4408';
const useOutage = process.env.RC_DATABASE_OUTAGE_TEST === '1';
let outageLinks;
const useReplica = process.env.RC_REPLICA_LOAD_TEST === '1';
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
const image = process.env.RC_TEST_IMAGE;
const previousImage = process.env.RC_MYSQL_UPGRADE_IMAGE;
const mysqlContainer = process.env.RC_MYSQL_TEST_CONTAINER;
const runtimeKeys = [
  'DATABASE_URL',
  'REDIS_URL',
  'NODE_ENV',
  'RC_HOST',
  'PORT',
  'RC_JWT_ISSUER',
  'RC_JWT_AUDIENCE',
  'RC_JWT_DEV_SECRET',
  'RC_CORS_ORIGINS',
];

function dockerArgs(
  command,
  keys,
  { runtime = image, project = directory, instance = command } = {},
  ...args
) {
  return [
    'run',
    '--rm',
    '--network',
    'host',
    '--name',
    `${name}-${instance}`,
    '--mount',
    `type=bind,src=${project},dst=/project,readonly`,
    ...keys.flatMap((key) => ['--env', key]),
    runtime,
    command,
    '/project',
    ...args,
  ];
}

const cli = (command, ...args) => {
  const options = {
    env: { ...env, RC_PROVISION_ADMIN_URL: adminUrl },
    timeout: 20000,
  };
  return image
    ? exec(
        'docker',
        dockerArgs(command, ['RC_PROVISION_ADMIN_URL'], {}, ...args.slice(1)),
        options,
      )
    : exec(
        process.execPath,
        ['scripts/reactivecore.mjs', command, ...args],
        options,
      );
};

function start(
  command,
  role,
  runtime = image,
  project = directory,
  { port = env.PORT, instance = command } = {},
) {
  const url = runtimeUrl(role);
  const link = command === 'worker' ? outageLinks?.worker : outageLinks?.api;
  const options = {
    env: { ...env, PORT: port, DATABASE_URL: link ? link.route(url) : url },
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const keys =
    command === 'serve' ? runtimeKeys : ['DATABASE_URL', 'REDIS_URL'];
  const child = runtime
    ? spawn(
        'docker',
        dockerArgs(command, keys, { runtime, project, instance }),
        options,
      )
    : spawn(
        process.execPath,
        ['scripts/reactivecore.mjs', command, project],
        options,
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
async function clientFor(tenantId, token, apiOrigin = origin) {
  token ??= await tokenFor(tenantId);
  return new ReactiveCoreClient(apiOrigin, () => token);
}

async function waitReady(api, signal, apiOrigin = origin) {
  for (;;) {
    assert.equal(api.exitCode, null);
    if (
      (
        await fetch(`${apiOrigin}/api/health/ready`, { signal }).catch(
          () => undefined,
        )
      )?.ok
    )
      return;
    await setTimeout(100, undefined, { signal });
  }
}

async function seedPreviousVersion() {
  const old = await mkdtemp(join(tmpdir(), 'reactivecore-mysql-upgrade-'));
  try {
    const migrations = join(old, 'migrations/mysql');
    await mkdir(migrations, { recursive: true });
    for (const file of [
      'application.mjs',
      'migrations/mysql/001_items.sql',
      'migrations/mysql/002_item_versions.sql',
    ]) {
      const { stdout } = await exec('git', [
        'show',
        `v0.2.0-alpha.1:scripts/test-fixtures/project/${file}`,
      ]);
      await writeFile(join(old, file), stdout, { mode: 0o644 });
    }
    await chmod(old, 0o755);
    await writeFile(
      join(old, 'project.json'),
      JSON.stringify({ name, mysql: { tables: ['items'] } }),
      { mode: 0o644 },
    );
    const runOld = (command, ...args) =>
      exec(
        'docker',
        dockerArgs(
          command,
          ['RC_PROVISION_ADMIN_URL'],
          { runtime: previousImage, project: old },
          ...args,
        ),
        { env: { ...env, RC_PROVISION_ADMIN_URL: adminUrl }, timeout: 30000 },
      );
    await runOld('provision');
    const baselineTenant = randomUUID();
    await runOld('tenant', baselineTenant);
    await grantRuntime(false);
    const previous = start('serve', 'reactivecore_app', previousImage, old);
    try {
      const signal = AbortSignal.timeout(30000);
      await waitReady(previous, signal);
      const client = await clientFor(baselineTenant);
      const key = randomUUID();
      const args = { title: 'Unchanged through upgrade' };
      const result = await client.mutate('items.create', args, key, signal);
      return { client, key, args, result };
    } finally {
      await exec('docker', ['stop', '--time', '5', `${name}-serve`]);
    }
  } finally {
    await rm(old, { recursive: true, force: true });
  }
}

async function grantRuntime(current) {
  const appGrants = [
    ['rc_commit_clock', 'SELECT, UPDATE'],
    ['rc_receipts', 'SELECT, INSERT, UPDATE'],
    ['rc_changes', 'SELECT, INSERT'],
    ['rc_outbox', 'INSERT'],
    ['items', 'SELECT, INSERT'],
  ];
  if (current) {
    appGrants.push(
      ['rc_tenant_clocks', 'SELECT, INSERT, UPDATE'],
      ['charges', 'SELECT, INSERT'],
    );
  }
  for (const [table, grants] of appGrants) {
    await admin.query(
      `GRANT ${grants} ON \`${database}\`.\`${table}\` TO 'reactivecore_app'@'%'`,
    );
  }
  const columns = current ? 'title, version, reserved_by' : 'title, version';
  await admin.query(
    `GRANT UPDATE (${columns}), DELETE ON \`${database}\`.items TO 'reactivecore_app'@'%'`,
  );
  await admin.query(
    `GRANT SELECT, UPDATE (lease_token, available_at, attempts, published_at)
     ON \`${database}\`.rc_outbox TO 'reactivecore_worker'@'%'`,
  );
}

async function checkRestore() {
  const restored = `${database}_restore`;
  const url = new URL(base);
  function tool(command, args, input) {
    const result = spawnSync(
      'docker',
      [
        'exec',
        '-i',
        '--env',
        'MYSQL_PWD',
        mysqlContainer,
        command,
        '-u',
        decodeURIComponent(url.username),
        ...args,
      ],
      {
        input,
        env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30000,
      },
    );
    if (result.error || result.status !== 0)
      throw new Error(`MySQL backup tool failed: ${command}`, {
        cause: result.error,
      });
    return result.stdout;
  }
  const backup = tool('mysqldump', [
    '--single-transaction',
    '--no-tablespaces',
    '--set-gtid-purged=OFF',
    '--column-statistics=0',
    database,
  ]);
  await admin.query(
    `CREATE DATABASE \`${restored}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  );
  try {
    tool('mysql', ['--binary-mode', restored], backup);
    for (const [table, key] of [
      ['items', 'id'],
      ['charges', 'id'],
      ['rc_receipts', 'idempotency_key'],
      ['rc_changes', 'tenant_id, seq, ordinal'],
      ['rc_tenant_clocks', 'tenant_id'],
      ['rc_migrations', 'name'],
    ]) {
      const [original] = await admin.query(
        `SELECT * FROM \`${database}\`.${table} ORDER BY ${key}`,
      );
      const [copy] = await admin.query(
        `SELECT * FROM \`${restored}\`.${table} ORDER BY ${key}`,
      );
      assert.ok(original.length > 0);
      assert.deepEqual(copy, original);
    }
    const [[original]] = await admin.query(
      `SELECT COUNT(*) AS count FROM \`${database}\`.rc_outbox`,
    );
    const [[copy]] = await admin.query(
      `SELECT COUNT(*) AS count FROM \`${restored}\`.rc_outbox`,
    );
    assert.deepEqual(copy, original);
    console.log(
      'MySQL logical backup restored with application rows, receipts, journal, and migration history.',
    );
  } finally {
    await admin.query(`DROP DATABASE \`${restored}\``);
  }
}

let created = false;
try {
  await cp('scripts/test-fixtures/project', directory, { recursive: true });
  await rename(
    join(directory, 'application.mjs'),
    join(directory, 'base-application.mjs'),
  );
  await writeFile(
    join(directory, 'application.mjs'),
    `
    import createBase from './base-application.mjs';
    export default function createApplication(api) {
      const base = createBase(api);
      class NativeProbe {
        async read(ctx, { id }) {
          const { rows } = await ctx.mysqlSql.execute(
            'SELECT title FROM items WHERE tenant_id = ? AND id = ?',
            [ctx.principal.tenantId, id],
          );
          return rows[0] ?? null;
        }
        async rename(ctx, { id, title }) {
          const { affectedRows } = await ctx.mysqlSql.execute(
            'UPDATE items SET title = ?, version = version + 1 WHERE tenant_id = ? AND id = ?',
            [title, ctx.principal.tenantId, id],
          );
          if (affectedRows !== 1) throw new api.NotFoundException();
          ctx.recordChange({ table: 'items', documentId: id, operation: 'update', after: { title } });
          return { id, title };
        }
      }
      const methods = NativeProbe.prototype;
      api.ReactiveQuery('native.read')(methods, 'read', Object.getOwnPropertyDescriptor(methods, 'read'));
      api.ReactiveMutation({ name: 'native.rename', validate: (args) => args, authorize: () => {} })(
        methods, 'rename', Object.getOwnPropertyDescriptor(methods, 'rename'),
      );
      class TestApplication {}
      api.Module({ imports: [base.application], providers: [NativeProbe] })(TestApplication);
      return {
        application: TestApplication,
        functions: {
          queries: { ...base.functions.queries, 'native.read': () => {} },
          mutations: [...base.functions.mutations, 'native.rename'],
        },
      };
    }
  `,
  );
  const fixture = await import('./test-fixtures/project/project.json', {
    with: { type: 'json' },
  });
  await writeFile(
    join(directory, 'project.json'),
    JSON.stringify({
      ...fixture.default,
      name,
      mysql: { tables: ['items', 'charges'], nativeSql: true },
    }),
  );
  if (image) {
    for (const dir of ['', 'migrations', 'migrations/mysql']) {
      const path = join(directory, dir);
      await chmod(path, 0o755);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isFile()) await chmod(join(path, entry.name), 0o644);
      }
    }
  }
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

  const baseline = previousImage ? await seedPreviousVersion() : undefined;
  const installed = await cli('provision', directory);
  assert.match(
    installed.stdout,
    baseline
      ? /Applied project\/003_item_reservations.sql/
      : /Applied project\/001_items.sql/,
  );
  assert.doesNotMatch((await cli('provision', directory)).stdout, /Applied /);
  await cli('tenant', directory, tenant);
  await cli('tenant', directory, otherTenant);
  await grantRuntime(true);

  if (useOutage) {
    const { databaseLinks } =
      await import('./test-fixtures/check-database-outage.mjs');
    outageLinks = await databaseLinks(runtimeUrl('reactivecore_app'), 3306);
  }
  const api = start('serve', 'reactivecore_app');
  const signal = AbortSignal.timeout(30000);
  await waitReady(api, signal);
  if (baseline) {
    const detail = await baseline.client.query(
      'items.get',
      { id: baseline.result.data.id },
      signal,
    );
    assert.deepEqual(detail.data, { ...baseline.result.data, version: 1 });
    assert.deepEqual(
      await baseline.client.mutate(
        'items.create',
        baseline.args,
        baseline.key,
        signal,
      ),
      { ...baseline.result, replayed: true },
    );
    assert.deepEqual(
      (
        await baseline.client.query(
          'items.available',
          { offset: 0, limit: 10 },
          signal,
        )
      ).data,
      [{ ...baseline.result.data, version: 1 }],
    );
    console.log(
      'MySQL upgraded from v0.2.0-alpha.1 with existing data and idempotency receipts.',
    );
  }

  const client = await clientFor(tenant);
  const other = await clientFor(otherTenant);
  const stream = client.subscribe('items.list', {}, signal);
  let item;
  try {
    const initial = (await stream.next()).value;
    assert.deepEqual(initial.data, []);
    const key = randomUUID();
    const args = { title: 'Same application, MySQL' };
    await admin.query(
      `ALTER TABLE \`${database}\`.rc_outbox ADD CONSTRAINT reject_test_event CHECK (tenant_id <> '${tenant}' OR event_type <> 'reactive.changed')`,
    );
    try {
      await assert.rejects(client.mutate('items.create', args, key, signal), {
        status: 500,
      });
      assert.deepEqual(await client.query('items.list', {}, signal), {
        data: [],
        seq: initial.seq,
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
  const peer = await clientFor(tenant);
  await checkItemWrites(client, peer, other, signal);
  await checkReservations(client, peer, other, signal);
  await checkBilling(client, other, signal);
  const native = await client.mutate(
    'items.create',
    { title: 'Before native update' },
    randomUUID(),
    signal,
  );
  const nativeArgs = { id: native.data.id, title: 'Native update' };
  await client.mutate('native.rename', nativeArgs, randomUUID(), signal);
  assert.deepEqual(
    (await client.query('native.read', { id: native.data.id }, signal)).data,
    { title: 'Native update' },
  );
  assert.equal(
    (await other.query('native.read', { id: native.data.id }, signal)).data,
    null,
  );

  if (useReplica) {
    const replica = start('serve', 'reactivecore_app', image, directory, {
      port: '4408',
      instance: 'replica',
    });
    await waitReady(replica, AbortSignal.timeout(30000), replicaOrigin);
  }
  if (process.env.RC_LOAD_TEST === '1' || useReplica) {
    const { checkLoad, loadScenarios, loadWriter } =
      await import('./test-fixtures/check-load.mjs');
    for (const scenario of loadScenarios()) {
      const loadTenant = randomUUID();
      await cli('tenant', directory, loadTenant);
      await checkLoad({
        engine: useReplica ? 'mysql-two-replicas' : 'mysql',
        makeClient: (_, index) =>
          clientFor(
            loadTenant,
            undefined,
            useReplica && index % 2 ? replicaOrigin : origin,
          ),
        makeWriter: async (_, index) =>
          loadWriter(
            useReplica && index % 2 ? replicaOrigin : origin,
            await tokenFor(loadTenant),
          ),
        scenario,
        findPublished: async (ids) => {
          const placeholders = ids.map(() => '?').join(', ');
          const [rows] = await admin.execute(
            `SELECT aggregate_id FROM \`${database}\`.rc_outbox WHERE aggregate_id IN (${placeholders}) AND published_at IS NOT NULL`,
            ids,
          );
          return rows.map(({ aggregate_id }) => aggregate_id);
        },
      });
    }
  }
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
  if (mysqlContainer) await checkRestore();
  if (process.env.RC_RETENTION_TEST === '1') {
    const { checkRetention } =
      await import('./test-fixtures/check-retention.mjs');
    const [retained, neighbor] = [randomUUID(), randomUUID()];
    await cli('tenant', directory, retained);
    await cli('tenant', directory, neighbor);
    await checkRetention({
      tenant: retained,
      client: await clientFor(retained),
      neighbor: await clientFor(neighbor),
      databaseUrl: adminUrl,
      ageReceipt: (key) =>
        admin.execute(
          `UPDATE \`${database}\`.rc_receipts SET created_at = CURRENT_TIMESTAMP(6) - INTERVAL 31 DAY
         WHERE tenant_id = ? AND idempotency_key = ?`,
          [retained, key],
        ),
      readState: async () =>
        (
          await admin.execute(
            `SELECT CAST(pruned_through AS CHAR) AS prunedThrough,
          (SELECT CAST(count(*) AS UNSIGNED) FROM \`${database}\`.rc_changes WHERE tenant_id = ?) AS remaining
         FROM \`${database}\`.rc_tenant_clocks WHERE tenant_id = ?`,
            [retained, retained],
          )
        )[0][0],
    });
  }
  if (outageLinks) {
    const { checkDatabaseOutage } =
      await import('./test-fixtures/check-database-outage.mjs');
    const outageTenant = randomUUID();
    await cli('tenant', directory, outageTenant);
    await checkDatabaseOutage({
      engine: 'mysql',
      Client: ReactiveCoreClient,
      origin,
      token: await tokenFor(outageTenant),
      links: outageLinks,
      findPublished: async (ids) => {
        const placeholders = ids.map(() => '?').join(', ');
        const [rows] = await admin.execute(
          `SELECT aggregate_id FROM \`${database}\`.rc_outbox WHERE aggregate_id IN (${placeholders}) AND published_at IS NOT NULL`,
          ids,
        );
        return rows.map(({ aggregate_id }) => aggregate_id);
      },
    });
  }
  if (useReplica) {
    const { checkReplicaFailover } =
      await import('./test-fixtures/check-replica-failover.mjs');
    const failoverTenant = randomUUID();
    await cli('tenant', directory, failoverTenant);
    await checkReplicaFailover({
      engine: 'mysql',
      Client: ReactiveCoreClient,
      primary: origin,
      secondary: replicaOrigin,
      token: await tokenFor(failoverTenant),
      stopPrimary: async () => {
        const closed = once(api, 'exit');
        if (image)
          await exec('docker', ['stop', '--time', '5', `${name}-serve`]);
        else api.kill('SIGTERM');
        await closed;
      },
    });
  }

  console.log(
    'MySQL verified: provision, tenant isolation, rollback, replay, SSE reconnect, and outbox delivery.',
  );
} catch (error) {
  if (logs.length) console.error(logs.join(''));
  throw error;
} finally {
  if (image || previousImage) {
    await Promise.allSettled(
      ['serve', 'replica', 'worker'].map((command) =>
        exec('docker', ['stop', '--time', '5', `${name}-${command}`]),
      ),
    );
  }
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, 'exit');
    child.kill('SIGTERM');
    await closed;
  }
  await outageLinks?.close();
  try {
    if (created) await admin.query(`DROP DATABASE \`${database}\``);
  } finally {
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}
