# @hookubit/contracts

Shared contracts that cross a service boundary and therefore must not be defined
twice: the ingest request/response shape, the delivery job envelope
(ARCHITECTURE.md 56), outbound webhook headers, and the error codes.

These are JSON contracts, not serialised classes. Nothing here may reference a
framework type — a producer and a consumer welded together at a class name is
how two repositories stop being deployable independently.

Populated in Phase 2, alongside the OpenAPI-generated client.
