import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SignJWT } from 'jose';
import pg from 'pg';
import { ReactiveCoreClient } from '@reactivecore/client';

const exec = promisify(execFile);
const database = 'reactivecore_cloud_test';
const origin = 'http://127.0.0.1:4404';
const issuer = 'urn:reactivecore:cloud-test';
const audience = 'reactivecore:cloud-test';
const secret = randomBytes(32).toString('hex');
let stage = 'configuration';

function connectionUrl(variable, role) {
  const url = new URL(process.env[variable] ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(decodeURIComponent(url.pathname), `/${database}`);
  assert.deepEqual(url.searchParams.getAll('sslmode'), ['verify-full']);
  for (const key of url.searchParams.keys())
    assert.ok(
      ['sslmode', 'sslrootcert'].includes(key),
      'Use TLS parameters only',
    );
  if (role) assert.equal(decodeURIComponent(url.username), role);
  return url.href;
}

async function withConnection(url, callback) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 8000,
  });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function checkRole(url) {
  await withConnection(url, async (client) => {
    const {
      rows: [role],
    } = await client.query(`
      SELECT current_user AS name, ssl, rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls AS elevated
      FROM pg_roles CROSS JOIN pg_stat_ssl
      WHERE rolname = current_user AND pid = pg_backend_pid()
    `);
    assert.equal(role.ssl, true);
    assert.equal(role.elevated, false);
  });
}

async function checkTlsRejections(url) {
  const direct = new URL(url);
  const root = direct.searchParams.get('sslrootcert');
  direct.search = '';
  const trustedCa = root ? { ca: await readFile(root) } : {};

  async function expectRejected(ssl, expectedError) {
    const client = new pg.Client({
      connectionString: direct.href,
      connectionTimeoutMillis: 8000,
      ssl: { ...ssl, rejectUnauthorized: true },
    });
    try {
      await assert.rejects(client.connect(), expectedError);
    } finally {
      await client.end();
    }
  }

  await expectRejected(
    {
      ...trustedCa,
      checkServerIdentity: (_host, cert) =>
        checkServerIdentity('unrelated-host.invalid', cert),
    },
    { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
  );
  await expectRejected(
    { ca: [] },
    {
      code: /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?)$/,
    },
  );
}

async function waitFor(check, signal) {
  for (;;) {
    signal.throwIfAborted();
    if (await check()) return;
    await setTimeout(200, undefined, { signal });
  }
}

