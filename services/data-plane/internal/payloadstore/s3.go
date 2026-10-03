package payloadstore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// Defaults for everything that bounds a network call. There is no "no timeout"
// option and no "retry until it works" option: ARCHITECTURE.md 31 forbids an
// unbounded network operation, and this store sits on the ingest hot path,
// where an unbounded PUT holds an HTTP request, a goroutine and eventually the
// whole accept path open.
const (
	DefaultUploadTimeout   = 10 * time.Second
	DefaultDownloadTimeout = 10 * time.Second
	DefaultMaxAttempts     = 3
)

// Config is everything the S3 store needs. The S3_* fields mirror
// internal/config one for one.
type Config struct {
	// Endpoint is the S3-compatible base endpoint (MinIO, R2, Ceph). Empty
	// means real AWS S3 and the SDK's own regional endpoint resolution.
	Endpoint  string
	Bucket    string
	Region    string
	AccessKey string
	SecretKey string
	// ForcePathStyle addresses objects as <endpoint>/<bucket>/<key> rather
	// than <bucket>.<endpoint>/<key>. MinIO needs it; so does any endpoint
	// reached by IP or without wildcard DNS.
	ForcePathStyle bool
	// Prefix defaults to DefaultPrefix.
	Prefix string

	// UploadTimeout and DownloadTimeout bound ONE call each, including its
	// retries.
	UploadTimeout   time.Duration
	DownloadTimeout time.Duration
	// MaxAttempts bounds the SDK's own retrying. It is a count, not a
	// deadline, and the timeouts above are the deadline.
	MaxAttempts int
	// MaxObjectBytes is the read ceiling, applied to bytes actually read.
	// Wire it to PAYLOAD_MAX_BYTES: an object larger than the largest event
	// the platform will accept is by definition not one of our payloads.
	MaxObjectBytes int64
}

func (c Config) withDefaults() Config {
	if c.Prefix == "" {
		c.Prefix = DefaultPrefix
	}
	if c.Region == "" {
		c.Region = "us-east-1"
	}
	if c.UploadTimeout <= 0 {
		c.UploadTimeout = DefaultUploadTimeout
	}
	if c.DownloadTimeout <= 0 {
		c.DownloadTimeout = DefaultDownloadTimeout
	}
	if c.MaxAttempts <= 0 {
		c.MaxAttempts = DefaultMaxAttempts
	}
	if c.MaxObjectBytes <= 0 {
		c.MaxObjectBytes = 1 << 20
	}
	return c
}

// S3API is the slice of the S3 client this package uses, as an interface so the
// sweep and the failure paths are testable without a bucket.
type S3API interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
	ListObjectsV2(context.Context, *s3.ListObjectsV2Input, ...func(*s3.Options)) (*s3.ListObjectsV2Output, error)
}

// Store is the production PayloadStore. It satisfies ingest.PayloadStore (Put),
// ingest.PayloadDisposer (Delete) and worker.PayloadFetcher (Get).
type Store struct {
	api S3API
	cfg Config
}

// New builds a store against an S3-compatible endpoint.
//
// Credentials: static S3_ACCESS_KEY/S3_SECRET_KEY when supplied, otherwise the
// SDK's default chain, so an IRSA/instance-role deployment on real AWS needs no
// secrets in the environment. A bucket with neither is a configuration error
// worth failing at startup for rather than at the first oversized event.
func New(ctx context.Context, cfg Config) (*Store, error) {
	cfg = cfg.withDefaults()
	if cfg.Bucket == "" {
		return nil, errors.New("payloadstore: S3_BUCKET is required")
	}

	opts := s3.Options{
		Region:           cfg.Region,
		UsePathStyle:     cfg.ForcePathStyle,
		RetryMaxAttempts: cfg.MaxAttempts,
		HTTPClient:       httpClient(),
	}
	if cfg.Endpoint != "" {
		opts.BaseEndpoint = aws.String(cfg.Endpoint)
	}
	switch {
	case cfg.AccessKey != "" && cfg.SecretKey != "":
		opts.Credentials = aws.NewCredentialsCache(
			credentials.NewStaticCredentialsProvider(cfg.AccessKey, cfg.SecretKey, ""))
	case cfg.AccessKey != "" || cfg.SecretKey != "":
		return nil, errors.New("payloadstore: S3_ACCESS_KEY and S3_SECRET_KEY must be set together")
	default:
		loaded, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(cfg.Region))
		if err != nil {
			return nil, fmt.Errorf("payloadstore: no S3 credentials (set S3_ACCESS_KEY/S3_SECRET_KEY or provide an instance role): %w", err)
		}
		opts.Credentials = loaded.Credentials
	}

	return &Store{api: s3.New(opts), cfg: cfg}, nil
}

// NewWithAPI builds a store over a supplied client. Tests use it; so would a
// deployment that needs to hand in an instrumented client.
func NewWithAPI(api S3API, cfg Config) *Store {
	return &Store{api: api, cfg: cfg.withDefaults()}
}

// Bucket is the bucket new objects are written to.
func (s *Store) Bucket() string { return s.cfg.Bucket }

// Prefix is the key namespace this store owns.
func (s *Store) Prefix() string { return s.cfg.Prefix }

