module lilagames/server

go 1.23.2

require github.com/heroiclabs/nakama-common v1.34.0

// Must match Nakama 3.24.0 exactly — see https://heroiclabs.com/docs/nakama/server-framework/go-runtime/go-dependencies/
replace github.com/heroiclabs/nakama-common => github.com/heroiclabs/nakama-common v1.34.0

replace google.golang.org/protobuf => google.golang.org/protobuf v1.34.2
