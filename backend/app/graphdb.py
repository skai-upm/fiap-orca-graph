import asyncio

import httpx
from rdflib import Graph

from .config import settings
from .domain import (
    INVERSE_RELATIONS,
    NEW_NODE_SOURCE_RELATIONS,
    OM_UNITS,
    ORCA,
    ApplicationLevel,
    GraphSnapshot,
    Node,
    NodeType,
    Relation,
    RelationType,
    SupportAgentSubtype,
    UserPublic,
)


def sparql_iri(value: str) -> str:
    if not value.startswith(("http://", "https://")) or any(ch in value for ch in '<>"{}|\\^`'):
        raise ValueError("Invalid IRI")
    return f"<{value}>"


def sparql_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


class GraphDB:
    async def ensure_repository(self, attempts: int = 40) -> None:
        endpoint = f"{settings.graphdb_url}/rest/repositories"
        for _ in range(attempts):
            try:
                async with httpx.AsyncClient(timeout=4) as client:
                    response = await client.get(endpoint)
                    if response.status_code == 200:
                        repositories = response.json()
                        if any(item.get("id") == settings.graphdb_repository for item in repositories):
                            return
                        config = f"""
                            @prefix rep: <http://www.openrdf.org/config/repository#> .
                            @prefix sr: <http://www.openrdf.org/config/repository/sail#> .
                            @prefix sail: <http://www.openrdf.org/config/sail#> .
                            @prefix graphdb: <http://www.ontotext.com/config/graphdb#> .
                            [] a rep:Repository ;
                               rep:repositoryID "{settings.graphdb_repository}" ;
                               rep:repositoryImpl [
                                  rep:repositoryType "graphdb:SailRepository" ;
                                  sr:sailImpl [
                                     sail:sailType "graphdb:Sail" ;
                                     graphdb:ruleset "rdfsplus-optimized" ;
                                     graphdb:storage-folder "storage" ;
                                     graphdb:enable-context-index "true"
                                  ]
                               ] .
                        """
                        created = await client.post(
                            endpoint,
                            files={"config": ("repository.ttl", config, "text/turtle")},
                        )
                        created.raise_for_status()
                        return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(2)
        raise RuntimeError("Could not create or find the GraphDB repository")

    async def wait_until_ready(self, attempts: int = 40) -> None:
        for _ in range(attempts):
            try:
                async with httpx.AsyncClient(timeout=2) as client:
                    response = await client.get(settings.repository_url)
                    if response.status_code < 500:
                        return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(2)
        raise RuntimeError("GraphDB repository is not ready")

    async def query(self, sparql: str) -> dict:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                settings.repository_url,
                data={"query": sparql},
                headers={"Accept": "application/sparql-results+json"},
            )
            response.raise_for_status()
            return response.json()

    async def update(self, sparql: str) -> None:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(settings.statements_url, data={"update": sparql})
            response.raise_for_status()

    @staticmethod
    def node_type_iris() -> str:
        return ", ".join(sparql_iri(f"{ORCA}{item.value}") for item in NodeType)

    async def node(self, node_id: str) -> tuple[str, NodeType] | None:
        result = await self.query(
            f"""
            SELECT ?graph ?type WHERE {{
              GRAPH ?graph {{
                {sparql_iri(node_id)} a ?type .
                FILTER(?type IN ({self.node_type_iris()}))
              }}
            }} LIMIT 1
            """
        )
        bindings = result["results"]["bindings"]
        if not bindings:
            return None
        row = bindings[0]
        return row["graph"]["value"], NodeType(row["type"]["value"].removeprefix(ORCA))

    async def source_relation_types(self, node_id: str) -> set[RelationType]:
        result = await self.query(
            f"""
            SELECT DISTINCT ?predicate WHERE {{
              GRAPH ?graph {{ {sparql_iri(node_id)} ?predicate ?target . }}
              FILTER(?predicate IN (
                {sparql_iri(RelationType.APPLIES_TO_VALUE_CHAIN_LINK.iri)},
                {sparql_iri(RelationType.APPLIES_TO_AGENT.iri)},
                {sparql_iri(RelationType.APPLIES_TO_SCOPE.iri)}
              ))
            }}
            """
        )
        return {
            RelationType(row["predicate"]["value"].removeprefix(ORCA))
            for row in result["results"]["bindings"]
        }

    async def create_node(
        self,
        graph_uri: str,
        node_id: str,
        node_type: NodeType,
        name: str,
        description: str,
        definition: str | None,
        application_level: ApplicationLevel | None,
        application_scope: str | None,
        unit_iri: str | None,
        parent_id: str | None,
        relation: RelationType | None,
        support_agent_subtype: SupportAgentSubtype | None = None,
    ) -> None:
        properties = [f"{sparql_iri(f'{ORCA}name')} {sparql_string(name)}"]
        if description:
            properties.append(
                f"{sparql_iri(f'{ORCA}description')} {sparql_string(description)}"
            )
        if definition:
            properties.append(
                f"{sparql_iri(f'{ORCA}definition')} {sparql_string(definition)}"
            )
        if application_level:
            properties.append(
                f"{sparql_iri(f'{ORCA}hasApplicationLevel')} "
                f"{sparql_iri(application_level.iri)}"
            )
        if application_scope:
            properties.append(
                f"{sparql_iri(f'{ORCA}applicationScope')} "
                f"{sparql_string(application_scope)}"
            )
        if unit_iri:
            properties.append(
                f"{sparql_iri(f'{ORCA}unitOfMeasure')} {sparql_iri(unit_iri)}"
            )
        rdf_types = [sparql_iri(f"{ORCA}{node_type.value}")]
        if (
            node_type == NodeType.SUPPORT_AGENT
            and support_agent_subtype
            and support_agent_subtype != SupportAgentSubtype.GENERAL
        ):
            rdf_types.append(sparql_iri(support_agent_subtype.iri))
        triples = [
            f"{sparql_iri(node_id)} a {', '.join(rdf_types)} ; "
            + " ; ".join(properties)
            + " ."
        ]
        if parent_id and relation:
            source_id, target_id = (
                (node_id, parent_id)
                if relation in NEW_NODE_SOURCE_RELATIONS
                else (parent_id, node_id)
            )
            triples.extend(self.relation_triples(source_id, target_id, relation))
        await self.update(
            f"INSERT DATA {{ GRAPH {sparql_iri(graph_uri)} {{ {' '.join(triples)} }} }}"
        )

    @staticmethod
    def relation_triples(
        source_id: str,
        target_id: str,
        relation: RelationType,
    ) -> list[str]:
        triples = [
            f"{sparql_iri(source_id)} {sparql_iri(relation.iri)} {sparql_iri(target_id)} ."
        ]
        inverse = INVERSE_RELATIONS.get(relation)
        if inverse:
            triples.append(
                f"{sparql_iri(target_id)} {sparql_iri(inverse.iri)} {sparql_iri(source_id)} ."
            )
        return triples

    async def create_relation(
        self,
        graph_uri: str,
        source_id: str,
        target_id: str,
        relation: RelationType,
    ) -> None:
        triples = self.relation_triples(source_id, target_id, relation)
        await self.update(
            f"INSERT DATA {{ GRAPH {sparql_iri(graph_uri)} {{ {' '.join(triples)} }} }}"
        )

    async def relation_exists(
        self,
        graph_uri: str,
        source_id: str,
        target_id: str,
        relation: RelationType,
    ) -> bool:
        result = await self.query(
            f"""
            ASK {{
              GRAPH {sparql_iri(graph_uri)} {{
                {sparql_iri(source_id)} {sparql_iri(relation.iri)}
                {sparql_iri(target_id)} .
              }}
            }}
            """
        )
        return bool(result.get("boolean"))

    async def delete_relation(
        self,
        graph_uri: str,
        source_id: str,
        target_id: str,
        relation: RelationType,
    ) -> None:
        triples = self.relation_triples(source_id, target_id, relation)
        await self.update(
            f"DELETE DATA {{ GRAPH {sparql_iri(graph_uri)} {{ {' '.join(triples)} }} }}"
        )

    async def delete_node(self, graph_uri: str, node_id: str) -> None:
        relation_iris = ", ".join(sparql_iri(item.iri) for item in RelationType)
        # Remove the resource description and relations authored by its owner.
        await self.update(
            f"""
            DELETE WHERE {{
              GRAPH {sparql_iri(graph_uri)} {{
                {sparql_iri(node_id)} ?predicate ?object .
              }}
            }}
            """
        )
        # Cascade across every personal graph, but only over ontology relations.
        await self.update(
            f"""
            DELETE {{
              GRAPH ?graph {{
                {sparql_iri(node_id)} ?outRelation ?target .
                ?source ?inRelation {sparql_iri(node_id)} .
              }}
            }}
            WHERE {{
              GRAPH ?graph {{
                {{
                  {sparql_iri(node_id)} ?outRelation ?target .
                  FILTER(?outRelation IN ({relation_iris}))
                }}
                UNION
                {{
                  ?source ?inRelation {sparql_iri(node_id)} .
                  FILTER(?inRelation IN ({relation_iris}))
                }}
              }}
            }}
            """
        )

    async def delete_graph(self, graph_uri: str) -> None:
        relation_iris = ", ".join(sparql_iri(item.iri) for item in RelationType)
        node_type_iris = ", ".join(
            sparql_iri(f"{ORCA}{item.value}") for item in NodeType
        )
        # Remove references authored in other graphs before clearing the owner graph.
        await self.update(
            f"""
            DELETE {{
              GRAPH ?relationGraph {{
                ?node ?outRelation ?target .
                ?source ?inRelation ?node .
              }}
            }}
            WHERE {{
              GRAPH {sparql_iri(graph_uri)} {{
                ?node a ?nodeType .
                FILTER(?nodeType IN ({node_type_iris}))
              }}
              GRAPH ?relationGraph {{
                {{
                  ?node ?outRelation ?target .
                  FILTER(?outRelation IN ({relation_iris}))
                }}
                UNION
                {{
                  ?source ?inRelation ?node .
                  FILTER(?inRelation IN ({relation_iris}))
                }}
              }}
            }}
            """
        )
        await self.update(f"CLEAR GRAPH {sparql_iri(graph_uri)}")

    async def snapshot(
        self,
        users: list[UserPublic],
        current_user_id: str,
    ) -> GraphSnapshot:
        user_by_graph = {user.graph_uri: user for user in users}
        node_result = await self.query(
            f"""
            SELECT ?graph ?id ?type ?name ?description ?definition
                   ?applicationLevel ?applicationScope ?unit ?supportAgentSubtype
            WHERE {{
              GRAPH ?graph {{
                ?id a ?type ; {sparql_iri(f"{ORCA}name")} ?name .
                FILTER(?type IN ({self.node_type_iris()}))
                OPTIONAL {{ ?id {sparql_iri(f"{ORCA}description")} ?description }}
                OPTIONAL {{ ?id {sparql_iri(f"{ORCA}definition")} ?definition }}
                OPTIONAL {{
                  ?id {sparql_iri(f"{ORCA}hasApplicationLevel")} ?applicationLevel
                }}
                OPTIONAL {{
                  ?id {sparql_iri(f"{ORCA}applicationScope")} ?applicationScope
                }}
                OPTIONAL {{ ?id {sparql_iri(f"{ORCA}unitOfMeasure")} ?unit }}
                OPTIONAL {{
                  ?id a ?supportAgentSubtype .
                  FILTER(?supportAgentSubtype IN ({
                    ", ".join(
                        sparql_iri(item.iri)
                        for item in SupportAgentSubtype
                        if item != SupportAgentSubtype.GENERAL
                    )
                  }))
                }}
              }}
            }} ORDER BY ?name
            """
        )
        unit_labels = {unit.iri: f"{unit.label} ({unit.symbol})" for unit in OM_UNITS}
        nodes: list[Node] = []
        seen_ids: set[str] = set()
        for row in node_result["results"]["bindings"]:
            node_id = row["id"]["value"]
            if node_id in seen_ids:
                continue
            seen_ids.add(node_id)
            graph_uri = row["graph"]["value"]
            owner = user_by_graph.get(graph_uri)
            unit_iri = row.get("unit", {}).get("value")
            level_iri = row.get("applicationLevel", {}).get("value")
            nodes.append(
                Node(
                    id=node_id,
                    type=NodeType(row["type"]["value"].removeprefix(ORCA)),
                    name=row["name"]["value"],
                    description=row.get("description", {}).get("value", ""),
                    definition=row.get("definition", {}).get("value"),
                    application_level=(
                        ApplicationLevel(level_iri.removeprefix(ORCA))
                        if level_iri
                        else None
                    ),
                    application_scope=row.get("applicationScope", {}).get("value"),
                    unit_iri=unit_iri,
                    unit_label=unit_labels.get(unit_iri, unit_iri.rsplit("/", 1)[-1] if unit_iri else None),
                    support_agent_subtype=(
                        SupportAgentSubtype(
                            row["supportAgentSubtype"]["value"].removeprefix(ORCA)
                        )
                        if row.get("supportAgentSubtype")
                        else (
                            SupportAgentSubtype.GENERAL
                            if row["type"]["value"] == f"{ORCA}SupportAgent"
                            else None
                        )
                    ),
                    graph=graph_uri,
                    owner_id=owner.id if owner else None,
                    owner_name=owner.display_name if owner else "ORCA Graph",
                    owner_initials=owner.initials if owner else "OG",
                    editable=owner is not None and owner.id == current_user_id,
                )
            )
        node_ids = {node.id for node in nodes}
        visible_relation_types = {
            RelationType.HAS_SUBSCOPE,
            RelationType.SIMILAR_TO,
            RelationType.HAS_VALUE_CHAIN_LINK,
            RelationType.BELONGS_TO,
            RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK,
            RelationType.APPLIES_TO_VALUE_CHAIN_LINK,
            RelationType.APPLIES_TO_AGENT,
            RelationType.HAS_KPI,
            RelationType.PRECEDES,
        }
        relation_iris = ", ".join(
            sparql_iri(item.iri) for item in visible_relation_types
        )
        relation_result = await self.query(
            f"""
            SELECT ?graph ?source ?predicate ?target WHERE {{
              GRAPH ?graph {{
                ?source ?predicate ?target .
                FILTER(?predicate IN ({relation_iris}))
              }}
            }}
            """
        )
        relations: list[Relation] = []
        seen_relations: set[tuple[str, str, str]] = set()
        for row in relation_result["results"]["bindings"]:
            source = row["source"]["value"]
            target = row["target"]["value"]
            predicate = row["predicate"]["value"]
            key = (
                (min(source, target), predicate, max(source, target))
                if predicate == RelationType.SIMILAR_TO.iri
                else (source, predicate, target)
            )
            if source not in node_ids or target not in node_ids or key in seen_relations:
                continue
            seen_relations.add(key)
            graph_uri = row["graph"]["value"]
            owner = user_by_graph.get(graph_uri)
            relations.append(
                Relation(
                    source=source,
                    target=target,
                    type=RelationType(predicate.removeprefix(ORCA)),
                    graph=graph_uri,
                    owner_id=owner.id if owner else None,
                    owner_name=owner.display_name if owner else "ORCA Graph",
                    editable=owner is not None and owner.id == current_user_id,
                )
            )
        return GraphSnapshot(
            nodes=nodes,
            relations=relations,
            current_user_id=current_user_id,
        )

    async def seed_user_examples(self, users: list[UserPublic]) -> None:
        seed_graph = "https://orca-graph.example/graph/system-seed"
        seed_marker = "https://orca-graph.example/system/seed/6.0.0"
        seed_applied = "https://orca-graph.example/system/applied"
        exists = await self.query(
            f"ASK {{ GRAPH {sparql_iri(seed_graph)} {{ "
            f"{sparql_iri(seed_marker)} {sparql_iri(seed_applied)} \"true\" "
            f"}} }}"
        )
        if exists.get("boolean"):
            return
        users_by_id = {user.id: user for user in users}
        demo_updates = {
            "user-orca": f"""
              <https://orca-graph.example/resource/value-chain-circular-pilot>
                a <{ORCA}ValueChain> ;
                <{ORCA}name> "Circular fishing pilot" ;
                <{ORCA}description> "Pilot value chain created by ORCA." ;
                <{ORCA}hasValueChainLink>
                <https://orca-graph.example/resource/link-resource-recovery> .
              <https://orca-graph.example/resource/link-resource-recovery>
                a <{ORCA}ValueChainLink> ;
                <{ORCA}name> "Resource recovery" ;
                <{ORCA}description> "Recovery and reuse of fishing by-products." ;
                <{ORCA}isValueChainLinkOf>
                <https://orca-graph.example/resource/value-chain-circular-pilot> .
            """,
            "user-andrea": f"""
              <https://orca-graph.example/resource/scope-energy> a <{ORCA}Scope> ;
                <{ORCA}name> "Energy" ;
                <{ORCA}description> "Energy use and efficiency." .
              <https://orca-graph.example/resource/scope-sustainability>
                <{ORCA}hasSubscope>
                <https://orca-graph.example/resource/scope-energy> .
              <https://orca-graph.example/resource/agent-fishing-cooperative> a <{ORCA}PrincipalAgent> ;
                <{ORCA}name> "Angolan fishing cooperative" ;
                <{ORCA}belongsTo>
                <https://orca-graph.example/resource/link-primary-sector> .
              <https://orca-graph.example/resource/kpi-energy> a <{ORCA}KPI> ;
                <{ORCA}name> "Energy consumption" ;
                <{ORCA}definition> "Total energy consumed during production." ;
                <{ORCA}hasApplicationLevel> <{ORCA}Regional> ;
                <{ORCA}applicationScope> "Community of Madrid" ;
                <{ORCA}unitOfMeasure>
                <http://www.ontology-of-units-of-measure.org/resource/om-2/kilowattHour> ;
                <{ORCA}appliesToValueChainLink>
                <https://orca-graph.example/resource/link-primary-sector> .
            """,
            "user-maria": f"""
              <https://orca-graph.example/resource/agent-logistics> a <{ORCA}AuxiliaryAgent> ;
                <{ORCA}name> "Logistics provider" ;
                <{ORCA}participatesInValueChainLink>
                <https://orca-graph.example/resource/link-marketer> .
              <https://orca-graph.example/resource/kpi-delivery> a <{ORCA}KPI> ;
                <{ORCA}name> "On-time delivery" ;
                <{ORCA}definition> "Share of deliveries completed on time." ;
                <{ORCA}hasApplicationLevel> <{ORCA}Provincial> ;
                <{ORCA}applicationScope> "Province of Madrid" ;
                <{ORCA}unitOfMeasure>
                <http://www.ontology-of-units-of-measure.org/resource/om-2/percent> ;
                <{ORCA}appliesToAgent>
                <https://orca-graph.example/resource/agent-logistics> .
            """,
        }
        for user_id, triples in demo_updates.items():
            user = users_by_id.get(user_id)
            if user:
                await self.update(
                    f"INSERT DATA {{ GRAPH {sparql_iri(user.graph_uri)} {{ {triples} }} }}"
                )
        await self.update(
            f"INSERT DATA {{ GRAPH {sparql_iri(seed_graph)} {{ "
            f"{sparql_iri(seed_marker)} {sparql_iri(seed_applied)} \"true\" "
            f"}} }}"
        )

    async def seed(self, users: list[UserPublic]) -> None:
        ontology = Graph()
        ontology.parse(settings.ontology_path, format="turtle")
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.put(
                settings.statements_url,
                params={"context": f"<{ORCA}ontology>"},
                content=ontology.serialize(format="turtle"),
                headers={"Content-Type": "text/turtle"},
            )
            response.raise_for_status()
        exists = await self.query(
            f"ASK {{ GRAPH {sparql_iri(settings.global_graph_uri)} "
            f"{{ ?s a {sparql_iri(f'{ORCA}Scope')} }} }}"
        )
        if exists.get("boolean"):
            await self.seed_user_examples(users)
            return
        await self.update(
            f"""
            INSERT DATA {{ GRAPH {sparql_iri(settings.global_graph_uri)} {{
              <https://orca-graph.example/resource/scope-sustainability>
                a <{ORCA}Scope> ;
                <{ORCA}name> "Sustainability" ;
                <{ORCA}description> "Shared sustainability scope." .
              <https://orca-graph.example/resource/value-chain-angola-fishing>
                a <{ORCA}ValueChain> ;
                <{ORCA}name> "CadenaPescaAngola" ;
                <{ORCA}description> "Cadena de valor precargada del sector pesquero de Angola." .
              <https://orca-graph.example/resource/link-primary-sector>
                a <{ORCA}ValueChainLink> ;
                <{ORCA}name> "SectorPrimario" ;
                <{ORCA}description> "Extracción y producción primaria de recursos pesqueros." .
              <https://orca-graph.example/resource/link-marketer>
                a <{ORCA}ValueChainLink> ;
                <{ORCA}name> "Comercializadora" ;
                <{ORCA}description> "Comercialización y distribución inicial del producto pesquero." .
              <https://orca-graph.example/resource/link-intermediary>
                a <{ORCA}ValueChainLink> ;
                <{ORCA}name> "Intermediario" ;
                <{ORCA}description> "Intermediación entre comercialización y destinos finales." .
              <https://orca-graph.example/resource/link-final-consumer>
                a <{ORCA}ValueChainLink> ;
                <{ORCA}name> "ConsumidorFinal" ;
                <{ORCA}description> "Consumo final del producto pesquero." .
              <https://orca-graph.example/resource/link-transformation>
                a <{ORCA}ValueChainLink> ;
                <{ORCA}name> "Transformacion" ;
                <{ORCA}description> "Procesado y transformación del producto pesquero." .
              <https://orca-graph.example/resource/link-hospitality>
                a <{ORCA}ValueChainLink> ;
                <{ORCA}name> "Hosteleria" ;
                <{ORCA}description> "Canal hostelero vinculado al producto pesquero." .

              <https://orca-graph.example/resource/value-chain-angola-fishing>
                <{ORCA}hasValueChainLink>
                    <https://orca-graph.example/resource/link-primary-sector>,
                    <https://orca-graph.example/resource/link-marketer>,
                    <https://orca-graph.example/resource/link-intermediary>,
                    <https://orca-graph.example/resource/link-final-consumer>,
                    <https://orca-graph.example/resource/link-transformation>,
                    <https://orca-graph.example/resource/link-hospitality> .

              <https://orca-graph.example/resource/link-primary-sector>
                <{ORCA}precedes> <https://orca-graph.example/resource/link-marketer> .
              <https://orca-graph.example/resource/link-marketer>
                <{ORCA}precedes>
                    <https://orca-graph.example/resource/link-intermediary>,
                    <https://orca-graph.example/resource/link-final-consumer>,
                    <https://orca-graph.example/resource/link-transformation> .
              <https://orca-graph.example/resource/link-intermediary>
                <{ORCA}precedes>
                    <https://orca-graph.example/resource/link-final-consumer>,
                    <https://orca-graph.example/resource/link-transformation> .
              <https://orca-graph.example/resource/link-transformation>
                <{ORCA}precedes> <https://orca-graph.example/resource/link-final-consumer> .
              <https://orca-graph.example/resource/link-hospitality>
                <{ORCA}precedes> <https://orca-graph.example/resource/link-transformation> .
            }} }}
            """
        )
        await self.seed_user_examples(users)


graphdb = GraphDB()
