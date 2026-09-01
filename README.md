# ORCA Graph v8.11.0

Version 8.11.0 makes the graph Inspector independently collapsible and
restorable, allowing the canvas to use the released width. A single node click
now selects it without changing graph visibility, while a double click reveals
its direct neighbours; repeated double clicks on newly revealed nodes expand
the graph recursively. The selected-node Inspector also offers a contextual
Show/Hide neighbours action that respects the manual graph visibility state.

Version 8.10.0 widens and enlarges the graph category browser, adds live
name search across its node checklists and aligns every category marker with
the corresponding Cytoscape node shape and colour. The Inspector relation
section is now collapsible and uses full-width relationship rows with a fixed
delete-action column, preventing narrow wrapped cards. Both graph side panels
have additional room while the existing sidebar collapse control is retained.

Version 8.9.0 turns the graph legend into an interactive category browser.
Each node type expands into a named checklist with per-node and whole-category
visibility controls. The dedicated Scope filter has been removed; user, node
type and neighbourhood filters remain available. Clicking a graph node now
adds its direct neighbours recursively, while explicitly hidden nodes remain
hidden. The login screen and application footer link to the public GitHub
repository at `https://github.com/skai-upm/fiap-orca-graph`.

Version 8.8.0 replaces the browser-native view selector with a custom ORCA
Graph dropdown. The trigger shows the active view with its corporate icon and
the expanded panel presents every view as a descriptive card, highlights the
current selection and closes after selection or an outside click. The compact
desktop header and responsive hamburger navigation are preserved.

Version 8.7.0 replaces the three desktop view tabs with a compact dropdown in
the header while retaining the responsive hamburger navigation. Value-chain
link relations now persist exactly the relation selected in the form. The
specific fish and funding predicates are no longer declared as subproperties
of `orca:isRelated`, preventing GraphDB from inferring an additional generic
“is related” edge for every explicit link relation.

Version 8.6.0 replaces the former recursive Component hierarchy with three
explicit levels: Component, Subcomponent and Element. Subcomponent is an
`rdfs:subClassOf` Component and Element is an `rdfs:subClassOf` Subcomponent;
all inherit the same required name and description datatype properties.
Component–Subcomponent and Subcomponent–Element associations are N:N and store
their explicit inverses. Only Components can be selected from Scope, while KPI
can be associated with any of the three levels. The Data menu, forms, tables,
graph, Scope traversal, permissions and Excel export include both new levels.
Startup migration converts the earlier component hierarchy while preserving
resource IRIs, literals, ownership, chain context and KPI links.

Version 8.5.0 redesigns the bulk-sharing selector as compact searchable cards
with integrated selection marks, counters, and clear All/None controls.
Recipients of shared ontology definitions can now both edit and delete them.
KPI `identification` is replaced by an editable `code`: new KPI forms propose a
UUID automatically, the backend supplies one when absent, and custom codes do
not need to be unique. Existing `orca:identification` values are migrated to
the new functional `orca:code` datatype property with range `xsd:string`.

Version 8.4.0 aligns every permission lock at the far right of the Data sidebar,
independently of label length. Definitions and every graph level now expose a
bulk sharing workflow: owners can select all or any subset of the currently
visible resources and add the same users or teams in one operation. Existing
grants are preserved. Node owners can bulk-share only their own resources;
definition sharing remains reserved to special users and administrators, and
role-based editing restrictions continue to apply to every recipient.

Version 8.3.0 adds permission cues to the Data sidebar. A new `Niveles`
heading groups the graph entity sections; an open or closed lock indicates
whether the current user can modify that level, and a selected read-only level
uses orange instead of green. Ontology definitions can now be shared by special
users and administrators with individual users or teams. Delegated recipients
can edit those definitions and can delete non-core definitions, while core
ontology concepts remain protected from deletion.

Version 8.2.0 makes the application navigation responsive. Below 1100 pixels,
the desktop header actions are replaced by a right-aligned hamburger menu that
contains all views, presence information, account actions and role-dependent
administration options. The left navigation can now be collapsed and restored
in Data, Graph and Explore views; it remains expanded by default on every load.

