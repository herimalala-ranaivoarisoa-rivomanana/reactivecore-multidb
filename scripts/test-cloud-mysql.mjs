import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const name = 'cloud-mysql-test';
const database = 'reactivecore_cloud_mysql_test';
const origin = 'http://127.0.0.1:4406';
let stage = 'configuration';

function urlFrom(key, role) {
  const url = new URL(process.env[key] ?? '');
  assert.equal(url.protocol, 'mysql:');
  assert.equal(decodeURIComponent(url.pathname), `/${database}`);
  assert.equal(url.search, '?ssl=verify-full');
  assert.ok(url.hostname && !isIP(url.hostname.replace(/^\[|\]$/g, '')));
  assert.ok(url.username && url.password);
  if (role) assert.equal(decodeURIComponent(url.username), role);
  return url;
}

async function connect(url, ssl = {}) {
  const direct = new URL(url);
  direct.search = '';
  return createConnection({
    uri: direct.href,
    connectTimeout: 8000,
    ssl: { rejectUnauthorized: true, verifyIdentity: true, ...ssl },
  });
}

async function inspect(url, forbiddenTable) {
  const db = await connect(url);
  try {
    const [[identity]] = await db.query(
      'SELECT CURRENT_USER() AS account, VERSION() AS version',
    );
    assert.ok(
      identity.account.startsWith(`${decodeURIComponent(url.username)}@`),
    );
    assert.match(identity.version, /^8\.4\./);
    const [[status]] = await db.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    assert.ok(status?.Value);
    if (forbiddenTable) {
      await assert.rejects(
        db.query(`SELECT 1 FROM \`${forbiddenTable}\` LIMIT 0`),
        { code: 'ER_TABLEACCESS_DENIED_ERROR' },
      );
    }
  } finally {
    await db.end();
  }
}

