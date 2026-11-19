import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SignJWT } from 'jose';
import pg from 'pg';
import {
  checkBilling,
  checkItemWrites,
  checkReservations,
} from './test-fixtures/check-item-writes.mjs';

const exec = promisify(execFile);
const name = `items-${randomUUID().slice(0, 8)}`;
const database = name.replaceAll('-', '_');
const appPassword = process.env.LAB_APP_PASSWORD;
const workerPassword = process.env.LAB_WORKER_PASSWORD;
const adminPassword = process.env.POSTGRES_PASSWORD;
const redisPassword = process.env.REDIS_PASSWORD;
const tokenKey = process.env.DEV_API_TOKEN;
if (
  !appPassword ||
  !workerPassword ||
  !adminPassword ||
  !redisPassword ||
  !tokenKey
) {
  throw new Error(
    'Start test infrastructure and pass --env-file=.env.reactivecore-test',
  );
}

const parent = await mkdtemp(join(process.cwd(), '.project-smoke-'));
const directory = join(parent, name);
const pgUrl = (user, password, target) =>
  `postgresql://${user}:${password}@127.0.0.1:${process.env.POSTGRES_PORT}/${target}`;
const databaseName = `reactivecore_${database}`;
const issuer = 'urn:reactivecore:cli-test';
const tenant = randomUUID();
const otherTenant = randomUUID();
const env = {
  ...process.env,
  RC_PROVISION_APP_PASSWORD: appPassword,
  RC_PROVISION_WORKER_PASSWORD: workerPassword,
  RC_PROVISION_ADMIN_URL: pgUrl('reactivecore', adminPassword, 'postgres'),
  DATABASE_URL: pgUrl('reactivecore_app', appPassword, databaseName),
  REDIS_URL: `redis://:${redisPassword}@127.0.0.1:${process.env.REDIS_PORT}`,
  NODE_ENV: 'development',
  RC_HOST: '127.0.0.1',
  PORT: '4403',
  RC_CORS_ORIGINS:
    process.env.RC_BROWSER_CONFLICT_TEST === '1' ? 'http://127.0.0.1:4173' : '',
  RC_JWKS_URL: '',
  RC_JWT_AUDIENCE: `reactivecore:${name}`,
  RC_JWT_ISSUER: issuer,
  RC_JWT_DEV_SECRET: tokenKey,
};
function cli(command, ...args) {
  if (image && ['provision', 'tenant'].includes(command)) {
    const keys = [
      'RC_PROVISION_ADMIN_URL',
      'RC_PROVISION_EXISTING_DATABASE',
      'RC_PROVISION_APP_PASSWORD',
      'RC_PROVISION_WORKER_PASSWORD',
    ];
    return exec(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        '--mount',
        `type=bind,src=${directory},dst=/project,readonly`,
        ...keys.flatMap((key) => ['--env', key]),
        image,
        command,
        '/project',
        ...args.slice(1),
      ],
      { env },
    );
  }
  return exec(
    process.execPath,
    ['scripts/reactivecore.mjs', command, ...args],
    { env },
  );
}
const managed = process.env.RC_TEST_MANAGED_DATABASE === '1';
const owner = `${database}_owner`;
let ownsRole = false;
const origin = 'http://127.0.0.1:4403';
let server;
let replica;
let worker;
const useReplica = process.env.RC_REPLICA_LOAD_TEST === '1';
const replicaOrigin = 'http://127.0.0.1:4407';
let ownsDatabase = false;
const signal = AbortSignal.timeout(60_000);
const logs = [];

const image = process.env.RC_TEST_IMAGE;
const sdkArchive = process.env.RC_TEST_SDK_ARCHIVE;
const restoredDatabase = `${databaseName}_restore`;

