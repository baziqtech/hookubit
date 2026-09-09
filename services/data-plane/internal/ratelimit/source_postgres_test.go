package ratelimit

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/shaq/webhook-platform/services/data-plane/internal/ids"
	"github.com/shaq/webhook-platform/services/data-plane/internal/testsupport"
)

// These run the real SQL against a migrated database. They are the only place
// drift between this package's query and Prisma's schema is caught - the enum
// cast, the nullable resource_id and the join - so they skip rather than fail
// when there is no database.
func seedOrg(t *testing.T, pool *pgxpool.Pool) (orgID string) {
	t.Helper()
	orgID = ids.New(ids.Organization)
	suffix, err := ids.Token(16)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
		 VALUES ($1, 'ratelimit test', $2, 'active', now(), now())`,
		orgID, "ratelimit-"+suffix[:8]); err != nil {
		t.Fatalf("seed organization: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM organizations WHERE id = $1`, orgID)
	})
	return orgID
}

func seedProjectIn(t *testing.T, pool *pgxpool.Pool, orgID string) string {
	t.Helper()
	projectID := ids.New(ids.Project)
	suffix, err := ids.Token(16)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO projects (id, organization_id, name, slug, environment, status, created_at, updated_at)
		 VALUES ($1, $2, 'ratelimit test', $3, 'test', 'active', now(), now())`,
		projectID, orgID, "ratelimit-"+suffix[:8]); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	return projectID
}

func seedPolicy(t *testing.T, pool *pgxpool.Pool, projectID string, scope Scope, resourceID *string, limit, window int, burst *int) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO rate_limit_policies (id, project_id, scope, resource_id, "limit", window_seconds, burst, created_at, updated_at)
		 VALUES ($1, $2, $3::"RateLimitScope", $4, $5, $6, $7, now(), now())`,
		ids.New("rlp"), projectID, string(scope), resourceID, limit, window, burst); err != nil {
		t.Fatalf("seed rate limit policy: %v", err)
	}
}

func TestPostgresSourceReadsEveryColumn(t *testing.T) {
	pool := testsupport.Pool(t)
	orgID := seedOrg(t, pool)
	projectID := seedProjectIn(t, pool, orgID)
	apiKeyID := ids.New(ids.APIKey)

	seedPolicy(t, pool, projectID, ScopeIngest, &apiKeyID, 10, 1, ptr(25))
	seedPolicy(t, pool, projectID, ScopeProject, nil, 500, 60, nil)

	rows, err := NewPostgresSource(pool).Policies(context.Background(), orgID, projectID)
	if err != nil {
		t.Fatalf("Policies: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2: %+v", len(rows), rows)
	}

	var sawIngest, sawWildcard bool
	for _, r := range rows {
		switch r.Scope {
		case ScopeIngest:
			sawIngest = true
			if r.ResourceID == nil || *r.ResourceID != apiKeyID {
				t.Fatalf("ingest resource_id = %v, want %q", r.ResourceID, apiKeyID)
			}
			if r.Limit != 10 || r.WindowSeconds != 1 || r.Burst == nil || *r.Burst != 25 {
				t.Fatalf("ingest row read back wrong: %+v", r)
			}
		case ScopeProject:
			sawWildcard = true
			// The NULLS NOT DISTINCT row: "every resource in this scope". It
			// must survive the round trip as nil, not as an empty string, or
			// the within-scope specificity rule silently inverts.
			if r.ResourceID != nil {
				t.Fatalf("wildcard resource_id = %q, want NULL", *r.ResourceID)
			}
		}
	}
	if !sawIngest || !sawWildcard {
		t.Fatalf("missing rows: ingest=%v wildcard=%v", sawIngest, sawWildcard)
	}
}

// The reason the query joins projects rather than filtering on project_id
// alone. rate_limit_policies.project_id is NOT NULL, so an ORGANISATION-scoped
// policy is filed under whichever project the API call happened to name. A
// project-only filter would apply an org-wide ceiling to exactly one project
// and silently exempt the rest.
func TestOrganizationPolicyFiledUnderASiblingProjectStillApplies(t *testing.T) {
	pool := testsupport.Pool(t)
	orgID := seedOrg(t, pool)
	created := seedProjectIn(t, pool, orgID)    // where the operator created it
	requesting := seedProjectIn(t, pool, orgID) // where traffic arrives

	seedPolicy(t, pool, created, ScopeOrganization, &orgID, 42, 1, nil)

	rows, err := NewPostgresSource(pool).Policies(context.Background(), orgID, requesting)
	if err != nil {
		t.Fatal(err)
	}
	buckets := ResolveIngest(rows, Target{OrganizationID: orgID, ProjectID: requesting, APIKeyID: "key_x"}, Default{})
	for _, b := range buckets {
		if b.Scope == ScopeOrganization && b.Limit == 42 {
			return
		}
	}
	t.Fatalf("the organisation ceiling was not applied to a sibling project: %+v", buckets)
}

// Another organisation's policies must never be visible. The data plane reads
// this table with no tenant guard of its own, so the query IS the isolation.
func TestPolicyLookupIsScopedToTheOrganization(t *testing.T) {
	pool := testsupport.Pool(t)

	mineOrg := seedOrg(t, pool)
	mineProject := seedProjectIn(t, pool, mineOrg)
	theirsOrg := seedOrg(t, pool)
	theirsProject := seedProjectIn(t, pool, theirsOrg)

	seedPolicy(t, pool, theirsProject, ScopeOrganization, &theirsOrg, 1, 1, nil)
	seedPolicy(t, pool, theirsProject, ScopeProject, nil, 1, 1, nil)

	rows, err := NewPostgresSource(pool).Policies(context.Background(), mineOrg, mineProject)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("read %d rows belonging to another organisation: %+v", len(rows), rows)
	}
}
