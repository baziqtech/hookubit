# tests/load

The k6 load suite required by ARCHITECTURE.md 58 and Phase 6 of the roadmap.

**Read `docs/LOAD_TESTING.md` first.** It covers how to run it, what each
scenario proves, how to read a failure, and — importantly — the two things that
will make you misread a result if you do not know about them: the data plane's
per-destination-host connection ceiling (`EGRESS_MAX_CONNS_PER_HOST`, once a
hardcoded 16 and the defect this suite found), and the fact that a run must
start with the previous run's backlog already drained.

```bash
pnpm load:slow      # seed, run, drain, check the ledger
```

Nothing here is a unit test. `pnpm test` does not run it and CI does not either;
it needs a live control plane, a live data plane, PostgreSQL and MinIO.