// httpClient bounds the transport underneath the SDK. The SDK's default client
// has no overall timeout of its own; the per-call contexts below supply it, and
// these bound the phases so a half-open connection cannot eat the whole budget
// before a single byte moves.
func httpClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   3 * time.Second,
			ResponseHeaderTimeout: 10 * time.Second,
			ExpectContinueTimeout: time.Second,
			MaxIdleConnsPerHost:   8,
			IdleConnTimeout:       90 * time.Second,
		},
	}
}

// Put writes the EXACT request bytes and returns the location for
// events.payload_location.
//
// It is called before the ingest transaction (see internal/ingest), so its
// failure is an ingest failure: the caller must not answer 202 for an event
// whose payload is not durable. There is no inline fallback and no truncation.
func (s *Store) Put(ctx context.Context, projectID, eventID string, body []byte) (string, error) {
	key := Key(s.cfg.Prefix, projectID, eventID)

	// Detached from the caller's deadline only in the sense that it is capped:
	// a shorter parent deadline still wins, which is what we want on the ingest
	// path where INGEST_DB_TIMEOUT_MS already bounds the request.
	putCtx, cancel := context.WithTimeout(ctx, s.cfg.UploadTimeout)
	defer cancel()

	_, err := s.api.PutObject(putCtx, &s3.PutObjectInput{
		Bucket: aws.String(s.cfg.Bucket),
		Key:    aws.String(key),
		Body:   bytes.NewReader(body),
		// Set explicitly: the SDK can compute it from a *bytes.Reader, but an
		// object whose length the store disagrees with is the failure mode
		// this whole file exists to avoid.
		ContentLength: aws.Int64(int64(len(body))),
		ContentType:   aws.String("application/json"),
	})
	if err != nil {
		return "", fmt.Errorf("%w: put %s: %v", classify(err), key, err)
	}
	return Location(s.cfg.Bucket, key), nil
}

// Get reads back the bytes at a stored payload_location.
//
// The returned bytes are AUTHORITATIVE for an offloaded payload, exactly as
// events.payload_raw is for an inline one. The caller signs them; nothing else
// may be signed. The size ceiling is enforced on what is read, not on what the
// store claims: a Content-Length is a hint from a remote system and this
// process must not allocate on the strength of one.
func (s *Store) Get(ctx context.Context, location string) ([]byte, error) {
	ref, err := ParseLocation(location)
	if err != nil {
		return nil, err
	}

	getCtx, cancel := context.WithTimeout(ctx, s.cfg.DownloadTimeout)
	defer cancel()

	out, err := s.api.GetObject(getCtx, &s3.GetObjectInput{
		Bucket: aws.String(ref.Bucket),
		Key:    aws.String(ref.Key),
	})
	if err != nil {
		return nil, fmt.Errorf("%w: get %s: %v", classify(err), location, err)
	}
	defer func() { _ = out.Body.Close() }()

	// Cheap pre-check on the advertised length so an absurd object is refused
	// before it is streamed. Not trusted: the LimitReader below is what
	// actually enforces the ceiling.
	if out.ContentLength != nil && *out.ContentLength > s.cfg.MaxObjectBytes {
		return nil, fmt.Errorf("%w: %s advertises %d bytes, ceiling is %d",
			ErrObjectTooLarge, location, *out.ContentLength, s.cfg.MaxObjectBytes)
	}

	body, err := io.ReadAll(io.LimitReader(out.Body, s.cfg.MaxObjectBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: read %s: %v", ErrUnavailable, location, err)
	}
	if int64(len(body)) > s.cfg.MaxObjectBytes {
		return nil, fmt.Errorf("%w: %s exceeds %d bytes", ErrObjectTooLarge, location, s.cfg.MaxObjectBytes)
	}
	return body, nil
}

// Delete removes one object. Used by the compensating delete on the ingest path
// and by Reconcile; both are already sure the object is unreferenced.
func (s *Store) Delete(ctx context.Context, location string) error {
	ref, err := ParseLocation(location)
	if err != nil {
		return err
	}
	delCtx, cancel := context.WithTimeout(ctx, s.cfg.UploadTimeout)
	defer cancel()

	if _, err := s.api.DeleteObject(delCtx, &s3.DeleteObjectInput{
		Bucket: aws.String(ref.Bucket),
		Key:    aws.String(ref.Key),
	}); err != nil {
		return fmt.Errorf("%w: delete %s: %v", classify(err), location, err)
	}
	return nil
}

// classify turns an SDK error into one of this package's sentinels.
//
// It matches on TYPE and on the HTTP status, never on the message. S3
// implementations disagree about the error CODE for a missing object - AWS says
// NoSuchKey on GET and NotFound on HEAD, MinIO and Ceph vary - but every one of
// them answers 404, so the status is the reliable signal and the codes are the
// belt to its braces.
func classify(err error) error {
	if err == nil {
		return nil
	}
	var resp *smithyhttp.ResponseError
	if errors.As(err, &resp) && resp.HTTPStatusCode() == http.StatusNotFound {
		return ErrObjectNotFound
	}
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.ErrorCode() {
		case "NoSuchKey", "NotFound", "NoSuchBucket":
			// NoSuchBucket is grouped with the missing object deliberately: a
			// bucket that does not exist will not start existing on a retry,
			// and burning a delivery's retry budget on it hides a
			// configuration error behind hours of "still trying".
			return ErrObjectNotFound
		}
	}
	return ErrUnavailable
}
