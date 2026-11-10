# A minimal Linux machine for the host agent: Node 22, tmux, git, curl.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tmux git curl ca-certificates procps && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash dev
USER dev
WORKDIR /home/dev
