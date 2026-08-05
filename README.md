# ORCA Graph v7.32.0

Version 7.32.0 extends the graph's Scope filter into a semantic path view. Selecting one or more scopes now displays the selected scope nodes, their direct and nested components, the KPI associated with those components, the agents associated with those KPI, and the value-chain links associated with those agents. Relations among the resulting links are preserved. Multiple scopes produce the union of their paths without duplicating graph elements.

Version 7.30.0 replaces the KPI definition with three explicit textual fields: identification, description and evaluation. Together with the existing name, these values are persisted as `xsd:string` datatype literals through `orca:name`, `orca:identification`, `orca:description` and `orca:evaluation`. Creation, editing, tables, graph inspectors, search and Excel export use the new structure. During startup, legacy KPI definitions are moved to descriptions and the new fields are initialised without removing existing KPI resources.

Version 7.29.0 adds combinable multi-selection filters to the Graph view. Scope, creator, node type, and specific node/neighbourhood filters now accept multiple values and render each selection as a removable pill. Values within one filter are combined with OR, while different filter levels are combined with AND. Selecting several specific nodes displays the union of their immediate neighbourhoods. All graph filters remain scoped to the active value chain and are cleared when the active chain changes.

The Explore view introduced in v7.28.0 remains available alongside the Data and Graph views. Exploration is scoped to the active value chain: users choose a node type, search with similarity-ranked suggestions, select a starting node to display its immediate neighbourhood, and recursively expand the visible graph by clicking neighbouring nodes.

Version 7.27.0 keeps the active value-chain workspace introduced in v7.26.0, but the Value Chain section now always lists every available chain. Each row can activate its chain using the same context switch as the selector in the workspace header; the active row is clearly identified. All remaining data views, the graph and exports continue to be scoped to the active chain.

Version 7.26.0 introduces the active value-chain workspace: every user selects a chain before working, all data views, graph views and exports are scoped to it, and new links are assigned automatically. Value-chain nodes are omitted from the graph while their context remains visible in the header. New entities persist their workspace through `orca:inValueChain`. It builds on version 7.25.0, which incorporates the ORCA Graph logo into the login and application
header, and centres the contents of searchable dropdown options. It also retains
the navigation, graph legend, and inverse-edge simplifications introduced in
version 7.24.0, which collapses
the inverse Agent-KPI properties into a single visual edge while preserving
both ontology relations. It builds on version 7.23.0, which separates Definitions visually in the navigation, localises the
funding relation in Spanish and simplifies most graph relations to unlabelled,
dashed, non-directed lines. It builds on version 7.22.0, which removes units from KPIs throughout the ontology and application,
closes every modal and searchable dropdown when clicking outside it, and expands
the value-chain-link table with its related agents and a clearer relationship
column heading.

**Ontology-Restricted Collaborative Authoring of Graphs**

ORCA Graph is a collaborative editor for knowledge graphs governed by a fixed
ontology. It combines a React/Cytoscape.js interface, a FastAPI backend,
SQLite-based authentication and GraphDB RDF persistence.

Version 7.21.0 removes KPI-to-link associations: KPIs now relate only to
agents and components. Any agent can participate in any value-chain link.
Links use the general `isRelated` property and the selectable subproperties
“Pescado fresco”, “Pescado seco”, “Harina de pescado” and “Financiación”.

In the graph, relations between value-chain links and relations in the component
hierarchy remain solid, labelled and directed. All other relations are rendered
as dashed lines without labels or arrowheads.
Legacy `precedes` statements are migrated to `isRelated` during startup.

Version 7.15.0 arranges the hierarchical graph vertically from top to bottom as
Value Chain, Value Chain Links, Agents, KPIs, Components and Scopes, while
keeping generous horizontal spacing within each level.

Version 7.14.0 adds a stable hierarchical graph layout, preserves existing
node positions when the current user edits the graph, and reports remote
changes without reloading the graph automatically. Users incorporate pending
remote changes explicitly with the **Actualizar grafo** button or by reloading
the page.

Version 7.21.0 protects every class included in the original ontology from
deletion while keeping its Spanish label and definition editable. Classes
created later in the Definitions section remain editable and deletable by any
special or administrator account. Version 7.19.0 adds controlled concept deletion, alphabetical concept ordering,
and simpler Spanish labels in the concept form. Version 7.18.0 presented ontology concept creation and editing in the same
centered modal dialog used by the remaining entity forms. Version 7.17.0 fixes
ontology editing for the ORCA administrator, hides concept
IRIs from the portal, generates new IRIs automatically, and lets administrators
hide or reveal concepts to normal users. Special users can edit every concept,
regardless of its creator. Version 7.16.0 adds an ontology Definitions section above value chains. Every
authenticated user can read the complete class table, while special and
administrator accounts can create or edit Spanish `rdfs:label` and
`rdfs:comment` values. New concepts become `owl:Class` resources and changes
are persisted both in GraphDB and in the mounted Turtle source file.
Version 7.13.0 restricts the creation of every agent type to special and
administrator accounts and places Agents between Links and Scopes in the data
navigation. Version 7.12.0 restricts auxiliary-agent management and Excel exports to special
and administrator accounts, removes the generic government subtype from the
form, and adds the local government support-agent subtype to the ontology.

Version 7.11.0 lets value-chain links manage their associated KPIs, removes the
Relations section from the data sidebar and exports the six entity tables plus
a dedicated IRIs sheet to Excel.
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
annotations. KPI names, identifications, descriptions and evaluations use the
datatype properties `orca:name`, `orca:identification`, `orca:description` and
`orca:evaluation`, all with range `xsd:string`.

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
- Every KPI requires a name, identification, description and evaluation, and can relate to agents and components.
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
- KPI forms with required identification, description and evaluation fields and selectors for agents and components.

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
