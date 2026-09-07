module github.com/shaq/webhook-platform/services/data-plane

// The `go` directive is a MINIMUM language version, not a pin. Nothing in this
// module uses a post-1.21 language feature, so raising it only excludes
// contributors whose toolchain is older - and with GOTOOLCHAIN=auto it makes
// `go build` attempt a toolchain download that fails on a restricted network.
//
// CI and the Dockerfiles deliberately BUILD with Go 1.23 to pick up the patched
// standard library; a module declaring 1.21 compiles cleanly under 1.23. The
// two numbers are allowed to differ and there is no mismatch to fix.
go 1.21

require (
	github.com/jackc/pgx/v5 v5.7.1
	github.com/oklog/ulid/v2 v2.1.0
	github.com/prometheus/client_golang v1.20.5
)

require (
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/klauspost/compress v1.17.9 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/prometheus/client_model v0.6.1 // indirect
	github.com/prometheus/common v0.55.0 // indirect
	github.com/prometheus/procfs v0.15.1 // indirect
	golang.org/x/crypto v0.27.0 // indirect
	golang.org/x/sync v0.8.0 // indirect
	golang.org/x/sys v0.25.0 // indirect
	golang.org/x/text v0.18.0 // indirect
	google.golang.org/protobuf v1.34.2 // indirect
)
