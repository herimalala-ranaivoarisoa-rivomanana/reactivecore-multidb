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