function startRuntime(command, runtimeEnv, instance = command) {
  if (!image) {
    return spawn(
      process.execPath,
      ['scripts/reactivecore.mjs', command, directory],
      {
        env: runtimeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  }
  const keys = ['DATABASE_URL', 'REDIS_URL'];
  if (command === 'serve') {
    keys.push(
      'NODE_ENV',
      'RC_HOST',
      'PORT',
      'RC_JWT_ISSUER',
      'RC_JWT_AUDIENCE',
      'RC_JWT_DEV_SECRET',
      'RC_CORS_ORIGINS',
      'RC_PG_MUTATION_CONCURRENCY',
    );
  }
  return spawn(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'host',
      '--name',
      `${name}-${instance}`,
      '--mount',
      `type=bind,src=${directory},dst=/project,readonly`,
      ...keys.flatMap((key) => ['--env', key]),
      image,
      command,
      '/project',
    ],
    { env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function postgresTool(args, input) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      'reactivecore-test',
      '--env-file',
      '.env.reactivecore-test',
      'exec',
      '-T',
      'postgres',
      ...args,
    ],
    { input, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}

try {
  if (sdkArchive) {
    await writeFile(join(parent, 'package.json'), '{"private":true}');
    await exec(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--offline',
        '--no-audit',
        '--no-fund',
        resolve(sdkArchive),
      ],
      { cwd: parent },
    );
  }
  let sdkModule = '@reactivecore/client';
  if (sdkArchive) {
    const entry = join(parent, 'installed-sdk.mjs');
    await writeFile(
      entry,
      "export { ReactiveCoreClient } from '@reactivecore/client';\n",
    );
    sdkModule = pathToFileURL(entry).href;
  }
  const { ReactiveCoreClient } = await import(sdkModule);
  await cli('init', directory);
  await assert.rejects(cli('init', directory));
  const manifestPath = join(directory, 'project.json');
  const empty = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(empty, { name, queries: {}, mutations: {} });
  const fixture = 'scripts/test-fixtures/project';
  const definitions = JSON.parse(
    await readFile(join(fixture, 'project.json'), 'utf8'),
  );
  await writeFile(manifestPath, JSON.stringify({ ...definitions, name }));
  await cp(
    join(fixture, 'application.mjs'),
    join(directory, 'application.mjs'),
  );
  await cp(
    join(fixture, 'migrations/001_items.sql'),
    join(directory, 'migrations/001_items.sql'),
  );
  await cp(
    join(fixture, 'migrations/002_item_writes.sql'),
    join(directory, 'migrations/002_item_writes.sql'),
  );
  await cp(
    join(fixture, 'migrations/003_item_versions.sql'),
    join(directory, 'migrations/003_item_versions.sql'),
  );
  await cp(
    join(fixture, 'migrations/004_item_reservations.sql'),
    join(directory, 'migrations/004_item_reservations.sql'),
  );
  await cp(
    join(fixture, 'migrations/005_item_charges.sql'),
    join(directory, 'migrations/005_item_charges.sql'),
  );
  if (image) {
    await chmod(directory, 0o755);
    await chmod(join(directory, 'migrations'), 0o755);
    for (const file of [
      'project.json',
      'application.mjs',
      'migrations/001_items.sql',
      'migrations/002_item_writes.sql',
      'migrations/003_item_versions.sql',
      'migrations/004_item_reservations.sql',
      'migrations/005_item_charges.sql',
    ]) {
      await chmod(join(directory, file), 0o644);
    }
  }
  await cli('codegen', directory);
  const typed = join(directory, 'type-smoke.ts');
  await writeFile(
    typed,
    `import { createClient } from './client.js';
const client = createClient('http://localhost', () => 'token');
void client.query('items.list', {});
void client.query('items.get', { id: 'item' }).then(({ data }) => {
  // @ts-expect-error Detail results can be null
  return data.title;
});
// @ts-expect-error Invalid generated argument type
void client.mutate('items.create', { title: 42 }, 'id');
`,
  );
  await exec(process.execPath, [
    'node_modules/typescript/bin/tsc',
    '--ignoreConfig',
    '--noEmit',
    '--strict',
    '--module',
    'nodenext',
    '--target',
    'ES2023',
    '--types',
    'node',
    typed,
  ]);
  if (managed) {
    const admin = new pg.Client({
      connectionString: env.RC_PROVISION_ADMIN_URL,
    });
    const password = randomUUID();
    await admin.connect();
    try {
      const {
        rows: [role],
      } = await admin.query(
        "SELECT format('CREATE ROLE %I LOGIN NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS sql",
        [owner, password],
      );
      await admin.query(role.sql);
      ownsRole = true;
      await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${owner}"`);
      ownsDatabase = true;
      // Prepare the runtime roles using the existing cluster bootstrap path.
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reactivecore_app' AND rolcanlogin)
          OR NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reactivecore_worker' AND rolcanlogin)
        THEN RAISE EXCEPTION 'Run the standard integration test before managed mode'; END IF;
      END $$`);
    } finally {
      await admin.end();
    }

    env.RC_PROVISION_ADMIN_URL = pgUrl(owner, password, databaseName);
    env.RC_PROVISION_EXISTING_DATABASE = '1';
    delete env.RC_PROVISION_APP_PASSWORD;
    delete env.RC_PROVISION_WORKER_PASSWORD;
    const projectAdmin = new pg.Client({
      connectionString: env.RC_PROVISION_ADMIN_URL,
    });
    await projectAdmin.connect();
    try {
      await projectAdmin.query('CREATE TABLE public.unrelated_data (id int)');
      await assert.rejects(
        cli('provision', directory),
        /dedicated empty database/,
      );
      await projectAdmin.query('DROP TABLE public.unrelated_data');
    } finally {
      await projectAdmin.end();
    }
  }

  const created = await cli('provision', directory);
  ownsDatabase = true;
  assert.match(created.stdout, /Applied project\/001_items.sql/);
  assert.doesNotMatch((await cli('provision', directory)).stdout, /Applied /);
  const migration = join(directory, 'migrations/001_items.sql');
  const original = await readFile(migration, 'utf8');
  await appendFile(migration, '\n-- Changed after installation\n');
  await assert.rejects(
    cli('provision', directory),
    /Applied migrations were changed/,
  );
  await writeFile(migration, original);
  const failing = join(directory, 'migrations/006_probe.sql');
  await writeFile(
    failing,
    'CREATE TABLE public.migration_probe (id int); SELECT missing_column;',
  );
  if (image) await chmod(failing, 0o644);
  await assert.rejects(
    cli('provision', directory),
    /Migration failed: project\/006_probe.sql/,
  );
  await writeFile(failing, 'CREATE TABLE public.migration_probe (id int);');
  assert.match(
    (await cli('provision', directory)).stdout,
    /Applied project\/006_probe.sql/,
  );
  await cli('tenant', directory, tenant);
  await cli('tenant', directory, otherTenant);

  await appendFile(
    join(directory, 'application.mjs'),
    `
if (process.env.RC_PROVISION_ADMIN_URL) throw new Error('Provisioning credentials reached the API');
`,
  );
  server = startRuntime('serve', env);
  server.stdout.on('data', (chunk) => logs.push(String(chunk)));
  server.stderr.on('data', (chunk) => logs.push(String(chunk)));
  for (;;) {
    if (server.exitCode !== null)
      throw new Error('Generated project failed to start');
    try {
      if ((await fetch(`${origin}/api/health/ready`, { signal })).ok) break;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
    }
    await setTimeout(100, undefined, { signal });
  }
  async function tokenFor(tenantId) {
    return new SignJWT({
      tenant_id: tenantId,
      scope: 'query mutation subscribe',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(randomUUID())
      .setIssuer(issuer)
      .setAudience(env.RC_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(tokenKey));
  }
  async function clientFor(tenantId, apiOrigin = origin) {
    const token = await tokenFor(tenantId);
    return new ReactiveCoreClient(apiOrigin, () => token);
  }
  const client = await clientFor(tenant);
  const stream = client.subscribe('items.list', {}, signal);
  try {
    assert.deepEqual((await stream.next()).value.data, []);
    const key = randomUUID();
    const input = { title: 'Standalone project' };
    // Reject the outbox insert after the handler and journal have already written.
    const fault = new pg.Client({
      connectionString: pgUrl('reactivecore', adminPassword, databaseName),
    });
    await fault.connect();
    try {
      await fault.query(
        "ALTER TABLE public.event_outbox ADD CONSTRAINT reject_test_event CHECK (event_type <> 'reactive.changed')",
      );
      try {
        await assert.rejects(
          client.mutate('items.create', input, key, signal),
          { status: 500 },
        );
        assert.deepEqual(await client.query('items.list', {}, signal), {
          data: [],
          seq: '0',
        });
      } finally {
        await fault.query(
          'ALTER TABLE public.event_outbox DROP CONSTRAINT reject_test_event',
        );
      }
    } finally {
      await fault.end();
    }

    const attempts = await Promise.all([
      client.mutate('items.create', input, key, signal),
      client.mutate('items.create', input, key, signal),
    ]);
    const mutation = attempts.find((result) => !result.replayed);
    assert.ok(mutation);
    assert.deepEqual(
      attempts.find((result) => result.replayed),
      { ...mutation, replayed: true },
    );
    assert.deepEqual((await stream.next()).value.data, [
      { ...mutation.data, version: 1 },
    ]);
    assert.deepEqual((await client.query('items.list', {}, signal)).data, [
      { ...mutation.data, version: 1 },
    ]);
  } finally {
    await stream.return();
  }
  worker = startRuntime('worker', {
    ...env,
    DATABASE_URL: pgUrl('reactivecore_worker', workerPassword, databaseName),
  });
  worker.stdout.on('data', (chunk) => logs.push(String(chunk)));
  worker.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const admin = new pg.Client({
    connectionString: pgUrl('reactivecore', adminPassword, databaseName),
  });
  await admin.connect();
  try {
    const {
      rows: [tables],
    } = await admin.query(
      "SELECT array_agg(tablename::text ORDER BY tablename) AS names FROM pg_tables WHERE schemaname = 'public'",
    );
    assert.deepEqual(tables.names, [
      'charges',
      'event_outbox',
      'items',
      'migration_probe',
      'mutation_execution_receipts',
      'reactive_change_log',
      'reactive_commit_clock',
      'tenants',
    ]);
    for (;;) {
      if (worker.exitCode !== null)
        throw new Error('Project worker failed to start');
      const { rows } = await admin.query(
        'SELECT published_at FROM public.event_outbox',
      );
      assert.equal(rows.length, 1);
      if (rows[0].published_at) break;
      await setTimeout(100, undefined, { signal });
    }
  } finally {
    await admin.end();
  }
  const backup = postgresTool([
    'pg_dump',
    '-U',
    'reactivecore',
    '-Fc',
    databaseName,
  ]);
  postgresTool(['createdb', '-U', 'reactivecore', restoredDatabase]);
  try {
    postgresTool(
      [
        'pg_restore',
        '-U',
        'reactivecore',
        '--exit-on-error',
        '-d',
        restoredDatabase,
      ],
      backup,
    );
    const restored = new pg.Client({
      connectionString: pgUrl('reactivecore', adminPassword, restoredDatabase),
    });
    await restored.connect();
    try {
      assert.deepEqual(
        (await restored.query('SELECT title FROM public.items')).rows,
        [{ title: 'Standalone project' }],
      );
      const {
        rows: [state],
      } = await restored.query(
        `SELECT (SELECT count(*)::int FROM public.mutation_execution_receipts) AS receipts,
                (SELECT count(*)::int FROM public.event_outbox WHERE published_at IS NOT NULL) AS published,
                (SELECT count(*)::int FROM reactivecore_cli.migrations) AS migrations`,
      );
      assert.equal(state.receipts, 1);
      assert.equal(state.published, 1);
      assert.ok(state.migrations >= 2);
    } finally {
      await restored.end();
    }
  } finally {
    postgresTool([
      'dropdb',
      '-U',
      'reactivecore',
      '--if-exists',
      restoredDatabase,
    ]);
  }
  const peer = await clientFor(tenant);
  const other = await clientFor(otherTenant);
  await checkItemWrites(client, peer, other, signal);
  await checkReservations(client, peer, other, signal);
  await checkBilling(client, other, signal);
  if (useReplica) {
    replica = startRuntime('serve', { ...env, PORT: '4407' }, 'replica');
    replica.stdout.on('data', (chunk) => logs.push(String(chunk)));
    replica.stderr.on('data', (chunk) => logs.push(String(chunk)));
    const readySignal = AbortSignal.timeout(30000);
    for (;;) {
      assert.equal(replica.exitCode, null);
      if (
        (
          await fetch(`${replicaOrigin}/api/health/ready`, {
            signal: readySignal,
          }).catch(() => undefined)
        )?.ok
      )
        break;
      await setTimeout(100, undefined, { signal: readySignal });
    }
  }
  if (process.env.RC_LOAD_TEST === '1' || useReplica) {
    const { checkLoad, loadScenarios, loadWriter } =
      await import('./test-fixtures/check-load.mjs');
    for (const scenario of loadScenarios()) {
      const loadTenant = randomUUID();
      await cli('tenant', directory, loadTenant);
      const outbox = new pg.Client({
        connectionString: pgUrl('reactivecore', adminPassword, databaseName),
      });
      await outbox.connect();
      try {
        await checkLoad({
          engine: useReplica ? 'postgres-two-replicas' : 'postgres',
          makeClient: (_, index) =>
            clientFor(
              loadTenant,
              useReplica && index % 2 ? replicaOrigin : origin,
            ),
          makeWriter: async (_, index) =>
            loadWriter(
              useReplica && index % 2 ? replicaOrigin : origin,
              await tokenFor(loadTenant),
            ),
          scenario,
          findPublished: async (ids) => {
            const { rows } = await outbox.query(
              'SELECT aggregate_id FROM public.event_outbox WHERE aggregate_id = ANY($1::uuid[]) AND published_at IS NOT NULL',
              [ids],
            );
            return rows.map(({ aggregate_id }) => aggregate_id);
          },
        });
      } finally {
        await outbox.end();
      }
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
  if (useReplica) {
    const { checkReplicaFailover } =
      await import('./test-fixtures/check-replica-failover.mjs');
    const failoverTenant = randomUUID();
    await cli('tenant', directory, failoverTenant);
    await checkReplicaFailover({
      engine: 'postgres',
      Client: ReactiveCoreClient,
      primary: origin,
      secondary: replicaOrigin,
      token: await tokenFor(failoverTenant),
      stopPrimary: async () => {
        const closed = new Promise((resolve) => server.once('exit', resolve));
        if (image)
          await exec('docker', ['stop', '--time', '5', `${name}-serve`]);
        else server.kill('SIGTERM');
        await closed;
      },
    });
  }
  console.log(
    'CLI verified: generated types, repeatable and atomic migrations, live SDK update, worker acknowledgment, and database restore.',
  );
} catch (error) {
  if (logs.length) console.error(logs.join(''));
  throw error;
} finally {
  if (image) {
    await Promise.allSettled(
      ['serve', 'replica', 'worker'].map((command) =>
        exec('docker', ['stop', '--time', '5', `${name}-${command}`]),
      ),
    );
  }
  for (const child of [worker, replica, server]) {
    if (!child || child.exitCode !== null || child.signalCode !== null)
      continue;
    const closed = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await closed;
  }
  try {
    if (ownsDatabase || ownsRole) {
      const admin = new pg.Client({
        connectionString: pgUrl('reactivecore', adminPassword, 'postgres'),
      });
      await admin.connect();
      try {
        if (ownsDatabase) await admin.query(`DROP DATABASE "${databaseName}"`);
        if (ownsRole) await admin.query(`DROP ROLE "${owner}"`);
      } finally {
        await admin.end();
      }
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
