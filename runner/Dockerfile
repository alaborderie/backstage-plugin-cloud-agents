# syntax=docker/dockerfile:1
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

ARG CLAUDE_CODE_VERSION=2.1.318
ARG CODEX_VERSION=0.166.0
ARG OPENCODE_VERSION=2.2.5
ARG OPENCODE_SHA256=09f44302c10fd036912f59c81fd1aef5df45dd06f649197f9dfc9bbe2a79614e
ARG GH_VERSION=2.103.3
ARG GH_SHA256=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
ARG PNPM_VERSION=12.16.1
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG RUST_VERSION=1.99.1
ARG PLAYWRIGHT_VERSION=1.64.1
ARG CLOUD_AGENT_VERSION=0.1.0-local

# Pods run without privilege escalation, so agents cannot apt-get or sudo: every build tool must be here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq python3 ripgrep procps tini \
      build-essential pkg-config libssl-dev python3-dev python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /bin/bash agent \
 && install -d -o agent -g agent /workspace /opt/claude-plugins

# Rust lives outside HOME and belongs to agent, so agents can add targets, components, and `cargo install`.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
 && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
 && chmod 0755 /tmp/rustup-init \
 && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" --component rustfmt,clippy \
 && rm /tmp/rustup-init \
 && chown -R agent:agent "$RUSTUP_HOME" "$CARGO_HOME" \
 && echo 'export PATH="/usr/local/cargo/bin:$PATH"' > /etc/profile.d/cargo.sh

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

# Node and Python Playwright at the same version share one Chromium build. Agents own the browser
# directory, so a project pinned to another Playwright version can download its own browser there.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules \
    PIP_BREAK_SYSTEM_PACKAGES=1
RUN npm install -g --no-fund --no-audit "playwright@${PLAYWRIGHT_VERSION}" \
 && playwright install --with-deps chromium \
 && pip3 install --no-cache-dir "playwright==${PLAYWRIGHT_VERSION}" \
 && chown -R agent:agent "$PLAYWRIGHT_BROWSERS_PATH" \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

COPY --chown=agent:agent package.json /opt/cloud-agent/
COPY --chown=agent:agent bin /opt/cloud-agent/bin
COPY --chown=agent:agent scripts /opt/cloud-agent/scripts
COPY --chown=agent:agent schema /opt/cloud-agent/schema
COPY --chown=agent:agent src /opt/cloud-agent/src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN ln -s /opt/cloud-agent/bin/cloud-agent /usr/local/bin/cloud-agent

USER agent
ENV HOME=/home/agent \
    PATH=/opt/cloud-agent/bin:$PATH \
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
