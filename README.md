# ORCA Graph v7.11.0

**Ontology-Restricted Collaborative Authoring of Graphs**

ORCA Graph is a collaborative editor for knowledge graphs governed by a fixed
ontology. It combines a React/Cytoscape.js interface, a FastAPI backend,
SQLite-based authentication and GraphDB RDF persistence.

Version 7.11.0 lets value-chain links manage their associated KPIs, removes the
Relations section from the data sidebar and exports the six entity tables plus
a dedicated IRIs sheet to Excel. It retains the complete OM 2.0 ontology in an
independent GraphDB named graph and its unit search by name, symbol or IRI.
Version 7.9.0 added specialised Agent and KPI tables, removed the redundant type
column from entity tables and Excel exports, and introduces searchable
multi-select relationship fields for Agent-KPI, Agent-Link, KPI-Component,
KPI-Agent and KPI-Link associations. Creation and editing use the same
author-aware controls. It retains the specialised scope, component, value-chain
and value-chain-link tables, with
coloured pills for chain membership and preceding/following links. Version
7.6.0 added specialised value-chain forms, explicit graph navigation, and
removes legacy unowned seed entities. Version 7.4.0 added entity-specific creation forms, searchable multi-select
controls with removable tags, a unified agent form with conditional subtype,
and multiple link/component relationships. Version 7.3.0 added ownership-aware
edit and delete actions to every entity
table. It also exports the complete data workspace to one Excel workbook with
separate sheets for chains, links, scopes, components, agents, KPI and
relations.

## Semantic model v7

| Source | Relation | Target |
|---|---|---|
| `orca:Scope` | `orca:hasComponent` | `orca:Component` |
| `orca:Component` | `orca:hasSubcomponent` | `orca:Component` |
| `orca:Component` | `orca:hasKPI` | `orca:KPI` |
| `orca:KPI` | `orca:appliesToComponent` | `orca:Component` |
| `orca:KPI` | `orca:similarTo` | `orca:KPI` |
| `orca:ValueChain` | `orca:hasValueChainLink` | `orca:ValueChainLink` |
| `orca:PrincipalAgent` | `orca:belongsTo` | `orca:ValueChainLink` |
| `orca:AuxiliaryAgent` | `orca:participatesInValueChainLink` | `orca:ValueChainLink` |
| `orca:SupportAgent` | `orca:participatesInValueChainLink` | `orca:ValueChainLink` |
| `orca:KPI` | `orca:appliesToValueChainLink` | `orca:ValueChainLink` |
| `orca:KPI` | `orca:appliesToAgent` | `orca:Agent` |
| `orca:Agent` | `orca:hasAssociatedKPI` | `orca:KPI` |
| `orca:ValueChainLink` | `orca:precedes` | `orca:ValueChainLink` |

The ontology uses English IRIs and bilingual `rdfs:label` and `rdfs:comment`
annotations. Names, descriptions and KPI definitions use the custom properties
`orca:name`, `orca:description` and `orca:definition`.

These rules are enforced by both the GUI and API:

- A `Scope` relates to zero or more components and is not hierarchical.
- Components may form a hierarchy through `hasSubcomponent`.
- KPI classification uses components, never scopes.
- `similarTo` is symmetric and connects two KPIs.
- A value chain link requires a value chain.
- A principal agent belongs to a value-chain link.
- Auxiliary and support agents participate in a value-chain link.
- Support agents may be general, research, training or government agents.
  Government support agents may additionally be national or regional. These
  categories are modeled as an OWL subclass hierarchy and selected through a
  controlled dropdown when the node is created.
- Every KPI requires a name, definition and one OM 2 unit.
- OM 2.0 is stored in the named graph
  `https://orca-graph.example/graph/ontology/om-2.0`.
- A KPI may be related simultaneously to components, value-chain links and
  agents of any type.
- `orca:hasKPI` and `orca:appliesToComponent` are inverse properties. The GUI
  displays one canonical `Component -> KPI` arrow regardless of the direction used
  to create the assertion.
- `orca:appliesToAgent` and `orca:hasAssociatedKPI` are inverse properties.
- The deployed software version is always displayed in the HTML footer.
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
- Administrator accounts can create or permanently delete users and assign
  normal, special, or administrator roles.
- Special users and administrators can create chains and value-chain links.
- Normal users create and edit scopes, components, agents, and KPIs.
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
| `orca` | `orca123` | Administrator |
| `andrea` | `demo123` | Andrea Cimmino |
| `maria` | `demo123` | María Pérez |

Version 7.2.0 applies these credentials once when upgrading an existing data
volume, so the three accounts can be used without deleting the current SQLite
database. Password changes made afterwards are preserved on normal restarts.

The example graph contains attributed contributions from all three users:
ORCA provides a circular-fishing value chain and link, Andrea provides an
energy component, KPI and principal agent, and María provides a logistics
agent and delivery KPI.

## Data and graph views

The application opens in a table-based data workspace with separate sections
for scopes, components, KPI, agents, value chains and relations. Search and
authorship filters work over the same live GraphDB snapshot used by the graph
view. Selecting a row can focus the corresponding node in the graph; no RDF is
duplicated between the two interfaces.

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

### Data ownership

Every application entity is stored in the named graph of a real user. Version
7.6.0 removes the legacy global seed graph during startup, so no value chain,
link, scope, component, agent, or KPI is displayed without an owner. Example
entities are attributed to their corresponding bootstrap accounts and can be
managed according to the normal ownership and role rules.

## GUI

The interface includes:

- Light visual identity based on navy, cerulean, cyan and green.
- Original RDF-inspired application mark formed by resources, a literal and
  connecting relations.
- Original SKAI Research Group logo.
- Current user and logout control.
- Password-change dialog for every account.
- Administrator-only user panel for creating normal, special, or administrator
  accounts and permanently deleting accounts and their RDF graphs.
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
