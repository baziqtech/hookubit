package db

import (
	"strings"
	"testing"
)

// The control plane and the data plane are specified to read the SAME
// DATABASE_URL. Prisma's documented connection string carries `schema`, which
// PostgreSQL rejects with SQLSTATE 42704 - so without this the second plane
// simply cannot start against a URL the first one requires.
func TestNormaliseDSNStripsPrismaOnlyParameters(t *testing.T) {
	got, err := NormaliseDSN("postgresql://u:p@localhost:5432/db?schema=public&connection_limit=5&sslmode=disable")
	if err != nil {
		t.Fatalf("NormaliseDSN: %v", err)
	}
	if strings.Contains(got, "schema=") {
		t.Errorf("schema= survived: %s", got)
	}
	if strings.Contains(got, "connection_limit") {
		t.Errorf("connection_limit survived: %s", got)
	}
	if !strings.Contains(got, "search_path=public") {
		t.Errorf("schema was dropped rather than translated to search_path: %s", got)
	}
	if !strings.Contains(got, "sslmode=disable") {
		t.Errorf("an operator's own parameter was lost: %s", got)
	}
}

func TestNormaliseDSNLeavesAPlainURLAlone(t *testing.T) {
	in := "postgresql://u:p@localhost:5432/db?sslmode=require"
	got, err := NormaliseDSN(in)
	if err != nil {
		t.Fatalf("NormaliseDSN: %v", err)
	}
	if got != in {
		t.Errorf("rewrote a URL that needed no change:\n got %s\nwant %s", got, in)
	}
}
