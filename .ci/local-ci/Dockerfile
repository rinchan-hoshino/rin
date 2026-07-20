FROM node:22-bookworm-slim

WORKDIR /opt/rin

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl g++ git make python3 tar util-linux \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY scripts/install-git-hooks.ts ./scripts/install-git-hooks.ts
RUN npm ci
RUN mkdir -p /root/.cache/rin/node-toolchain \
  && npm pack npm@10.9.3 --pack-destination /root/.cache/rin/node-toolchain >/dev/null

COPY .ci/local-ci/run-checks.sh /usr/local/bin/rin-local-ci-runner
RUN chmod +x /usr/local/bin/rin-local-ci-runner

ENTRYPOINT ["/usr/local/bin/rin-local-ci-runner"]
