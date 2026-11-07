FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/resip
COPY --chmod=0644 package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chmod=0644 agent.mjs appraise.mjs core.mjs claim-state.mjs drain-preflight.mjs lease.mjs guest-action.mjs state.mjs gateway.mjs control-policy.json line-policy.json ./
COPY --chmod=0755 dsmack-egress /usr/local/bin/dsmack-egress
