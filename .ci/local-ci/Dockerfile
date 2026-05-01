FROM node:22-bookworm-slim

WORKDIR /opt/rin

RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 make g++ util-linux \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY scripts/install-git-hooks.mjs ./scripts/install-git-hooks.mjs

RUN npm ci

COPY .ci/local-ci/run-checks.sh /usr/local/bin/rin-local-ci-runner
RUN chmod +x /usr/local/bin/rin-local-ci-runner

ENTRYPOINT ["/usr/local/bin/rin-local-ci-runner"]
