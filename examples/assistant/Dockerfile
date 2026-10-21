FROM node:24-trixie-slim

# Flue runs every command and file operation through bash, coreutils,
# findutils, and util-linux (setsid). tini reaps killed processes.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git ripgrep tini procps python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
