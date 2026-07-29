# ORCA Graph

**Ontology-Restricted Collaborative Authoring of Graphs**

ORCA Graph is a collaborative editor for knowledge graphs governed by a fixed
ontology. It combines a React/Cytoscape.js interface, a FastAPI backend,
SQLite-based authentication and GraphDB RDF persistence.

## Semantic model v8.2

| Source | Relation | Target |
|---|---|---|
| `orca:Scope` | `orca:hasSubscope` | `orca:Scope` |
| `orca:Scope` | `orca:similarTo` | `orca:Scope` |
| `orca:KPI` | `orca:similarTo` | `orca:KPI` |
| `orca:ValueChain` | `orca:hasValueChainLink` | `orca:ValueChainLink` |
| `orca:PrincipalAgent` | `orca:belongsTo` | `orca:ValueChainLink` |
| `orca:AuxiliaryAgent` | `orca:participatesInValueChainLink` | `orca:ValueChainLink` |
| `orca:SupportAgent` | `orca:participatesInValueChainLink` | `orca:ValueChainLink` |
| `orca:KPI` | `orca:appliesToValueChainLink` | `orca:ValueChainLink` |
| `orca:KPI` | `orca:appliesToAgent` | `orca:AuxiliaryAgent` or `orca:SupportAgent` |
| `orca:KPI` | `orca:appliesToScope` | `orca:Scope` |
| `orca:Scope` | `orca:hasKPI` | `orca:KPI` |
| `orca:ValueChainLink` | `orca:precedes` | `orca:ValueChainLink` |

The ontology uses English IRIs and bilingual `rdfs:label` and `rdfs:comment`
annotations. Names, descriptions and KPI definitions use the custom properties
`orca:name`, `orca:description` and `orca:definition`.

These rules are enforced by both the GUI and API:

- A `Scope` may be a root scope or a subscope of another `Scope`.
- `similarTo` is symmetric and only connects two scopes or two KPIs.
- A value chain link requires a value chain.
- A principal agent belongs to a value-chain link.
- Auxiliary and support agents participate in a value-chain link.
- Support agents may be general, research, training or government agents.
  Government support agents may additionally be national or regional. These
  categories are modeled as an OWL subclass hierarchy and selected through a
  controlled dropdown when the node is created.
- Every KPI requires a name, definition, application level, free-text
  application scope and one OM 2 unit.
- A KPI may be related to one or more scopes independently of its operational
  target. For operational targets, value-chain links and direct
  auxiliary/support agents remain mutually exclusive.
- `orca:hasKPI` and `orca:appliesToScope` are inverse properties. The GUI
  displays one canonical `Scope -> KPI` arrow regardless of the direction used
  to create the assertion.
- The deployed software version is always displayed in the HTML footer.
- A KPI cannot apply directly to a principal agent.
- Self-relations are rejected.
- Inverse structural relations are written automatically.

The validation matrix is centralized in `backend/app/domain.py`. The vocabulary
is in `backend/ontology/orca-graph.ttl`.

## Collaboration and permissions

Each user has a personal named graph:

```text
https://orca-graph.example/graph/users/{user-id}
```

The backend follows these rules:

- The global named graph is visible to everyone and read-only.
- Personal graphs are visible to every authenticated user.
- New nodes and relations are always written into the current user's graph.
- The client cannot choose the destination graph.
- Nodes from the global or another user's graph may be linked without modifying
  the original graph.
- A user may delete only nodes and relations stored in their personal graph.
- Deleting an owned node also removes every incoming and outgoing ontology
  relation across all personal graphs.
- WebSocket events refresh every connected browser after a committed change.
- Only the ORCA account can create or permanently delete application users.
- Deleting a user removes their sessions, relational account, complete RDF
  named graph and every relation in other graphs that references their nodes.
- Every authenticated user can change their own password after confirming the
  current one; all existing sessions are revoked after the change.

SQLite stores users and sessions only. GraphDB stores all RDF. SQLAlchemy and
`DATABASE_URL` isolate the relational persistence so it can later be switched
to PostgreSQL.

## Run with Docker

Requirements: Docker Engine, the Compose plugin and approximately 2.5 GB of
available memory.

```bash
docker compose up --build
```

Open:

- ORCA Graph: http://localhost:9090
- API documentation: http://localhost:9091/docs
- GraphDB Workbench: http://localhost:9092

The backend creates the GraphDB repository, ontology, relational schema, users
and sample contributions during its first start.

