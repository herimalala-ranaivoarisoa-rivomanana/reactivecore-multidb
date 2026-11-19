FROM node:24-bookworm-slim AS manifests
WORKDIR /opt/reactivecore
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/client/package.json packages/client/

FROM manifests AS build
RUN --mount=type=secret,id=npm_ca,target=/run/secrets/npm_ca \
    if [ -s /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --no-audit --no-fund
COPY apps/api/nest-cli.json apps/api/tsconfig*.json apps/api/
COPY apps/api/src apps/api/src
RUN npm run build -w @reactivecore/api

FROM manifests AS dependencies
RUN --mount=type=secret,id=npm_ca,target=/run/secrets/npm_ca \
    if [ -s /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /opt/reactivecore
ENV NODE_ENV=production RC_HOST=0.0.0.0 PORT=4000
COPY --from=dependencies /opt/reactivecore/ ./
COPY --from=build /opt/reactivecore/apps/api/dist apps/api/dist
COPY LICENSE ./
COPY scripts/reactivecore.mjs scripts/mysql-project.mjs scripts/
COPY scripts/project-template scripts/project-template
COPY db/migrations db/migrations
COPY db/mysql db/mysql
RUN chmod -R a+rX /opt/reactivecore
USER node
EXPOSE 4000
ENTRYPOINT ["node", "scripts/reactivecore.mjs"]