async function run() {
  const adminUrl = connectionUrl('RC_CLOUD_OWNER_URL');
  const appUrl = connectionUrl('RC_CLOUD_APP_URL', 'reactivecore_app');
  const workerUrl = connectionUrl('RC_CLOUD_WORKER_URL', 'reactivecore_worker');
  const redisUrl = process.env.RC_CLOUD_REDIS_URL;
  assert.ok(redisUrl);
  assert.ok(
    !['reactivecore_app', 'reactivecore_worker'].includes(
      decodeURIComponent(new URL(adminUrl).username),
    ),
  );
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');

  stage = 'TLS and role checks';
  await checkRole(adminUrl);
  await checkTlsRejections(adminUrl);

  const directory = await mkdtemp(join(tmpdir(), 'reactivecore-cloud-'));
  const children = [];
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    RC_JWKS_URL: '',
    RC_JWT_DEV_SECRET: secret,
    RC_JWT_ISSUER: issuer,
    RC_JWT_AUDIENCE: audience,
    RC_HOST: '127.0.0.1',
    PORT: '4404',
    REDIS_URL: redisUrl,
    RC_INVALIDATION_CHANNEL: `reactivecore:cloud-test:${randomUUID()}`,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('RC_CLOUD_') || key.startsWith('RC_PROVISION_'))
      delete env[key];
  }
  const cliArgs = (command, ...args) => [
    'scripts/reactivecore.mjs',
    command,
    directory,
    ...args,
  ];
  const provisionEnv = {
    ...env,
    RC_PROVISION_EXISTING_DATABASE: '1',
    RC_PROVISION_ADMIN_URL: adminUrl,
  };
  const provision = (command, ...args) =>
    exec(process.execPath, cliArgs(command, ...args), {
      env: provisionEnv,
      timeout: 25000,
    });
  function start(command, DATABASE_URL) {
    const child = spawn(process.execPath, cliArgs(command), {
      stdio: 'ignore',
      env: { ...env, DATABASE_URL },
    });
    children.push(child);
    return child;
  }

  try {
    stage = 'project provisioning';
    await cp('scripts/test-fixtures/project', directory, { recursive: true });
    await writeFile(
      join(directory, 'project.json'),
      JSON.stringify({ name: 'cloud-test' }),
    );
    await provision('provision');
    assert.doesNotMatch((await provision('provision')).stdout, /Applied /);

    stage = 'runtime TLS and role checks';
    await Promise.all([appUrl, workerUrl].map(checkRole));

    stage = 'tenant registration and runtime readiness';
    const tenant = randomUUID();
    const otherTenant = randomUUID();
    await provision('tenant', tenant);
    await provision('tenant', otherTenant);
    const server = start('serve', appUrl);
    const signal = AbortSignal.timeout(45000);
    await waitFor(async () => {
      assert.equal(server.exitCode, null);
      const response = await fetch(`${origin}/api/health/ready`, {
        signal,
      }).catch(() => undefined);
      return response?.ok;
    }, signal);
    async function makeClient(tenantId) {
      const token = await new SignJWT({
        tenant_id: tenantId,
        scope: 'query mutation subscribe',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(randomUUID())
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(secret));
      return new ReactiveCoreClient(origin, () => token);
    }
    const client = await makeClient(tenant);
    const otherClient = await makeClient(otherTenant);

    stage = 'mutation replay, tenant isolation, and SSE';
    const stream = client.subscribe('items.list', {}, signal);
    let item;
    try {
      assert.deepEqual((await stream.next()).value.data, []);
      const key = randomUUID();
      const args = { title: 'Cloud validation item' };
      const first = await client.mutate('items.create', args, key, signal);
      const replay = await client.mutate('items.create', args, key, signal);
      assert.equal(first.replayed, false);
      assert.deepEqual(replay, { ...first, replayed: true });
      item = { ...first.data, version: 1 };
      assert.deepEqual((await stream.next()).value.data, [item]);
      assert.deepEqual(
        (await otherClient.query('items.list', {}, signal)).data,
        [],
      );
      await withConnection(appUrl, async (connection) => {
        await connection.query('BEGIN');
        await connection.query("SELECT set_config('app.tenant_id', $1, true)", [
          otherTenant,
        ]);
        const { rowCount } = await connection.query(
          'SELECT id FROM public.items WHERE id = $1',
          [item.id],
        );
        assert.equal(rowCount, 0);
        await connection.query('ROLLBACK');
      });
    } finally {
      await stream.return();
    }

    stage = 'outbox worker';
    const worker = start('worker', workerUrl);
    await withConnection(workerUrl, async (connection) => {
      await waitFor(async () => {
        assert.equal(worker.exitCode, null);
        const { rowCount } = await connection.query(
          'SELECT 1 FROM public.event_outbox WHERE aggregate_id = $1 AND published_at IS NOT NULL',
          [item.id],
        );
        return rowCount === 1;
      }, signal);
    });
    console.log(
      'Cloud PostgreSQL validation passed: TLS, restricted roles, tenant isolation, idempotency, SSE, and outbox.',
    );
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, 'exit');
        child.kill('SIGTERM');
        await closed;
      }),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  await run();
} catch (error) {
  const code =
    typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? ` (${error.code})`
      : '';
  console.error(`Cloud PostgreSQL validation failed during ${stage}${code}.`);
  process.exitCode = 1;
}