### Demo users

| User | Password | Personal graph |
|---|---|---|
| `orca` | `orca123` | ORCA, exclusive value-chain manager |
| `andrea` | `demo123` | Andrea Cimmino |
| `maria` | `demo123` | María Pérez |

Version 6.0.0 applies these credentials once when upgrading an existing data
volume, so the three accounts can be used without deleting the current SQLite
database. Password changes made afterwards are preserved on normal restarts.

The example graph contains attributed contributions from all three users:
ORCA provides a circular-fishing value chain and link, Andrea provides an
energy scope, KPI and principal agent, and María provides a logistics agent
and delivery KPI.

### Daily GraphDB backups

Docker Compose also starts a `backup` service. It performs one logical export
as soon as it starts and repeats it every 24 hours. Files are written to the
host directory `./backups` using compressed TriG:

```text
backups/orca-graph_20260729T180000Z.trig.gz
```

TriG preserves the default graph and every named graph. A temporary file is
used during export and renamed only after a successful download, preventing an
interrupted export from appearing as a valid backup. Backups older than 30
days are removed by default.

The schedule and retention are configurable in `docker-compose.yml`:

```yaml
BACKUP_INTERVAL_SECONDS: 86400
BACKUP_RETENTION_DAYS: 30
```

To restore into an empty `orca-graph` repository:

```bash
gzip -dc backups/orca-graph_YYYYMMDDTHHMMSSZ.trig.gz |
  curl -X POST \
    -H "Content-Type: application/trig" \
    --data-binary @- \
    http://localhost:9092/repositories/orca-graph/statements
```

This service backs up the RDF repository. The application accounts and
sessions remain in the separate `orca-data` SQLite volume.

Open two private browser windows with different users to test live
collaboration and read-only attribution.

### Preloaded value chain

The global read-only graph contains `CadenaPescaAngola` and these
`ValueChainLink` instances:

- `SectorPrimario`
- `Comercializadora`
- `Intermediario`
- `ConsumidorFinal`
- `Transformacion`
- `Hosteleria`

Their directed flow is represented with `orca:precedes`. Editors can reference
these nodes but cannot create or alter value-chain structure. Only the `orca`
account can create additional chains and links or alter value-chain topology;
preloaded global nodes remain read-only.

## GUI

The interface includes:

- Light visual identity based on navy, cerulean, cyan and green.
- Original RDF-inspired application mark formed by resources, a literal and
  connecting relations.
- Original SKAI Research Group logo.
- Current user and logout control.
- Password-change dialog for every account.
- ORCA-only user administration panel for creating and permanently deleting
  accounts and their RDF graphs.
- New accounts and password changes require at least eight characters. The
  administration form displays this requirement next to the password field.
- Node authorship and permission inspector.
- Foreign nodes and relations are shown with reduced opacity; the current
  user's contribution stays visually prominent.
- Foreign graph content uses validated Cytoscape boolean selectors, lighter
  per-type colour variants, 90% node opacity and 92% edge opacity.
- Scopes use rectangles, KPIs use diamonds, value chains use circles and
  value-chain links use ellipses. Agents retain distinct polygons with five or
  more sides. Triangular nodes are deliberately avoided to keep labels legible.
- Graph labels use larger, bold text and enlarged node bodies so names
  remain inside their shapes.
- Contextual deletion controls are only shown for relations and nodes owned by
  the logged-in user.
- Node size grows moderately with the square root of its number of unique
  neighbours, preserving type colours while making highly connected nodes easy
  to locate.
- Filters by scope, user, node type and node neighbourhood.
- Dynamic layout for small and larger graphs.
- Creation dialogs that only expose valid semantic combinations.
- KPI forms with controlled application levels, required free text and an OM
  unit selector.

Node shapes and colors encode the seven node types. The node name and author
initials are displayed inside each shape.

## Reset

To remove both SQLite and GraphDB prototype data:

```bash
docker compose down -v
docker compose up --build
```

Reset the volumes when upgrading from an earlier prototype because the RDF
vocabulary and demo graph have changed.

## Local tests

```bash
cd backend
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
PYTHONPATH=. pytest -q

cd ../frontend
npm install
npm run build
```

The project deliberately uses one FastAPI process while SQLite and the
in-memory WebSocket hub are active. Horizontal scaling should be accompanied by
PostgreSQL plus Redis Streams or another shared event bus.