Version 8.1.0 completes the sharing interface with a visible Share action in
every entity table. Sharing a value chain grants access to its current and
future nodes through their `orca:inValueChain` context. Delegation never raises
the recipient's role: normal users can edit or delete shared scopes, components,
subcomponents, elements and KPI, while special users and administrators can
also modify shared chains,
links and agents. Team editing now uses searchable member selection and
removable chips, and team action buttons retain readable labels at every width.

Version 8.0.0 introduces teams and delegated node permissions. Special users
and administrators can create uniquely named teams and manage multiple members;
normal users can inspect their memberships and leave a team. A node owner can
grant the complete edit-and-delete capability to individual users or teams.
Team-derived access is evaluated dynamically, so leaving or deleting a team
revokes that access immediately. Ownership does not change and only the owner
can manage a node's grants. The semantic model adds `orca:Team`, `orca:User`,
`orca:hasMember` and `orca:memberOf`; teams have exactly one `orca:name`
literal with datatype `xsd:string`.

Version 7.33.0 lets special users and administrators duplicate any existing value chain. The user supplies a new globally unique name and the backend clones the complete chain workspace into the requesting user's named graph. Every application resource receives a new IRI, internal relations are rewired to the new resources, RDF types and literal datatypes are preserved, and legacy resources without explicit `orca:inValueChain` assertions are assigned to the new chain. The source chain remains unchanged.

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
separate sheets for chains, links, scopes, components, subcomponents, elements, agents, KPI and
relations.

## Semantic model v8

| Source | Relation | Target |
|---|---|---|
| `orca:Scope` | `orca:hasComponent` | `orca:Component` |
| `orca:Component` | `orca:hasSubcomponent` | `orca:Component` |
| `orca:Component` | `orca:hasKPI` | `orca:KPI` |
| `orca:KPI` | `orca:appliesToComponent` | `orca:Component` |
| `orca:KPI` | `orca:similarTo` | `orca:KPI` |
| `orca:Team` | `orca:hasMember` | `orca:User` |
| `orca:User` | `orca:memberOf` | `orca:Team` |
| `orca:ValueChain` | `orca:hasValueChainLink` | `orca:ValueChainLink` |
| `orca:PrincipalAgent` | `orca:belongsTo` | `orca:ValueChainLink` |
| `orca:AuxiliaryAgent` | `orca:participatesInValueChainLink` | `orca:ValueChainLink` |
| `orca:SupportAgent` | `orca:participatesInValueChainLink` | `orca:ValueChainLink` |
| `orca:KPI` | `orca:appliesToValueChainLink` | `orca:ValueChainLink` |
| `orca:KPI` | `orca:appliesToAgent` | `orca:Agent` |
| `orca:Agent` | `orca:hasAssociatedKPI` | `orca:KPI` |
| `orca:ValueChainLink` | `orca:precedes` | `orca:ValueChainLink` |

The ontology uses English IRIs and bilingual `rdfs:label` and `rdfs:comment`
annotations. KPI names, codes, descriptions and evaluations use the
datatype properties `orca:name`, `orca:code`, `orca:description` and
`orca:evaluation`, all with range `xsd:string`.

These rules are enforced by both the GUI and API:

- A `Scope` relates only to zero or more `Component` instances and is not hierarchical.
- `Component` relates N:N to `Subcomponent`; `Subcomponent` relates N:N to `Element`, with explicit inverse triples.
- KPI classification can use components, subcomponents or elements, never scopes.
- `similarTo` is symmetric and connects two KPIs.
- A value chain link requires a value chain.
- A principal agent belongs to a value-chain link.
- Auxiliary and support agents participate in a value-chain link.
- Support agents may be general, research, training or government agents.
  Government support agents may additionally be national or regional. These
  categories are modeled as an OWL subclass hierarchy and selected through a
  controlled dropdown when the node is created.
- Every KPI requires a name, code, description and evaluation, and can relate to agents, components, subcomponents and elements.
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
- Normal users create and edit scopes, components, subcomponents, elements and KPIs.
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
for scopes, components, subcomponents, elements, KPI, agents, value chains and relations. Search and
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
entities are attributed to their corresponding bootstrap accounts. Owners can
delegate edit-and-delete rights to users or teams without transferring
ownership. Delegated users cannot change sharing grants.

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
- KPI forms with an automatically proposed editable code, required description and evaluation fields, and selectors for agents and all three component levels.

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
