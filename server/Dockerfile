# Plugin must match the Nakama binary. The official image is built from Nakama's repo with
# -mod=vendor under /go/build/nakama and -gcflags/-asmflags "-trimpath=/go/build/nakama".
# We compile against THAT vendor tree and the same trimpath prefix so shared packages
# (e.g. google.golang.org/protobuf/internal/pragma) match exactly.
#
# If `nakama version` shows a different +commit, set NAKAMA_GIT_REF to that tag or full SHA.
# See: https://heroiclabs.com/docs/nakama/server-framework/go-runtime/go-dependencies/
ARG NAKAMA_VERSION=3.24.0
ARG NAKAMA_GIT_REF=v3.24.0

FROM golang:1.23.2-bookworm AS nakama-tree
ARG NAKAMA_GIT_REF
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /go/build \
  && git clone --depth 1 --branch "${NAKAMA_GIT_REF}" https://github.com/heroiclabs/nakama.git /go/build/nakama

# `go mod vendor` layout has sources but often no per-module go.mod; `replace` needs one.
RUN PB="/go/build/nakama/vendor/google.golang.org/protobuf" \
  && NC="/go/build/nakama/vendor/github.com/heroiclabs/nakama-common" \
  && if [ ! -f "$PB/go.mod" ]; then curl -fsSL "https://raw.githubusercontent.com/protocolbuffers/protobuf-go/v1.34.2/go.mod" -o "$PB/go.mod"; fi \
  && if [ ! -f "$NC/go.mod" ]; then curl -fsSL "https://raw.githubusercontent.com/heroiclabs/nakama-common/v1.34.0/go.mod" -o "$NC/go.mod"; fi

FROM golang:1.23.2-bookworm AS builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=nakama-tree /go/build/nakama /go/build/nakama

ENV CGO_ENABLED=1
WORKDIR /go/build/nakama/lilagames-plugin

COPY go.mod ./
COPY *.go ./

# Same trimpath as github.com/heroiclabs/nakama build/Dockerfile (PWD=/go/build/nakama).
RUN printf '\nreplace github.com/heroiclabs/nakama-common => /go/build/nakama/vendor/github.com/heroiclabs/nakama-common\nreplace google.golang.org/protobuf => /go/build/nakama/vendor/google.golang.org/protobuf\n' >> go.mod \
  && go mod tidy \
  && go build -trimpath \
    -gcflags "-trimpath=/go/build/nakama" \
    -asmflags "-trimpath=/go/build/nakama" \
    -ldflags "-s -w" \
    --buildmode=plugin \
    -o ./backend.so .

FROM heroiclabs/nakama:${NAKAMA_VERSION}

COPY --from=builder /go/build/nakama/lilagames-plugin/backend.so /nakama/data/modules/backend.so
COPY local.yml /nakama/data/local.yml
COPY render-entrypoint.sh /nakama/data/render-entrypoint.sh
RUN chmod +x /nakama/data/render-entrypoint.sh

# Render (and plain `docker run`): applies DB_* / NAKAMA_SERVER_KEY / PORT from env, then migrates + starts Nakama.
# docker-compose.yml overrides entrypoint for local dev — unchanged.
ENTRYPOINT ["/bin/sh", "/nakama/data/render-entrypoint.sh"]
