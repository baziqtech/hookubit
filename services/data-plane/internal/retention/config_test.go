package retention

import (
	"strings"
	"testing"
	"time"
)

func TestDefaultConfigIsValidAndKeepsTheSummaryLongerThanTheDetail(t *testing.T) {
	c := DefaultConfig()
	if err := c.Validate(); err != nil {
		t.Fatalf("the shipped policy does not validate: %v", err)
	}
	if !c.Enabled {
		t.Fatal("retention ships disabled; the gap it closes is a table that only grows")
	}
	if c.AttemptAge >= c.DeliveryAge {
		t.Fatalf("attempt age %s is not shorter than delivery age %s; the two-horizon split is the point",
			c.AttemptAge, c.DeliveryAge)
	}
	// The floor exists because a delivery is live until its wall-clock budget
	// runs out (24h at the shipped default). If the default horizon ever drifts
	// under that, retention starts deleting rows a worker is still retrying.
	if c.AttemptAge < MinimumAge {
		t.Fatalf("attempt age %s is below the %s floor", c.AttemptAge, MinimumAge)
	}
}

func TestValidateRefusesAHorizonInsideTheRetryBudget(t *testing.T) {
	c := DefaultConfig()
	c.AttemptAge = time.Hour
	err := c.Validate()
	if err == nil {
		t.Fatal("expected a horizon of one hour to be refused")
	}
	if !strings.Contains(err.Error(), "floor") {
		t.Fatalf("the message must explain the floor, got: %v", err)
	}
}

func TestValidateRefusesAttemptsOutlivingTheirDelivery(t *testing.T) {
	c := DefaultConfig()
	c.AttemptAge = c.DeliveryAge + 24*time.Hour
	if err := c.Validate(); err == nil {
		t.Fatal("expected attempts kept longer than their delivery to be refused")
	}
}

// A disabled sweep deletes nothing, so an operator switching it off must not
// also have to repair horizons they are not using.
func TestValidateIgnoresHorizonsWhenDisabled(t *testing.T) {
	c := DefaultConfig()
	c.Enabled = false
	c.DeliveryAge = time.Minute
	c.AttemptAge = 0
	if err := c.Validate(); err != nil {
		t.Fatalf("a disabled policy should validate, got %v", err)
	}
}

func TestConfigFromEnvReadsDaysAndMilliseconds(t *testing.T) {
	t.Setenv("RETENTION_DELIVERY_AGE_DAYS", "10")
	t.Setenv("RETENTION_ATTEMPT_AGE_DAYS", "5")
	t.Setenv("RETENTION_INTERVAL_MS", "60000")
	t.Setenv("RETENTION_BATCH_SIZE", "250")
	t.Setenv("RETENTION_MAX_DELETES_PER_RUN", "5000")

	c, err := ConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.DeliveryAge != 10*24*time.Hour {
		t.Fatalf("delivery age = %s", c.DeliveryAge)
	}
	if c.AttemptAge != 5*24*time.Hour {
		t.Fatalf("attempt age = %s", c.AttemptAge)
	}
	if c.Interval != time.Minute {
		t.Fatalf("interval = %s", c.Interval)
	}
	if c.BatchSize != 250 || c.MaxDeletesPerRun != 5000 {
		t.Fatalf("batch=%d max=%d", c.BatchSize, c.MaxDeletesPerRun)
	}
}

// The rest of the data plane substitutes a default for an unparseable value
// (internal/config's envInt/envDuration). This package must not: a mistyped
// egress timeout costs latency, a mistyped retention horizon deletes the
// delivery ledger on a schedule nobody chose.
func TestConfigFromEnvRefusesRatherThanFallingBackToTheDefault(t *testing.T) {
	for _, tc := range []struct{ key, value string }{
		{"RETENTION_DELIVERY_AGE_DAYS", "ninety"},
		{"RETENTION_DELIVERY_AGE_DAYS", "0"},
		{"RETENTION_DELIVERY_AGE_DAYS", "-1"},
		{"RETENTION_ATTEMPT_AGE_DAYS", "notanumber"},
		{"RETENTION_INTERVAL_MS", "0"},
		{"RETENTION_BATCH_SIZE", "lots"},
		{"RETENTION_ENABLED", "yes-please"},
	} {
		t.Run(tc.key+"="+tc.value, func(t *testing.T) {
			t.Setenv(tc.key, tc.value)
			if _, err := ConfigFromEnv(); err == nil {
				t.Fatalf("%s=%q was accepted", tc.key, tc.value)
			}
		})
	}
}

// A horizon shorter than the retry budget must be refused at STARTUP, not
// discovered when the first pass deletes a live delivery.
func TestConfigFromEnvRefusesAHorizonInsideTheRetryBudget(t *testing.T) {
	t.Setenv("RETENTION_DELIVERY_AGE_DAYS", "1")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("a one-day delivery horizon was accepted; it is inside max_retry_duration")
	}
}

func TestConfigFromEnvDefaultsWhenNothingIsSet(t *testing.T) {
	for _, key := range []string{
		"RETENTION_ENABLED", "RETENTION_INTERVAL_MS", "RETENTION_DELIVERY_AGE_DAYS",
		"RETENTION_ATTEMPT_AGE_DAYS", "RETENTION_BATCH_SIZE",
		"RETENTION_MAX_DELETES_PER_RUN", "RETENTION_BATCH_TIMEOUT_MS",
	} {
		t.Setenv(key, "")
	}
	c, err := ConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c != DefaultConfig() {
		t.Fatalf("unset environment produced %+v, want the shipped defaults", c)
	}
}
