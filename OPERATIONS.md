# ReactiveCore MultiDB operations

These instructions cover the Linux amd64 alpha image, an existing PostgreSQL 16 server, and Redis. The Docker image runs the provisioning CLI, HTTP API, and outbox worker. Run a separate API and worker for each project.

## Install a release

Once this repository publishes a GitHub prerelease, download the runtime archive, SDK tarball, and `SHA256SUMS` from that release. Until then, follow the [source setup](README.md#1-install-the-prerequisites). Verify the downloads and load the image. Replace the version in the commands with the published tag.

```sh
sha256sum -c SHA256SUMS
docker load -i reactivecore-multidb-v0.1.0-linux-amd64.tar.gz
export RC_IMAGE=reactivecore-multidb:v0.1.0
```

To install the SDK from that release, run `npm install ./reactivecore-client-0.1.0.tgz` from your frontend. The release workflow publishes both files to GitHub Releases.

## Start a deployment

1. Prepare the project directory with `project.json`, `application.mjs`, and `migrations/`. See the [setup guide](README.md). The image runs as the unprivileged `node` user. That user must be able to read the mounted files and any dependencies used by the project factory.
2. Use three separate environment files stored outside version control. Restrict access to them and use URL-encoded passwords in connection strings.

   | File | Variables |
   | --- | --- |
   | `provision.env` | `RC_PROVISION_ADMIN_URL`, plus `RC_PROVISION_APP_PASSWORD` and `RC_PROVISION_WORKER_PASSWORD` when first enabling the roles |
   | `api.env` | `DATABASE_URL` using `reactivecore_app`, `REDIS_URL`, `RC_JWT_ISSUER`, `RC_JWT_AUDIENCE`, `RC_JWKS_URL`, `RC_CORS_ORIGINS`, `RC_HOST=127.0.0.1` |
   | `worker.env` | `DATABASE_URL` using `reactivecore_worker`, `REDIS_URL` |

   The runtime URLs must point to the project's database, such as `reactivecore_my_project`. Use the same Redis channel in both runtimes if you set `RC_INVALIDATION_CHANNEL`. In production, configure an HTTPS JWKS URL and RS256 tokens as described in the README.
3. Run provisioning once. The examples use Linux host networking so URLs that point to host loopback resolve as written.

   ```sh
   export RC_PROJECT=/srv/reactivecore/my-project
   docker run --rm --network host --env-file provision.env \
     --mount "type=bind,src=$RC_PROJECT,dst=/project,readonly" \
     "$RC_IMAGE" provision /project
   ```
4. Start the runtime containers.

   ```sh
   docker run -d --name rc-api --restart unless-stopped --network host \
     --env-file api.env --mount "type=bind,src=$RC_PROJECT,dst=/project,readonly" \
     "$RC_IMAGE" serve /project
   docker run -d --name rc-worker --restart unless-stopped --network host \
     --env-file worker.env --mount "type=bind,src=$RC_PROJECT,dst=/project,readonly" \
     "$RC_IMAGE" worker /project
   curl -fsS http://127.0.0.1:4000/api/health/ready
   ```

Expose the API through an HTTPS reverse proxy. Allow SSE responses to stream without buffering and set a suitable idle timeout. Keep PostgreSQL and Redis accessible only to their consumers.

## Use a managed PostgreSQL database

This walkthrough uses a local PostgreSQL 16 container to reproduce the account separation used by managed services. The provider administrator creates the database and its roles. ReactiveCore then installs the schema using a database owner with neither `CREATEDB` nor `CREATEROLE`.

### 1. Start the infrastructure

Complete steps 1–3 of the [setup guide](README.md#1-install-the-prerequisites) to create the `my-project` example with its `items.list` and `items.create` functions, then start PostgreSQL and Redis. Run the commands below from the repository root. Use a fresh database and the local Compose instance dedicated to the guide. The SQL uses sample passwords for this local walkthrough.

### 2. Create the database and accounts

Run SQL as the Compose administrator. The database owner applies migrations, the API role handles application requests, and the worker role processes the outbox.

```sh
docker compose -p reactivecore-guide --env-file ../my-project/.env.compose \
  exec -T postgres psql -X -v ON_ERROR_STOP=1 -U reactivecore -d postgres <<'SQL'
CREATE ROLE project_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
    PASSWORD 'local_owner_password';
CREATE ROLE reactivecore_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
    PASSWORD 'local_app_password';
CREATE ROLE reactivecore_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
    PASSWORD 'local_worker_password';
CREATE DATABASE reactivecore_my_project OWNER project_owner;
REVOKE CONNECT ON DATABASE reactivecore_my_project FROM PUBLIC;
SQL
```

Expect three `CREATE ROLE` messages, then `CREATE DATABASE` and `REVOKE`. The database name is derived from the project manifest. For `my-project` it is `reactivecore_my_project`.

### 3. Provision the database and register a tenant

Follow this step in place of the README's standard provisioning step. Keep the two provisioning password variables unset because the runtime logins already exist.

```sh
export RC_PROVISION_EXISTING_DATABASE=1
export RC_PROVISION_ADMIN_URL=postgresql://project_owner:local_owner_password@127.0.0.1:56432/reactivecore_my_project
unset RC_PROVISION_APP_PASSWORD RC_PROVISION_WORKER_PASSWORD

npm run project -- provision ../my-project
TENANT_ID=$(node -p 'crypto.randomUUID()')
USER_ID=$(node -p 'crypto.randomUUID()')
npm run project -- tenant ../my-project "$TENANT_ID"
(umask 077 && printf 'TENANT_ID=%s\nUSER_ID=%s\n' "$TENANT_ID" "$USER_ID" > ../my-project/.env.identity)
```

Expect the CLI to print the core migrations, `Applied project/001_items.sql`, and `Provisioned reactivecore_my_project`. Repeat the provision command to verify that it finds the existing project and applies no migration twice. It rejects a first install if the database already contains application objects or additional schemas.

### 4. Run the API and see a live mutation

1. Follow [step 5](README.md#5-run-the-api-and-worker-in-separate-terminals) to start the API and worker in separate terminals. The database URLs in that step match the roles and local passwords above. The readiness endpoint should return `{"status":"ready"}`.
2. Follow [step 6](README.md#6-sign-a-local-development-token-and-query-the-api) to generate a development token. The first query on the newly prepared database should return `{"data":[],"seq":"0"}`.
3. Follow [step 8](README.md#8-create-and-run-a-frontend) to open Vue or Next.js. Paste the development token and click **Connect**. The page should show **Receiving snapshots** with an empty list.
4. In the terminal where you generated the token, run the mutation from [step 7](README.md#7-watch-a-live-update-and-replay-a-mutation). The frontend should display **First live item** without reloading. The second call with the same key should return `replayed: true`, and the frontend should still display a single item. If you already ran step 7, use a fresh key and a different title.

Stop the app processes and use the README's [cleanup command](README.md#troubleshooting) when you are done. It retains the data volumes.

### 5. Apply the same setup on a managed service

1. In the provider console or as a provider administrator, create a dedicated empty PostgreSQL 16 database and the three logins from step 2. Use separate generated passwords. Make the provisioning account the database owner and ensure it can create objects in `public`. If the provider offers database and role creation through its console, use that flow. Verify that it can supply the required runtime roles and privileges before provisioning.
2. Use the direct PostgreSQL endpoint or a session pool for provisioning because the CLI uses session advisory locks. Configure the provider's CA when required, verify the server hostname, and allow connections from the machine running the CLI and from the runtime hosts. Replace the provisioning URL in step 3 with the provider URL and keep `RC_PROVISION_EXISTING_DATABASE=1`.

   ```sh
   export RC_PROVISION_ADMIN_URL='postgresql://project_owner:replace-me@db.example.com:5432/reactivecore_my_project?sslmode=verify-full'
   ```

   URL-encode special characters in passwords. For the Docker deployment, set both provisioning variables in `provision.env` and follow [Start a deployment](#start-a-deployment).
3. Replace the API and worker database URLs with the corresponding provider URLs and keep the runtime logins separate. Configure a reachable Redis endpoint. For an exposed deployment, use the [production authentication and HTTPS settings](README.md#9-configure-a-production-deployment) and obtain tokens from your identity provider. Repeat the readiness, mutation, and SSE checks with that deployment.

The automated integration test covers this privilege model on PostgreSQL 16. The Vue and Next.js examples were also checked in Chromium against a local database owned by a restricted role. Both received an empty initial snapshot and displayed one live item after two requests with the same idempotency key. Provider-specific networking, TLS, and role setup should be verified on the service you choose.

### 6. Run the automated cloud validation

Prepare a dedicated database named `reactivecore_cloud_test` with the three roles from step 2. Start with an empty database on the first run. The workflow installs the test fixture, creates two fresh tenants per run, and leaves the test records for inspection. Use a disposable database and manage its lifecycle through the provider.

Create a GitHub Actions environment named `cloud-postgres-test` and configure these environment secrets:

| Secret | Value |
| --- | --- |
| `RC_CLOUD_OWNER_URL` | Direct PostgreSQL URL for the restricted database owner. |
| `RC_CLOUD_APP_URL` | Direct PostgreSQL URL for `reactivecore_app`. |
| `RC_CLOUD_WORKER_URL` | Direct PostgreSQL URL for `reactivecore_worker`. |
| `RC_CLOUD_CA_PEM` | Optional trusted CA certificate or chain in PEM format if the provider uses a private CA. |

Use the provider's certificate hostname in each URL and append `/reactivecore_cloud_test?sslmode=verify-full` after the host and port. Make the endpoint reachable from the runner. For a private endpoint, use a runner with authorized network access instead of opening PostgreSQL publicly. Run **Validate managed PostgreSQL** from GitHub Actions. The workflow starts a disposable Redis service and keeps the test API bound to loopback.

The test checks TLS on all three connections, rejects a mismatched certificate hostname and a connection with no trusted root, verifies the roles' restricted attributes, and checks tenant isolation through both HTTP and PostgreSQL row-level security. It replays a mutation, checks the SSE snapshot and waits for the worker to mark the outbox event as published. On failure it reports the stage and error code without printing connection URLs.

To run from a machine with database access, build the workspace, supply the three URL variables, and set `RC_CLOUD_REDIS_URL` to a test Redis endpoint. For a private CA, set `NODE_EXTRA_CA_CERTS` to the trusted PEM file before starting Node.

```sh
npm run build
node scripts/test-cloud-postgres.mjs
```

## Back up and rehearse a restore

Use PostgreSQL client tools compatible with the database server. Configure libpq services and credentials using protected files or your infrastructure's credential mechanism. In the example, `rc_project` connects to the live project database and `rc_restore_admin` connects to the `postgres` maintenance database on a separate recovery cluster.

```sh
umask 077
pg_dump --dbname=service=rc_project --format=custom --create --file=project.dump
pg_restore --list project.dump
```

Back up the role definitions and grants separately, for example with your infrastructure configuration or a protected `pg_dumpall --globals-only --no-role-passwords` export. Back up project source and migration files at the matching revision. Keep credentials in a secret store and backups encrypted with restricted access. Use PostgreSQL continuous archiving if your recovery objectives require point-in-time recovery.

1. Create the necessary roles on an isolated recovery cluster, including the original object owners and runtime roles. Restore role credentials from the secret store. Confirm the target project database does not yet exist.
2. Restore the database under its original name so the provisioning manifest and runtime URLs match.

   ```sh
   pg_restore --dbname=service=rc_restore_admin --create --exit-on-error project.dump
   ```
3. Check database access grants, tenant policies, application rows, idempotency receipts, and migration records. Run the API and worker against the restored cluster with a separate Redis endpoint and verify readiness, a tenant query, and a new test mutation with SSE.
4. Record the recovery time and the most recent recovered write. Keep the original database available until the restored environment is verified.

Redis transports invalidation notifications. PostgreSQL holds the durable outbox and change log used to catch up.

## Upgrade a deployed project

1. Record the current image tag and project revision. Restore a recent backup into an isolated staging database. Run the previous image against it, then rehearse the upgrade and run a representative query, mutation replay, SSE subscription, and worker check.
2. During a maintenance window, stop writes and stop the API and worker. Take a fresh backup before applying changes.
3. Load the verified new image. Run its `provision` command with the new project revision and the provisioning environment. Keep applied migration files intact and add new numbered files for schema changes.
4. Recreate the API and worker containers using the new version and their existing runtime configuration. Check readiness and verify that a new mutation reaches the worker and an SSE subscriber.
5. For a compatible schema, reuse the previous image and project revision if necessary. For a schema change that is incompatible with the previous release, restore the pre-upgrade backup to an isolated database and cut over after verification. Account for all writes accepted after that backup before choosing a rollback.

## Monitor and report problems

Check `/api/health/live` for process liveness, `/api/health/ready` for database readiness, and `/api/health` for Redis and PostgreSQL status. Monitor API errors, reconnect rates, and continuously growing outbox lag. Use a separately authorized monitoring connection for outbox metrics. Inspect both runtime logs with `docker logs rc-api` and `docker logs rc-worker`, and run restore drills against your recovery targets. Use the [security policy](SECURITY.md) for private vulnerability reports.

## Cut a release

After reviewing the changes and verifying them in CI, set matching versions in the root and SDK manifests and update the lockfile. Create and push a tag matching the version, such as `v0.1.0`. The tag workflow builds and reloads the image, verifies it with the packaged SDK, restores a test database, then publishes a GitHub prerelease with checksums.
