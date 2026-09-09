module github.com/shaq/webhook-platform/services/data-plane

// The `go` directive is a MINIMUM language version, not a pin. Nothing in this
// module uses a post-1.21 language feature, so raising it only excludes
// contributors whose toolchain is older - and with GOTOOLCHAIN=auto it makes
// `go build` attempt a toolchain download that fails on a restricted network.
//
// CI and the Dockerfiles deliberately BUILD with Go 1.23 to pick up the patched
// standard library; a module declaring 1.21 compiles cleanly under 1.23. The
// two numbers are allowed to differ and there is no mismatch to fix.
go 1.25.0

require (
	github.com/jackc/pgx/v5 v5.9.2
	github.com/oklog/ulid/v2 v2.1.0
	github.com/prometheus/client_golang v1.20.5
)

require (
	github.com/aws/aws-sdk-go-v2 v1.32.3 // indirect
	github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream v1.6.6 // indirect
	github.com/aws/aws-sdk-go-v2/config v1.28.1 // indirect
	github.com/aws/aws-sdk-go-v2/credentials v1.17.42 // indirect
	github.com/aws/aws-sdk-go-v2/feature/ec2/imds v1.16.18 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.3.22 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.6.22 // indirect
	github.com/aws/aws-sdk-go-v2/internal/ini v1.8.1 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.3.21 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.12.0 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/checksum v1.4.2 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.12.3 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/s3shared v1.18.2 // indirect
	github.com/aws/aws-sdk-go-v2/service/s3 v1.66.0 // indirect
	github.com/aws/aws-sdk-go-v2/service/sso v1.24.3 // indirect
	github.com/aws/aws-sdk-go-v2/service/ssooidc v1.28.3 // indirect
	github.com/aws/aws-sdk-go-v2/service/sts v1.32.3 // indirect
	github.com/aws/smithy-go v1.22.0 // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/klauspost/compress v1.17.9 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/prometheus/client_model v0.6.1 // indirect
	github.com/prometheus/common v0.55.0 // indirect
	github.com/prometheus/procfs v0.15.1 // indirect
	github.com/redis/go-redis/v9 v9.7.0 // indirect
	golang.org/x/sync v0.21.0 // indirect
	golang.org/x/sys v0.25.0 // indirect
	golang.org/x/text v0.39.0 // indirect
	google.golang.org/protobuf v1.34.2 // indirect
)
