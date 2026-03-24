# Plugin must be built with the same Nakama release and pinned Go dependencies.
ARG NAKAMA_VERSION=3.24.0

FROM heroiclabs/nakama-pluginbuilder:${NAKAMA_VERSION} AS builder

ENV CGO_ENABLED=1
WORKDIR /backend

COPY go.mod ./
COPY *.go ./

# Keep dependency resolution deterministic: do not run `go mod tidy` in image builds.
RUN go build --trimpath --buildmode=plugin -mod=mod -o ./backend.so .

FROM heroiclabs/nakama:${NAKAMA_VERSION}

COPY --from=builder /backend/backend.so /nakama/data/modules/backend.so
COPY local.yml /nakama/data/local.yml
COPY render-entrypoint.sh /nakama/data/render-entrypoint.sh
RUN chmod +x /nakama/data/render-entrypoint.sh

# Render (and plain `docker run`): applies DB_* / NAKAMA_SERVER_KEY / PORT from env, then migrates + starts Nakama.
# docker-compose.yml overrides entrypoint for local dev — unchanged.
ENTRYPOINT ["/bin/sh", "/nakama/data/render-entrypoint.sh"]
