import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { createConnection } from 'mysql2/promise';

export function mysqlTables(manifest) {
  const list = manifest.mysql?.tables;
  if (
    !Array.isArray(list) ||
    !list.length ||
    new Set(list).size !== list.length ||
    list.some(
      (table) =>
        typeof table !== 'string' ||
        !/^[a-z_][a-z0-9_]{0,62}$/.test(table) ||
        table.startsWith('rc_'),
    )
  ) {
    throw new Error(
      'Configure unique application table names in project.json under mysql.tables',
    );
  }
  return list;
}

async function applyMigrations(connection, path, prefix) {
  const files = (await readdir(path))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const pending = [];
  const versions = new Set();
  for (const file of files) {
    if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(file))
      throw new Error(`Invalid MySQL migration: ${file}`);
    const version = file.slice(0, 3);
    if (versions.has(version))
      throw new Error(
        `Duplicate MySQL migration number in ${path}: ${version}`,
      );
    versions.add(version);
    const sql = await readFile(join(path, file), 'utf8');
    pending.push({
      name: `${prefix}/${file}`,
      sql,
      hash: createHash('sha256').update(sql).digest('hex'),
    });
  }
  const [stored] = await connection.execute(
    'SELECT name, hash FROM rc_migrations WHERE name LIKE ?',
    [`${prefix}/%`],
  );
  const known = new Map(stored.map(({ name, hash }) => [name, hash]));
  for (const [name, hash] of known) {
    if (
      !pending.some(
        (migration) => migration.name === name && migration.hash === hash,
      )
    )
      throw new Error(
        `Applied MySQL migration was removed or changed: ${name}`,
      );
  }
  for (const { name, sql, hash } of pending) {
    if (known.has(name)) continue;
    await connection.query(sql);
    await connection.execute(
      'INSERT INTO rc_migrations (name, hash) VALUES (?, ?)',
      [name, hash],
    );
    console.log(`Applied ${name}`);
  }
}

export async function administerMysql({
  root,
  directory,
  manifest,
  database,
  admin,
  command,
  id,
}) {
  const url = new URL(admin);
  if (decodeURIComponent(url.pathname) !== `/${database}`)
    throw new Error(
      `MySQL provisioning URL must point to the pre-created ${database}`,
    );
  const tls = url.searchParams.get('ssl');
  if (
    [...url.searchParams.keys()].some((key) => key !== 'ssl') ||
    (tls !== null && tls !== 'verify-full')
  )
    throw new Error('MySQL URL supports only ssl=verify-full');
  if (tls && isIP(url.hostname.replace(/^\[|\]$/g, '')))
    throw new Error('Use the certificate DNS hostname for MySQL TLS');
  url.search = '';
  const connection = await createConnection({
    uri: url.href,
    connectTimeout: 5000,
    multipleStatements: true,
    ...(tls ? { ssl: { rejectUnauthorized: true, verifyIdentity: true } } : {}),
  });
  try {
    const [[lock]] = await connection.execute(
      'SELECT GET_LOCK(?, 10) AS acquired',
      [`reactivecore:${database}`],
    );
    if (lock.acquired !== 1)
      throw new Error('Could not acquire MySQL provisioning lock');

    const [tables] = await connection.query(
      'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
    );
    const names = new Set(tables.map(({ name }) => name));
    if (!names.has('rc_project')) {
      if (command !== 'provision' || names.size)
        throw new Error(
          'First MySQL provision requires a dedicated empty database',
        );
      await connection.query(
        'CREATE TABLE rc_project (id TINYINT PRIMARY KEY CHECK (id = 1), name VARCHAR(40) NOT NULL) ENGINE=InnoDB',
      );
      await connection.execute(
        'INSERT INTO rc_project (id, name) VALUES (1, ?)',
        [manifest.name],
      );
    }
    const [[marker]] = await connection.query(
      'SELECT name FROM rc_project WHERE id = 1',
    );
    if (marker?.name !== manifest.name)
      throw new Error('Database belongs to another project');

    if (command === 'tenant') {
      await connection.execute(
        'INSERT INTO rc_tenants (id) VALUES (?) ON DUPLICATE KEY UPDATE id = id',
        [id.toLowerCase()],
      );
      return;
    }

    const applicationTables = mysqlTables(manifest);
    await connection.query(
      'CREATE TABLE IF NOT EXISTS rc_migrations (name VARCHAR(255) PRIMARY KEY, hash CHAR(64) NOT NULL) ENGINE=InnoDB',
    );
    await applyMigrations(connection, join(root, 'db/mysql'), 'core');
    await applyMigrations(
      connection,
      join(directory, 'migrations/mysql'),
      'project',
    );
    for (const table of applicationTables) {
      const [[schema]] = await connection.execute(
        `SELECT ENGINE AS engine,
          EXISTS (SELECT 1 FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'tenant_id') AS tenant_scoped
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table, table],
      );
      if (schema?.engine !== 'InnoDB' || schema.tenant_scoped !== 1)
        throw new Error(
          `MySQL application table must be InnoDB and define tenant_id: ${table}`,
        );
    }
    console.log(`Provisioned ${database}`);
  } finally {
    await connection.end();
  }
}
