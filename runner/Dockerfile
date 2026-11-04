# syntax=docker/dockerfile:1
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

ARG CLAUDE_CODE_VERSION=2.1.318
ARG CODEX_VERSION=0.166.0
ARG OPENCODE_VERSION=2.2.5
ARG OPENCODE_SHA256=09f44302c10fd036912f59c81fd1aef5df45dd06f649197f9dfc9bbe2a79614e
ARG GH_VERSION=2.103.3
ARG GH_SHA256=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
ARG PNPM_VERSION=12.16.1
ARG CLOUD_AGENT_VERSION=0.1.0-local

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq python3 ripgrep procps tini \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c - \
 && tar -xzf /tmp/gh.tgz -C /tmp \
 && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && curl -fsSL -o /tmp/opencode.tgz "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" \
 && echo "${OPENCODE_SHA256}  /tmp/opencode.tgz" | sha256sum -c - \
 && tar -xzf /tmp/opencode.tgz -C /usr/local/bin opencode \
 && chmod 0755 /usr/local/bin/opencode \
 && rm -rf /tmp/gh.tgz /tmp/opencode.tgz "/tmp/gh_${GH_VERSION}_linux_amd64"

RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "pnpm@${PNPM_VERSION}" \
 && npm cache clean --force

RUN useradd --create-home --uid 10001 --shell /bin/bash agent \
 && install -d -o agent -g agent /workspace /opt/claude-plugins

COPY --chown=agent:agent package.json /opt/cloud-agent/
COPY --chown=agent:agent bin /opt/cloud-agent/bin
COPY --chown=agent:agent scripts /opt/cloud-agent/scripts
COPY --chown=agent:agent schema /opt/cloud-agent/schema
COPY --chown=agent:agent src /opt/cloud-agent/src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN ln -s /opt/cloud-agent/bin/cloud-agent /usr/local/bin/cloud-agent

USER agent
ENV HOME=/home/agent \
    CLAUDE_PLUGINS_DIR=/opt/claude-plugins \
    CLAUDE_PLUGINS_REF=main \
    CLOUD_AGENT_VERSION=${CLOUD_AGENT_VERSION} \
    DISABLE_AUTOUPDATER=1
WORKDIR /home/agent

RUN mkdir -p .claude .codex .config/opencode \
 && echo '{"syncClaudeAiSkills": false}' > .claude/settings.json \
 && echo 'check_for_update_on_startup = false' > .codex/config.toml \
 && echo '{"autoupdate": false}' > .config/opencode/opencode.json

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["cloud-agent", "help"]
