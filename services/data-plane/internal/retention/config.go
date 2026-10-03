package retention

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Defaults. Every one of them is a bound on how much of the delivery ledger the
// platform is willing to destroy in one pass, and they are deliberately
// conservative: growing a table costs money, and deleting the answer to "did
// finance ever receive this?" costs the product.
const (
	// DefaultDeliveryAge keeps a terminal delivery row - the SUMMARY: status,
	// attempt_count, last_error, completed_at, the endpoint and event it
	// belongs to - for a quarter.
	//
	// Ninety days is chosen against the question this table exists to answer.
	// Reconciliation disputes ("we never got the settlement webhook") arrive on
	// a monthly or quarterly cycle, not a daily one, and an answer that has
	// already been deleted by the time the question is asked is worth nothing.
	// It is also comfortably longer than the longest a delivery can still be
	// live (max_retry_duration, 24h by default), so a row is never deleted
	// while anything might still touch it.
	DefaultDeliveryAge = 90 * 24 * time.Hour

	// DefaultAttemptAge keeps the per-attempt DETAIL - request headers,
	// response headers, response bodies - for sixty days.
	//
	// This is the shorter horizon on purpose, and it is where the storage
	// actually is: one delivery row is a few hundred bytes, its attempts carry
	// truncated response bodies and two header maps each. Sixty days covers the
	// debugging window with room for a customer who reports a problem late
	// ("this failed last month"), while the summary row survives a further
	// month to answer the reconciliation question.
	DefaultAttemptAge = 60 * 24 * time.Hour

	// DefaultInterval is how often a sweep runs. Retention is a background
	// reclamation, not a deadline: running it hourly keeps each pass small
	// enough to be invisible while still bounding how far the table can drift
	// past the horizon.
	DefaultInterval = time.Hour

	// DefaultBatchSize is how many delivery rows one statement may touch.
	//
	// This is the number that decides whether a retention run can hurt live
	// traffic. Every batch is its own transaction, so it holds row locks for
	// milliseconds and releases them; a single unbounded DELETE would hold
	// locks on every matching row for the length of the whole delete and block
	// the workers writing next to them.
	DefaultBatchSize = 1_000

	// DefaultMaxDeletesPerRun bounds one PASS, across batches.
	//
	// It is what stops the first run after this ships - against a table that
	// has never been pruned - from turning into an hours-long delete storm and
	// a replication lag incident. The backlog is drained over successive runs
	// instead, and a run that hits this ceiling says so at WARN.
	DefaultMaxDeletesPerRun = 50_000

	// DefaultBatchTimeout bounds ONE statement. A batch that cannot finish in
	// this long is contending with something, and the right answer is to give
	// the row locks back and try again on the next tick rather than to wait.
	DefaultBatchTimeout = 30 * time.Second
)

// Config is the retention policy.
//
// # Why this is read from the environment HERE and not in internal/config
//
// internal/config is the data plane's one configuration struct and this belongs
// in it. It is read here only because that file is owned by another change in
// flight; the keys, the defaults and the validation are all in this file so the
// move is a copy, not a redesign. See the wiring note in HANDOFF terms in the
// package comment.
type Config struct {
	// Enabled false turns the sweep off entirely. It ships true: a table that
	// only grows is the gap this package closes, and a retention job that has
	// to be discovered and switched on has not closed it.
	Enabled bool
	// Interval between passes.
	Interval time.Duration
	// DeliveryAge is how long a terminal delivery row is kept, measured from
	// created_at.
	DeliveryAge time.Duration
	// AttemptAge is how long delivery_attempts rows are kept, measured from
	// their delivery's created_at. Must not exceed DeliveryAge.
	AttemptAge time.Duration
	// BatchSize is the per-statement row bound.
	BatchSize int
	// MaxDeletesPerRun bounds one pass across batches, per sweep.
	MaxDeletesPerRun int
	// BatchTimeout bounds one statement.
	BatchTimeout time.Duration
}

// DefaultConfig is the shipped policy.
func DefaultConfig() Config {
	return Config{
		Enabled:          true,
		Interval:         DefaultInterval,
		DeliveryAge:      DefaultDeliveryAge,
		AttemptAge:       DefaultAttemptAge,
		BatchSize:        DefaultBatchSize,
		MaxDeletesPerRun: DefaultMaxDeletesPerRun,
		BatchTimeout:     DefaultBatchTimeout,
	}
}