async function run() {
  const mode = process.env.RC_MYSQL_CLOUD_MODE || 'validate';
  assert.ok(['validate', 'checkpoint', 'restore'].includes(mode));
  const owner = urlFrom('RC_MYSQL_CLOUD_OWNER_URL');
  const app = urlFrom('RC_MYSQL_CLOUD_APP_URL', 'reactivecore_app');
  const worker = urlFrom('RC_MYSQL_CLOUD_WORKER_URL', 'reactivecore_worker');
  assert.ok(
    !['reactivecore_app', 'reactivecore_worker'].includes(
      decodeURIComponent(owner.username),
    ),
  );
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  const redis = process.env.RC_MYSQL_CLOUD_REDIS_URL;
  assert.ok(redis);

  const endpoint = createHash('sha256')
    .update(
      `${owner.hostname.toLowerCase().replace(/\.$/, '')}:${owner.port || '3306'}`,
    )
    .digest('hex');
  assert.equal(app.host, owner.host);
  assert.equal(worker.host, owner.host);
  const checkpointPath = process.env.RC_MYSQL_CLOUD_CHECKPOINT_FILE;
  assert.ok(mode !== 'checkpoint' || checkpointPath);
  const checkpoint =
    mode === 'restore'
      ? JSON.parse(process.env.RC_MYSQL_CLOUD_CHECKPOINT_JSON ?? '')
      : undefined;
  if (checkpoint) {
    assert.equal(checkpoint.version, 1);
    stage = 'restore checkpoint and target endpoint';
    assert.match(checkpoint.source, /^[a-f0-9]{64}$/);
    assert.notEqual(checkpoint.source, endpoint);
    for (const field of ['tenant', 'subject', 'key']) {
      assert.match(checkpoint[field], /^[a-f0-9-]{36}$/);
    }
    assert.equal(checkpoint.receipt.replayed, false);
  }
  assert.ok(mode !== 'restore' || checkpoint);

  stage = 'TLS and database roles';
  await inspect(owner);
  await assert.rejects(
    async () => {
      const connection = await connect(owner, { ca: [] });
      await connection.end();
    },
    (error) => /certificate/i.test(error.message),
  );

  const project = await mkdtemp(join(tmpdir(), 'rc-cloud-mysql-'));
  const children = [];
  const secret = randomBytes(32).toString('hex');
  const issuer = 'urn:reactivecore:cloud-mysql-validation';
  const audience = `reactivecore:${name}`;
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    RC_JWKS_URL: '',
    RC_JWT_DEV_SECRET: secret,
    RC_JWT_ISSUER: issuer,
    RC_JWT_AUDIENCE: audience,
    RC_HOST: '127.0.0.1',
    PORT: '4406',
    REDIS_URL: redis,
    RC_INVALIDATION_CHANNEL: `reactivecore:cloud-mysql:${randomUUID()}`,
  };
  for (const key of Object.keys(env))
    if (key.startsWith('RC_MYSQL_CLOUD_') || key.startsWith('RC_PROVISION_'))
      delete env[key];

  function cli(command, ...args) {
    return exec(
      process.execPath,
      ['scripts/reactivecore.mjs', command, project, ...args],
      {
        env: { ...env, RC_PROVISION_ADMIN_URL: owner.href },
        timeout: 30000,
      },
    );
  }

  function start(command, DATABASE_URL) {
    const processHandle = spawn(
      process.execPath,
      ['scripts/reactivecore.mjs', command, project],
      {
        env: { ...env, DATABASE_URL },
        stdio: 'ignore',
      },
    );
    children.push(processHandle);
    return processHandle;
  }

  async function makeClient(tenant, subject = randomUUID()) {
    const token = await new SignJWT({
      tenant_id: tenant,
      scope: 'query mutation subscribe',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret));
    return new ReactiveCoreClient(origin, () => token);
  }

  try {
    stage = 'repeatable provisioning and runtime grants';
    await cp('scripts/test-fixtures/project', project, { recursive: true });
    await writeFile(
      join(project, 'project.json'),
      JSON.stringify({ name, mysql: { tables: ['items', 'charges'] } }),
    );
    if (!checkpoint) {
      await cli('provision');
      assert.doesNotMatch((await cli('provision')).stdout, /Applied /);
    }
    await Promise.all([inspect(app, 'rc_project'), inspect(worker, 'items')]);

    stage = 'tenant setup and readiness';
    const tenant = checkpoint?.tenant ?? randomUUID();
    const otherTenant = randomUUID();
    const subject = checkpoint?.subject ?? randomUUID();
    if (!checkpoint) {
      await cli('tenant', tenant);
      await cli('tenant', otherTenant);
    }
    const api = start('serve', app.href);
    const signal = AbortSignal.timeout(90000);
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
      await setTimeout(200, undefined, { signal });
    }
    const client = await makeClient(tenant, subject);
    const runner = start('worker', worker.href);
    let publishedId;
    let checkpointRecord;

    if (checkpoint) {
      stage = 'restored mutation receipt';
      const replay = await client.mutate(
        'items.create',
        checkpoint.args,
        checkpoint.key,
        signal,
      );
      assert.deepEqual(replay, { ...checkpoint.receipt, replayed: true });
      stage = 'restored rows and new SSE delivery';
      const controller = new AbortController();
      const stream = client.subscribe(
        'items.list',
        {},
        AbortSignal.any([signal, controller.signal]),
      );
      try {
        const before = (await stream.next()).value.data;
        assert.equal(
          before.filter(({ id }) => id === replay.data.id).length,
          1,
        );
        const fresh = await client.mutate(
          'items.create',
          { title: 'Managed MySQL restored instance probe' },
          randomUUID(),
          signal,
        );
        assert.equal(fresh.replayed, false);
        assert.ok(BigInt(fresh.commitSeq) > BigInt(replay.commitSeq));
        for (;;) {
          const snapshot = await stream.next();
          assert.equal(snapshot.done, false);
          if (BigInt(snapshot.value.seq) < BigInt(fresh.commitSeq)) continue;
          assert.equal(
            snapshot.value.data.filter(({ id }) => id === fresh.data.id).length,
            1,
          );
          break;
        }
        publishedId = fresh.data.id;
      } finally {
        controller.abort();
        await stream.return();
      }
    } else {
      const peer = await makeClient(tenant);
      const other = await makeClient(otherTenant);
      stage = 'idempotency, isolation, reservations, and reactive reporting';
      const args = { title: 'Cloud MySQL validation item' };
      const key = randomUUID();
      const receipt = await client.mutate('items.create', args, key, signal);
      assert.deepEqual(await client.mutate('items.create', args, key, signal), {
        ...receipt,
        replayed: true,
      });
      await checkItemWrites(client, peer, other, signal);
      await checkReservations(client, peer, other, signal);
      await checkBilling(client, other, signal);
      publishedId = receipt.data.id;
      if (mode === 'checkpoint') {
        stage = 'checkpoint mutation';
        const args = { title: 'Managed MySQL snapshot checkpoint' };
        const key = randomUUID();
        const receipt = await client.mutate('items.create', args, key, signal);
        publishedId = receipt.data.id;
        checkpointRecord = {
          version: 1,
          source: endpoint,
          tenant,
          subject,
          key,
          args,
          receipt,
        };
      }
    }

    stage = 'worker delivery';
    const db = await connect(worker);
    try {
      for (;;) {
        assert.equal(runner.exitCode, null);
        const [[row]] = await db.execute(
          'SELECT COUNT(*) AS count FROM rc_outbox WHERE aggregate_id = ? AND published_at IS NOT NULL',
          [publishedId],
        );
        if (Number(row.count) > 0) break;
        await setTimeout(200, undefined, { signal });
      }
    } finally {
      await db.end();
    }
    if (mode === 'checkpoint') {
      stage = 'checkpoint output';
      await writeFile(checkpointPath, JSON.stringify(checkpointRecord), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    console.log(`Managed MySQL ${mode} passed.`);
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }),
    );
    await rm(project, { recursive: true, force: true });
  }
}

try {
  await run();
} catch (error) {
  const code =
    typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? ` (${error.code})`
      : '';
  console.error(`Managed MySQL validation failed during ${stage}${code}.`);
  process.exitCode = 1;
}
