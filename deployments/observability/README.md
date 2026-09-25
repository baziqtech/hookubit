# Observability

Scrape config, alert rules and a Grafana dashboard for the platform's Prometheus
metrics (ARCHITECTURE.md 44, Phase 6).

The platform installs none of this. It exports metrics and stops there, the same
way it requires an external PostgreSQL rather than shipping one — a bundled
Prometheus is a second thing to operate and the first thing to be out of date.

| Path | What it is | How it is used |
|---|---|---|
| `prometheus/scrape-config.yaml` | `scrape_configs` entry for the four Go roles | Paste into your Prometheus. A PodMonitor equivalent is in the header, for prometheus-operator |
| `prometheus/alerts.yaml` | Rule groups | `rule_files:`, or the `spec:` of a PrometheusRule |
| `../helm/hookubit/dashboards/hookubit.json` | The delivery dashboard | Import into Grafana, or set `observability.grafanaDashboard.enabled=true` and let the Grafana sidecar load it |

The dashboard JSON lives inside the chart because Helm's `.Files.Get` can only
read files under the chart directory, and one copy that both paths use beats two
copies that drift.

## What is exported, and by whom

Only the data plane exports Prometheus metrics, on `:9090/metrics` — the same
port as its probes, on all four roles. The control API has no metrics endpoint
today and the dashboard is static files behind nginx.

## Every panel is backed by a real series

Panels and rules reference only metrics that something in
`services/data-plane/internal/metrics` or `internal/router/metrics.go` actually
writes. Two absences are deliberate and worth knowing about:

- **There is no "circuit breakers currently open" panel.** `circuit_breaker_open_total`
  counts *transitions into* open; no gauge of live breaker state exists. A panel
  for one would have been a flat line at zero forever.
- **`queue_depth` needs a collector running.** `metrics.NewQueueDepthCollector`
  refreshes it; until a role starts one, the gauge is absent, the backlog panel
  is empty and `WebhookQueueDepthNotExported` fires to say so. That rule exists
  because the failure it catches — a backlog gauge that reads a confident,
  permanent zero — is indistinguishable from a healthy queue.

## The one panel worth reading first at 2am

`Queue depth by state`. A delivery held back by an open circuit breaker or a
rate limit produces no attempt, no response class and no latency sample: it is
work that is *not happening*, and counters of things that happened cannot show
it. `ready` climbing while the attempt rate stays flat is that failure, and it
is the only place it is visible.