// ConfigFromEnv reads the policy from the environment, falling back to
// DefaultConfig for anything unset.
//
// It returns an ERROR rather than silently substituting a default when a value
// is present but unusable. That is the opposite of internal/config's
// envInt/envDuration helpers, and deliberately so: a mistyped
// EGRESS_DNS_TIMEOUT_MS costs latency, whereas a mistyped
// RETENTION_DELIVERY_AGE_DAYS silently deletes the delivery ledger on a
// schedule nobody chose. Nothing here is allowed to fail quietly downwards.
func ConfigFromEnv() (Config, error) {
	c := DefaultConfig()
	var err error

	if c.Enabled, err = envBool("RETENTION_ENABLED", c.Enabled); err != nil {
		return Config{}, err
	}
	if c.Interval, err = envMillis("RETENTION_INTERVAL_MS", c.Interval); err != nil {
		return Config{}, err
	}
	if c.DeliveryAge, err = envDays("RETENTION_DELIVERY_AGE_DAYS", c.DeliveryAge); err != nil {
		return Config{}, err
	}
	if c.AttemptAge, err = envDays("RETENTION_ATTEMPT_AGE_DAYS", c.AttemptAge); err != nil {
		return Config{}, err
	}
	if c.BatchSize, err = envInt("RETENTION_BATCH_SIZE", c.BatchSize); err != nil {
		return Config{}, err
	}
	if c.MaxDeletesPerRun, err = envInt("RETENTION_MAX_DELETES_PER_RUN", c.MaxDeletesPerRun); err != nil {
		return Config{}, err
	}
	if c.BatchTimeout, err = envMillis("RETENTION_BATCH_TIMEOUT_MS", c.BatchTimeout); err != nil {
		return Config{}, err
	}
	if err := c.Validate(); err != nil {
		return Config{}, err
	}
	return c, nil
}

// MinimumAge is the floor under both horizons.
//
// It is not a style preference. A delivery is live until its wall-clock retry
// budget runs out - max_retry_duration, 24h at the shipped default
// (internal/retry) - and a retention horizon inside that window would delete
// rows a worker is still retrying. The delete would succeed, the delivery would
// vanish mid-retry chain, and the customer would see an event that reached
// their endpoint zero times with no ledger row explaining why. Two days leaves
// a full day of margin over the default budget.
const MinimumAge = 48 * time.Hour

// Validate refuses a policy that would destroy more than it was asked to.
func (c Config) Validate() error {
	if !c.Enabled {
		// Nothing else can hurt anyone when the sweep does not run, and an
		// operator switching retention off should not have to also fix a
		// horizon they are not using.
		return nil
	}
	if c.DeliveryAge < MinimumAge {
		return fmt.Errorf("retention: RETENTION_DELIVERY_AGE_DAYS is %s, below the %s floor; "+
			"a delivery is still being retried inside its max_retry_duration and must not be deleted under the worker",
			c.DeliveryAge, MinimumAge)
	}
	if c.AttemptAge < MinimumAge {
		return fmt.Errorf("retention: RETENTION_ATTEMPT_AGE_DAYS is %s, below the %s floor; "+
			"the attempt rows of a delivery that is still being retried are the record of what was tried",
			c.AttemptAge, MinimumAge)
	}
	if c.AttemptAge > c.DeliveryAge {
		// Not an error that corrupts anything - the delivery sweep would simply
		// cascade the attempts away first - but it is always a mistake, and one
		// that reads as "we keep attempt detail for a year" while the row it
		// hangs off is deleted at ninety days.
		return fmt.Errorf("retention: RETENTION_ATTEMPT_AGE_DAYS (%s) is longer than "+
			"RETENTION_DELIVERY_AGE_DAYS (%s); attempts cannot outlive the delivery they belong to",
			c.AttemptAge, c.DeliveryAge)
	}
	if c.Interval <= 0 {
		return fmt.Errorf("retention: RETENTION_INTERVAL_MS must be positive, got %s", c.Interval)
	}
	if c.BatchSize <= 0 {
		return fmt.Errorf("retention: RETENTION_BATCH_SIZE must be positive, got %d", c.BatchSize)
	}
	if c.MaxDeletesPerRun <= 0 {
		return fmt.Errorf("retention: RETENTION_MAX_DELETES_PER_RUN must be positive, got %d", c.MaxDeletesPerRun)
	}
	if c.BatchTimeout <= 0 {
		return fmt.Errorf("retention: RETENTION_BATCH_TIMEOUT_MS must be positive, got %s", c.BatchTimeout)
	}
	return nil
}

func envBool(key string, fallback bool) (bool, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("retention: %s must be a boolean, got %q", key, v)
	}
	return b, nil
}

func envInt(key string, fallback int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("retention: %s must be an integer, got %q", key, v)
	}
	return n, nil
}

// envDays reads a whole number of days. Retention horizons are the one place in
// this service where an operator thinks in days rather than milliseconds, and
// RETENTION_DELIVERY_AGE_MS=7776000000 is a number nobody can check by reading.
func envDays(key string, fallback time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("retention: %s must be a whole number of days, got %q", key, v)
	}
	if n <= 0 {
		return 0, fmt.Errorf("retention: %s must be positive, got %d; set RETENTION_ENABLED=false to turn retention off", key, n)
	}
	return time.Duration(n) * 24 * time.Hour, nil
}

// envMillis matches internal/config's convention for the knobs that are genuinely
// sub-day.
func envMillis(key string, fallback time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	ms, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("retention: %s must be a whole number of milliseconds, got %q", key, v)
	}
	if ms <= 0 {
		return 0, fmt.Errorf("retention: %s must be positive, got %d", key, ms)
	}
	return time.Duration(ms) * time.Millisecond, nil
}
