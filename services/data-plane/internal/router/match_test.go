package router

import "testing"

func TestExactMatch(t *testing.T) {
	patterns := []string{"payment.settled"}
	if !MatchesEventType(patterns, "payment.settled") {
		t.Fatal("exact type did not match")
	}
	for _, other := range []string{"payment.failed", "payment.settled.late", "order.created", ""} {
		if MatchesEventType(patterns, other) {
			t.Errorf("%q matched a subscription filtered to payment.settled", other)
		}
	}
}

func TestWildcards(t *testing.T) {
	if !MatchesEventType([]string{"*"}, "anything.at.all") {
		t.Fatal(`"*" did not match`)
	}
	prefix := []string{"payment.*"}
	if !MatchesEventType(prefix, "payment.settled") {
		t.Fatal("prefix wildcard did not match a child type")
	}
	if !MatchesEventType(prefix, "payment.refund.issued") {
		t.Fatal("prefix wildcard did not match a nested type")
	}
	if MatchesEventType(prefix, "payments.settled") {
		t.Fatal(`"payment.*" matched "payments.settled"; the separator is not being enforced`)
	}
	if MatchesEventType(prefix, "payment") {
		t.Fatal(`"payment.*" matched the bare prefix`)
	}
}

// The Convoy failure mode this platform exists to avoid: a subscription that
// reads as filtered must never quietly receive everything.
func TestFilteredSubscriptionNeverWidensToEverything(t *testing.T) {
	subs := []Subscription{
		{ID: "sub_finance", EndpointID: "ep_finance", EventTypes: []string{"payment.settled"}, Enabled: true},
		{ID: "sub_audit", EndpointID: "ep_audit", EventTypes: []string{"*"}, Enabled: true},
	}

	matched := Match(subs, "customer.deleted")
	if len(matched) != 1 || matched[0].ID != "sub_audit" {
		t.Fatalf("expected only the catch-all subscription, got %+v", matched)
	}

	matched = Match(subs, "payment.settled")
	if len(matched) != 2 {
		t.Fatalf("expected both subscriptions to match, got %d", len(matched))
	}
}

func TestDisabledSubscriptionsNeverMatch(t *testing.T) {
	subs := []Subscription{
		{ID: "sub_off", EndpointID: "ep_1", EventTypes: []string{"*"}, Enabled: false},
	}
	if got := Match(subs, "order.created"); len(got) != 0 {
		t.Fatalf("disabled subscription matched: %+v", got)
	}
}

func TestEmptyPatternListMatchesNothing(t *testing.T) {
	if MatchesEventType(nil, "order.created") {
		t.Fatal("an empty pattern list matched; failing open is a data leak")
	}
}
