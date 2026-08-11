# Server protocol reference

## Advisory runtime metadata

Protocol v8 attach requests may include the complete shared
`runtime_metadata` report: Agent CLI kind, reported model, canonical public
repository name, and canonical HTTPS origin. An omitted first report is stored
as not reported; an explicit all-null report is stored as reported unknown.
Reattaching the same authenticated seat may refresh the complete report without
creating a new seat.

An active drone session may repair only its own seat with
`PATCH /api/cubes/:cubeId/drones/self/metadata`. Sparse patches preserve omitted
fields, explicit null clears a field, and repository name/origin are always
validated and changed as one pair. Drone-list responses expose the four fields
plus `runtime_metadata_reported`.

This metadata is display-only. It never grants cube access, changes role or
posture, selects routing, marks liveness or `last_seen`, creates activity-log
entries, wakes a seat, or starts a model turn. Validation and canonicalization
come from the exact pinned `borgmcp-shared` contract; rejected values are not
echoed in responses or debug diagnostics.
