import pg from 'pg';

const tenant = process.env.RC_RETENTION_TENANT;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function positiveInteger(name, maximum) {
  const input = process.env[name];
  if (input === undefined) return undefined;
  const value = Number(input);
  if (
    !/^\d+$/.test(input) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  )
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return value;
}

async function open(url) {
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'postgres:' || url.protocol === 'postgresql:') {
    if (
      !loopback &&
      (url.search !== '?sslmode=verify-full' ||
        process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    )
      throw new Error(
        'Remote PostgreSQL retention requires sslmode=verify-full',
      );
    const client = new pg.Client({
      connectionString: url.href,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      lock_timeout: 2000,
    });
    await client.connect();
    return {
      postgres: true,
      async query(sql, values = []) {
        const result = await client.query(sql, values);
        return { rows: result.rows, count: result.rowCount };
      },
      close: () => client.end(),
    };
  }
  if (
    url.protocol !== 'mysql:' ||
    (!loopback && url.search !== '?ssl=verify-full')
  )
    throw new Error(
      'Use a PostgreSQL or MySQL URL with verified TLS for remote databases',
    );
  const tls = url.search === '?ssl=verify-full';
  if (
    (url.search && !tls) ||
    (tls && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
  )
    throw new Error('MySQL retention supports ssl=verify-full');
  url.search = '';
  const { createConnection } = await import('mysql2/promise');
  const client = await createConnection({
    uri: url.href,
    connectTimeout: 5000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    ...(tls ? { ssl: { rejectUnauthorized: true, verifyIdentity: true } } : {}),
  });
  try {
    await client.query('SET SESSION innodb_lock_wait_timeout = 2');
  } catch (error) {
    await client.end();
    throw error;
  }
  return {
    postgres: false,
    async query(sql, values = []) {
      const [result] = values.length
        ? await client.execute(sql, values)
        : await client.query(sql);
      return {
        rows: Array.isArray(result) ? result : [],
        count: result.affectedRows,
      };
    },
    close: () => client.end(),
  };
}

async function pruneChanges(db, keepCommits, tenant) {
  const clock = db.postgres
    ? 'public.reactive_tenant_clocks'
    : 'rc_tenant_clocks';
  const journal = db.postgres ? 'public.reactive_change_log' : 'rc_changes';
  const tenantParam = db.postgres ? '$1' : '?';
  const sequenceParam = db.postgres ? '$2::bigint' : 'CAST(? AS UNSIGNED)';
  await db.query('BEGIN');
  try {
    const {
      rows: [state],
    } = await db.query(
      `SELECT last_seq, pruned_through FROM ${clock} WHERE tenant_id = ${tenantParam} FOR UPDATE`,
      [tenant],
    );
    let removed = 0;
    if (
      state &&
      BigInt(state.last_seq) - BigInt(state.pruned_through) >
        BigInt(keepCommits)
    ) {
      const through = String(BigInt(state.last_seq) - BigInt(keepCommits));
      const {
        rows: [batch],
      } = await db.query(
        `SELECT MAX(seq) AS last_seq FROM (
           SELECT DISTINCT seq FROM ${journal}
           WHERE tenant_id = ${tenantParam} AND seq <= ${sequenceParam}
           ORDER BY seq LIMIT 100
         ) AS commits`,
        [tenant, through],
      );
      const boundary = batch.last_seq;
      if (boundary != null) {
        ({ count: removed } = await db.query(
          `DELETE FROM ${journal} WHERE tenant_id = ${tenantParam} AND seq <= ${sequenceParam}`,
          [tenant, boundary],
        ));
        await db.query(
          db.postgres
            ? `UPDATE ${clock} SET pruned_through = $2 WHERE tenant_id = $1`
            : `UPDATE ${clock} SET pruned_through = CAST(? AS UNSIGNED) WHERE tenant_id = ?`,
          db.postgres ? [tenant, boundary] : [boundary, tenant],
        );
      }
    }
    await db.query('COMMIT');
    return removed;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function compactReceipts(db, days, tenant) {
  const postgres = `WITH candidates AS (
      SELECT tenant_id, principal_id, mutation_name, idempotency_key
      FROM public.mutation_execution_receipts
      WHERE tenant_id = $1 AND NOT response_expired AND commit_seq IS NOT NULL
        AND created_at < now() - $2::int * interval '1 day'
      ORDER BY created_at LIMIT 1000 FOR UPDATE SKIP LOCKED
    )
    UPDATE public.mutation_execution_receipts AS receipt
    SET response = 'null'::jsonb, response_expired = true
    FROM candidates WHERE (receipt.tenant_id, receipt.principal_id,
      receipt.mutation_name, receipt.idempotency_key) =
      (candidates.tenant_id, candidates.principal_id, candidates.mutation_name, candidates.idempotency_key)`;
  const mysql = `UPDATE rc_receipts SET response = CAST('null' AS JSON), response_expired = true
    WHERE tenant_id = ? AND NOT response_expired AND commit_seq IS NOT NULL
      AND created_at < TIMESTAMPADD(DAY, ?, CURRENT_TIMESTAMP(6))
    ORDER BY created_at LIMIT 1000`;
  const { count } = await db.query(db.postgres ? postgres : mysql, [
    tenant,
    db.postgres ? days : -days,
  ]);
  return count;
}

async function retainData(url, tenantId, keepCommits, days) {
  const db = await open(new URL(url));
  try {
    return {
      journalRowsPruned:
        keepCommits === undefined
          ? 0
          : await pruneChanges(db, keepCommits, tenantId),
      receiptResponsesCompacted:
        days === undefined ? 0 : await compactReceipts(db, days, tenantId),
    };
  } finally {
    await db.close();
  }
}

try {
  const keepCommits = positiveInteger('RC_RETENTION_KEEP_COMMITS', 1000000000);
  const days = positiveInteger('RC_RETENTION_RECEIPT_DAYS', 36500);
  if (
    !uuid.test(tenant ?? '') ||
    (keepCommits === undefined && days === undefined)
  )
    throw new Error('Configure a tenant and at least one retention policy');
  console.log(
    JSON.stringify(
      await retainData(
        process.env.RC_RETENTION_DATABASE_URL,
        tenant,
        keepCommits,
        days,
      ),
    ),
  );
} catch (error) {
  const code =
    typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? ` (${error.code})`
      : '';
  console.error(
    `Retention failed${code}. Check the database, tenant, permissions, and retention policy.`,
  );
  process.exitCode = 1;
}
