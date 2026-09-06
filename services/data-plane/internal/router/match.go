// Package router turns one accepted event into N delivery rows, one per
// matching subscription (ARCHITECTURE.md 18). The fan-out is materialised: each
// delivery then has an independent lifecycle, so one endpoint failing can never
// affect another, and "did finance ever receive this?" is a row lookup.
package router

import "strings"

// Subscription is the routing-relevant projection of a webhook_subscriptions row.
type Subscription struct {
	ID         string
	EndpointID string
	EventTypes []string
	Enabled    bool
}

// MatchesEventType reports whether a subscription pattern selects eventType.
//
// Supported forms:
//
//	"*"               every event
//	"payment.*"       every event whose type begins "payment."
//	"payment.settled" that type exactly
//
// Filters are a first-class, always-on feature. Convoy's community build
// silently rewrites a filtered subscription to ["*"] when the licence lacks
// advanced_subscriptions, so a subscription that reads as filtered receives
// everything. Silently widening a filter is a data-leak bug; if a pattern
// cannot be honoured here, nothing matches rather than everything.
func MatchesEventType(patterns []string, eventType string) bool {
	for _, pattern := range patterns {
		if pattern == "*" {
			return true
		}
		if prefix, ok := strings.CutSuffix(pattern, ".*"); ok {
			if strings.HasPrefix(eventType, prefix+".") {
				return true
			}
			continue
		}
		if pattern == eventType {
			return true
		}
	}
	return false
}

// Match returns the subscriptions that should receive eventType. A disabled
// subscription never matches.
func Match(subs []Subscription, eventType string) []Subscription {
	matched := make([]Subscription, 0, len(subs))
	for _, s := range subs {
		if !s.Enabled {
			continue
		}
		if MatchesEventType(s.EventTypes, eventType) {
			matched = append(matched, s)
		}
	}
	return matched
}
