FROM node:22.19.0-bookworm-slim AS dependencies

WORKDIR /opt/rin

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl g++ git make python3 tar util-linux \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY scripts/install-git-hooks.ts ./scripts/install-git-hooks.ts
# The test gate compiles the Electron host but never launches Electron itself.
# Avoid downloading an unused ~300 MiB desktop runtime on dependency refreshes.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci
RUN mkdir -p /root/.cache/rin/node-toolchain \
  && npm pack npm@10.9.3 --pack-destination /root/.cache/rin/node-toolchain >/dev/null

FROM dependencies AS test-runner

COPY --chown=node:node . /opt/rin/source
RUN ln -s /opt/rin/node_modules /opt/rin/source/node_modules \
  && chown -h node:node /opt/rin/source/node_modules

USER node

ENTRYPOINT ["/opt/rin/source/.ci/local-ci/run-checks.sh"]
