# SiteTrack

A construction project and materials-tracking backend built with TypeScript,
Effect 4 and PostgreSQL. It provides accounts and sessions, project teams and
invitations, task dependency graphs, inventory and delivery workflows through a
JSON HTTP API. Browsers, mobile apps, HTTP libraries and curl can all use it.

Built by Fabrizio Paravecino for the Seron Labs backend assignment.

## Quick start

With Docker Engine and Docker Compose available, run from the repository root:

```sh
docker compose up
```

Compose builds the API, starts PostgreSQL and applies migrations before serving
requests. No environment file, Nix, Just or private secrets are required.
The pinned images use Node.js `24.22.3-bookworm-slim` and PostgreSQL
`16.16-bookworm`.

- [Interactive API documentation](http://localhost:3000/docs)
- [OpenAPI contract](http://localhost:3000/openapi.json)
- [Readiness check](http://localhost:3000/health/ready)

The API is published on `127.0.0.1:3000`; PostgreSQL has no published host port.
Compose uses public local-only demo credentials and a demo signing key. Register
an account through the API to begin; startup does not create users or seed data.
The assignment permits users to select any role during registration, including
SuperAdmin.

See the [authentication guide and curl examples](docs/STAGE2.md#session-and-client-contract)
for Bearer tokens, refresh cookies and the required authentication headers.

Stop the services with:

```sh
docker compose down
```

The database volume is retained. Starting again preserves data and applies only
pending migrations.

## Design and tradeoffs

HTTP contracts validate inputs and declare responses. Effect services coordinate
permissions and transactions; pure domain functions implement business rules;
repositories execute parameterized SQL. Native and Docker operation share the
same configuration model and migrations.

PostgreSQL locks coordinate concurrent graph, membership and inventory changes.
Stock balances and movement history are updated atomically, quantities use exact
decimals, and idempotency keys protect delivery retries. Soft deletion preserves
history and identifiers.

A single API process, a five-connection pool, offset pagination with exact totals
and project-scoped graph loading keep deployment straightforward. Lock contention
and expensive derived filters are the main scaling tradeoffs. Public role
selection and Compose credentials are evaluation defaults; production deployment
would require controlled privileged-role provisioning, private secrets, TLS,
shared rate limits and backup/restore procedures.

## Development and checks

Use Node.js 24 and npm, or enter the optional development environment with
`nix develop`. Install dependencies with `npm ci`.

```sh
npm run check  # Formatting, Effect-aware lint, types, unit tests and build
```

`just check` runs the same checks. PostgreSQL integration tests run separately
with explicit disposable test database configuration. Native startup also needs
explicit database and signing-key configuration. See the
[development guide](docs/DEVELOPMENT.md) for setup, SOPS bundles, settings and the
command reference.

Seeds and benchmarks are explicit commands in isolated Compose environments:

```sh
just seed-small
just bench-smoke small
just bench-down small
```

The full assignment dataset uses `just seed-large`. See the
[seed and benchmark guide](docs/STAGE5.md) for dataset sizes, npm/Docker
alternatives and measurement instructions. Large seeds and benchmarks can take
considerable time; stopping an environment preserves its volume.

## Verification and limits

Application revision `45d57f351` passed 96 unit tests, 57 real PostgreSQL
integration tests and 95-request Docker workflows, including a clean checkout
and persistent restarts. See [delivery verification](docs/DELIVERY.md) for the
recorded checks and their scope.

The assignment-sized dataset passed count and invariant checks. The latest
focused large-data benchmark had no request errors but met only 5 of 13 latency
targets; completion/lateness lists reached roughly 4.5/5.0 seconds p95 on the
constrained HDD laptop. Earlier full mixed-workload runs had errors; a successful
final full-workload qualification remains pending. Details are in the
[benchmark results](docs/STAGE5.md).

## Documentation

| Guide | Contents |
| --- | --- |
| [Specification](SPEC.md) | Product rules, permissions, architecture and acceptance criteria |
| [Development](docs/DEVELOPMENT.md) | Native setup, configuration, tooling and commands |
| [Accounts and projects](docs/STAGE2.md) | Authentication, teams, invitations and curl examples |
| [Tasks and graphs](docs/STAGE3.md) | Dependencies, task actions, filters and summaries |
| [Inventory and deliveries](docs/STAGE4.md) | Exact quantities, stock movements and idempotency |
| [Seeds and benchmarks](docs/STAGE5.md) | Datasets, measurement protocol and results |
| [Delivery verification](docs/DELIVERY.md) | Test evidence, lifecycle rehearsal and remaining limits |

## License

Copyright © 2026 Fabrizio Paravecino. All rights reserved.
Original code and documentation are provided under the private evaluation terms
in [LICENSE](LICENSE). Third-party dependencies, vendored code and assignment
materials retain their respective ownership and licensing terms.
