# Plugin must match the Nakama binary: same Go version, same module sources, and similar build flags
# as github.com/heroiclabs/nakama build/Dockerfile (-trimpath + gc/asm trimpath + -s -w).
# See: https://heroiclabs.com/docs/nakama/server-framework/go-runtime/go-dependencies/
ARG NAKAMA_VERSION=3.24.0
# Pin to the exact tags used by Nakama v3.24.0 (see Nakama go.mod at that release).
ARG NAKAMA_COMMON_TAG=v1.34.0
ARG PROTOBUF_GO_TAG=v1.34.2

FROM golang:1.23.2-bookworm AS sources
ARG NAKAMA_COMMON_TAG
ARG PROTOBUF_GO_TAG
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git clone --depth 1 --branch "${NAKAMA_COMMON_TAG}" https://github.com/heroiclabs/nakama-common.git /src/nakama-common \
  && git clone --depth 1 --branch "${PROTOBUF_GO_TAG}" https://github.com/protocolbuffers/protobuf-go.git /src/protobuf-go

FROM golang:1.23.2-bookworm AS builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=sources /src/nakama-common /src/nakama-common
COPY --from=sources /src/protobuf-go /src/protobuf-go

ENV CGO_ENABLED=1
WORKDIR /backend

COPY go.mod ./
COPY *.go ./

# Build against the same trees Nakama vendors (avoids google.golang.org/protobuf/internal/pragma mismatch).
RUN printf '\nreplace github.com/heroiclabs/nakama-common => /src/nakama-common\nreplace google.golang.org/protobuf => /src/protobuf-go\n' >> go.mod \
  && go mod tidy \
  && go build -trimpath \
    -gcflags "-trimpath=/backend" \
    -asmflags "-trimpath=/backend" \
    -ldflags "-s -w" \
    --buildmode=plugin \
    -o ./backend.so .

FROM heroiclabs/nakama:${NAKAMA_VERSION}

COPY --from=builder /backend/backend.so /nakama/data/modules/backend.so
COPY local.yml /nakama/data/local.yml
COPY render-entrypoint.sh /nakama/data/render-entrypoint.sh
RUN chmod +x /nakama/data/render-entrypoint.sh

# Render (and plain `docker run`): applies DB_* / NAKAMA_SERVER_KEY / PORT from env, then migrates + starts Nakama.
# docker-compose.yml overrides entrypoint for local dev — unchanged.
ENTRYPOINT ["/bin/sh", "/nakama/data/render-entrypoint.sh"]
