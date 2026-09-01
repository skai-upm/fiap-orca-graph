import asyncio
import re
import unicodedata
from uuid import uuid4

import httpx
from rdflib import Graph, Literal, URIRef
from rdflib.namespace import OWL, RDF, RDFS, XSD

from .config import settings
from .domain import (
    INVERSE_RELATIONS,
    NEW_NODE_SOURCE_RELATIONS,
    OM,
    ORCA,
    GraphSnapshot,
    Node,
    NodeType,
    Relation,
    RelationType,
    SupportAgentSubtype,
    UnitOption,
    OntologyConcept,
    UserPublic,
    role_can_manage_node_type,
)


def sparql_iri(value: str) -> str:
    if not value.startswith(("http://", "https://")) or any(ch in value for ch in '<>"{}|\\^`'):
        raise ValueError("Invalid IRI")
    return f"<{value}>"


def sparql_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


class GraphDB:
    def __init__(self) -> None:
        self._ontology_lock = asyncio.Lock()

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

    async def migrate_kpi_text_fields(self) -> None:
        """Migrate legacy KPI text fields and initialise code and evaluation."""
        await self.update(
            f"""
            INSERT {{ GRAPH ?graph {{ ?kpi {sparql_iri(f'{ORCA}description')} ?definition }} }}
            WHERE {{
              GRAPH ?graph {{
                ?kpi a {sparql_iri(f'{ORCA}KPI')} ;
                     {sparql_iri(f'{ORCA}definition')} ?definition .
                FILTER NOT EXISTS {{ ?kpi {sparql_iri(f'{ORCA}description')} ?existingDescription }}
              }}
            }}
            """
        )
        await self.update(
            f"""
            DELETE {{ GRAPH ?graph {{ ?kpi {sparql_iri(f'{ORCA}definition')} ?definition }} }}
            WHERE {{
              GRAPH ?graph {{
                ?kpi a {sparql_iri(f'{ORCA}KPI')} ;
                     {sparql_iri(f'{ORCA}definition')} ?definition .
              }}
            }}
            """
        )
        await self.update(
            f"""
            INSERT {{ GRAPH ?graph {{ ?kpi {sparql_iri(f'{ORCA}code')} ?identification }} }}
            WHERE {{
              GRAPH ?graph {{
                ?kpi a {sparql_iri(f'{ORCA}KPI')} ;
                     {sparql_iri(f'{ORCA}identification')} ?identification .
              }}
              FILTER NOT EXISTS {{ GRAPH ?graph {{ ?kpi {sparql_iri(f'{ORCA}code')} ?existingCode }} }}
            }}
            """
        )
        await self.update(
            f"""
            DELETE {{ GRAPH ?graph {{ ?kpi {sparql_iri(f'{ORCA}identification')} ?identification }} }}
            WHERE {{ GRAPH ?graph {{ ?kpi a {sparql_iri(f'{ORCA}KPI')} ; {sparql_iri(f'{ORCA}identification')} ?identification }} }}
            """
        )
        for property_name in ("code", "evaluation"):
            await self.update(
                f"""
                INSERT {{ GRAPH ?graph {{ ?kpi {sparql_iri(f'{ORCA}{property_name}')} "" }} }}
                WHERE {{
                  GRAPH ?graph {{ ?kpi a {sparql_iri(f'{ORCA}KPI')} }}
                  FILTER NOT EXISTS {{
                    GRAPH ?graph {{ ?kpi {sparql_iri(f'{ORCA}{property_name}')} ?value }}
                  }}
                }}
                """
            )

    async def migrate_component_levels(self) -> None:
        """Convert the former Component-to-Component hierarchy into three explicit levels."""
        component = sparql_iri(f"{ORCA}Component")
        subcomponent = sparql_iri(f"{ORCA}Subcomponent")
        element = sparql_iri(f"{ORCA}Element")
        has_component = sparql_iri(f"{ORCA}hasComponent")
        has_subcomponent = sparql_iri(f"{ORCA}hasSubcomponent")
        old_inverse = sparql_iri(f"{ORCA}hasSupercomponent")
        is_subcomponent_of = sparql_iri(f"{ORCA}isSubcomponentOf")
        has_element = sparql_iri(f"{ORCA}hasElement")
        is_element_of = sparql_iri(f"{ORCA}isElementOf")
        await self.update(f"""
            DELETE {{ GRAPH ?typeGraph {{ ?child a {component} }} }}
            INSERT {{ GRAPH ?typeGraph {{ ?child a {subcomponent} }} }}
            WHERE {{
              GRAPH ?graph {{ ?parent {has_subcomponent} ?child }}
              GRAPH ?typeGraph {{ ?child a {component} }}
              FILTER(
                EXISTS {{ GRAPH ?anchorGraph {{ ?scope {has_component} ?parent }} }} ||
                NOT EXISTS {{ GRAPH ?ancestorGraph {{ ?ancestor {has_subcomponent} ?parent }} }}
              )
              FILTER NOT EXISTS {{ GRAPH ?scopeGraph {{ ?scope {has_component} ?child }} }}
            }}
        """)
        await self.update(f"""
            DELETE {{ GRAPH ?typeGraph {{ ?child a {component} . ?child a {subcomponent} }} }}
            INSERT {{ GRAPH ?typeGraph {{ ?child a {element} }} }}
            WHERE {{
              GRAPH ?graph {{ ?parent {has_subcomponent} ?child }}
              GRAPH ?parentGraph {{ ?parent a {subcomponent} }}
              GRAPH ?typeGraph {{ ?child a ?oldType . FILTER(?oldType IN ({component}, {subcomponent})) }}
            }}
        """)
        await self.update(f"""
            DELETE {{ GRAPH ?graph {{ ?parent {has_subcomponent} ?child . ?child {old_inverse} ?parent }} }}
            INSERT {{ GRAPH ?graph {{ ?parent {has_element} ?child . ?child {is_element_of} ?parent }} }}
            WHERE {{
              GRAPH ?graph {{ ?parent {has_subcomponent} ?child }}
              GRAPH ?parentGraph {{ ?parent a {subcomponent} }}
              GRAPH ?childGraph {{ ?child a {element} }}
            }}
        """)
        await self.update(f"""
            DELETE {{ GRAPH ?graph {{ ?child {old_inverse} ?parent }} }}
            INSERT {{ GRAPH ?graph {{ ?child {is_subcomponent_of} ?parent }} }}
            WHERE {{
              GRAPH ?graph {{ ?parent {has_subcomponent} ?child }}
              GRAPH ?parentGraph {{ ?parent a {component} }}
              GRAPH ?childGraph {{ ?child a {subcomponent} }}
              OPTIONAL {{ GRAPH ?graph {{ ?child {old_inverse} ?parent }} }}
            }}
        """)
        await self.update(f"""
            DELETE {{ GRAPH ?graph {{ ?child {old_inverse} ?parent }} }}
            WHERE {{ GRAPH ?graph {{ ?child {old_inverse} ?parent }} }}
        """)

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

    async def units(self) -> list[UnitOption]:
        result = await self.query(
            f"""
            SELECT ?unit
                   (SAMPLE(?preferredLabel) AS ?label)
                   (SAMPLE(?unitSymbol) AS ?symbol)
            WHERE {{
              GRAPH {sparql_iri(settings.om_graph_uri)} {{
                ?unit a ?unitClass .
                ?unitClass <http://www.w3.org/2000/01/rdf-schema#subClassOf>*
                  {sparql_iri(f"{OM}Unit")} .
                OPTIONAL {{
                  ?unit <http://www.w3.org/2000/01/rdf-schema#label> ?preferredLabel .
                  FILTER(LANG(?preferredLabel) = "en" || LANG(?preferredLabel) = "" ||
                         LANG(?preferredLabel) = "es")
                }}
                OPTIONAL {{ ?unit {sparql_iri(f"{OM}symbol")} ?unitSymbol }}
              }}
            }}
            GROUP BY ?unit
            ORDER BY LCASE(STR(COALESCE(?label, ?unit)))
            """
        )
        options: list[UnitOption] = []
        for row in result.get("results", {}).get("bindings", []):
            iri = row["unit"]["value"]
            label = row.get("label", {}).get("value") or iri.rsplit("/", 1)[-1]
            symbol = row.get("symbol", {}).get("value", "")
            options.append(UnitOption(iri=iri, label=label, symbol=symbol))
        return options

    async def unit_label(self, unit_iri: str | None) -> str | None:
        if not unit_iri:
            return None
        for unit in await self.units():
            if unit.iri == unit_iri:
                return f"{unit.label} ({unit.symbol})" if unit.symbol else unit.label
        return unit_iri.rsplit("/", 1)[-1]

    @staticmethod
    def _spanish_literal(graph: Graph, subject: URIRef, predicate: URIRef) -> str:
        values = list(graph.objects(subject, predicate))
        preferred = next((value for value in values if isinstance(value, Literal) and value.language == "es"), None)
        fallback = next((value for value in values if isinstance(value, Literal) and not value.language), None)
        return str(preferred or fallback or (values[0] if values else ""))

    def _read_ontology(self) -> Graph:
        ontology = Graph()
        ontology.parse(settings.ontology_path, format="turtle")
        return ontology

    async def concepts(self, include_hidden: bool = False) -> list[OntologyConcept]:
        ontology = self._read_ontology()
        concepts = []
        for subject in ontology.subjects(RDF.type, OWL.Class):
            if not isinstance(subject, URIRef):
                continue
            visibility = next(ontology.objects(subject, URIRef(f"{ORCA}visibleToUsers")), None)
            visible = visibility is None or bool(visibility.toPython())
            core = next(ontology.objects(subject, URIRef(f"{ORCA}coreConcept")), None)
            if not include_hidden and not visible:
                continue
            concepts.append(OntologyConcept(
                iri=str(subject),
                label=self._spanish_literal(ontology, subject, RDFS.label) or str(subject).rsplit("/", 1)[-1],
                definition=self._spanish_literal(ontology, subject, RDFS.comment),
                visible=visible,
                deletable=True,
            ))
        return sorted(concepts, key=lambda item: item.label.casefold())

    @staticmethod
    def _concept_local_name(label: str) -> str:
        normalized = unicodedata.normalize("NFKD", label)
        ascii_label = "".join(character for character in normalized if not unicodedata.combining(character))
        words = re.findall(r"[A-Za-z0-9]+", ascii_label)
        local_name = "".join(word[:1].upper() + word[1:] for word in words)
        if not local_name:
            raise ValueError("No se puede generar una IRI a partir de la etiqueta")
        if local_name[0].isdigit():
            local_name = f"Concept{local_name}"
        return local_name

    async def save_concept(self, label: str, definition: str, concept_iri: str | None = None) -> OntologyConcept:
        async with self._ontology_lock:
            ontology = self._read_ontology()
            classes = {subject for subject in ontology.subjects(RDF.type, OWL.Class) if isinstance(subject, URIRef)}
            if concept_iri is None:
                existing_labels = {
                    str(value).casefold()
                    for subject in classes
                    for value in ontology.objects(subject, RDFS.label)
                }
                if label.casefold() in existing_labels:
                    raise ValueError("Ya existe un concepto con esa etiqueta")
                local_name = self._concept_local_name(label)
                subject = URIRef(f"{ORCA}{local_name}")
                suffix = 2
                while subject in classes:
                    subject = URIRef(f"{ORCA}{local_name}{suffix}")
                    suffix += 1
                ontology.add((subject, RDF.type, OWL.Class))
            else:
                subject = URIRef(concept_iri)
                if subject not in classes:
                    raise LookupError("Concepto ontológico no encontrado")
            for predicate in (RDFS.label, RDFS.comment):
                for value in list(ontology.objects(subject, predicate)):
                    if isinstance(value, Literal) and value.language == "es":
                        ontology.remove((subject, predicate, value))
            ontology.add((subject, RDFS.label, Literal(label, lang="es")))
            ontology.add((subject, RDFS.comment, Literal(definition, lang="es")))
            serialized = ontology.serialize(format="turtle")
            temporary_path = settings.ontology_path.with_suffix(".ttl.tmp")
            temporary_path.write_text(serialized, encoding="utf-8")
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.put(
                    settings.statements_url,
                    params={"context": f"<{ORCA}ontology>"},
                    content=serialized,
                    headers={"Content-Type": "text/turtle"},
                )
                response.raise_for_status()
            temporary_path.replace(settings.ontology_path)
            visibility = next(ontology.objects(subject, URIRef(f"{ORCA}visibleToUsers")), None)
            visible = visibility is None or bool(visibility.toPython())
            core = next(ontology.objects(subject, URIRef(f"{ORCA}coreConcept")), None)
            return OntologyConcept(
                iri=str(subject), label=label, definition=definition, visible=visible,
                deletable=True,
            )

    async def set_concept_visibility(self, concept_iri: str, visible: bool) -> OntologyConcept:
        async with self._ontology_lock:
            ontology = self._read_ontology()
            subject = URIRef(concept_iri)
            if (subject, RDF.type, OWL.Class) not in ontology:
                raise LookupError("Concepto ontológico no encontrado")
            predicate = URIRef(f"{ORCA}visibleToUsers")
            ontology.remove((subject, predicate, None))
            ontology.add((subject, predicate, Literal(visible, datatype=XSD.boolean)))
            serialized = ontology.serialize(format="turtle")
            temporary_path = settings.ontology_path.with_suffix(".ttl.tmp")
            temporary_path.write_text(serialized, encoding="utf-8")
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.put(
                    settings.statements_url,
                    params={"context": f"<{ORCA}ontology>"},
                    content=serialized,
                    headers={"Content-Type": "text/turtle"},
                )
                response.raise_for_status()
            temporary_path.replace(settings.ontology_path)
            return OntologyConcept(
                iri=concept_iri,
                label=self._spanish_literal(ontology, subject, RDFS.label) or concept_iri.rsplit("/", 1)[-1],
                definition=self._spanish_literal(ontology, subject, RDFS.comment),
                visible=visible,
                deletable=True,
            )

    async def delete_concept(self, concept_iri: str) -> None:
        async with self._ontology_lock:
            ontology = self._read_ontology()
            subject = URIRef(concept_iri)
            if (subject, RDF.type, OWL.Class) not in ontology:
                raise LookupError("Concepto ontológico no encontrado")
            ontology.remove((subject, None, None))
            ontology.remove((None, None, subject))
            serialized = ontology.serialize(format="turtle")
            temporary_path = settings.ontology_path.with_suffix(".ttl.tmp")
            temporary_path.write_text(serialized, encoding="utf-8")
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.put(
                    settings.statements_url,
                    params={"context": f"<{ORCA}ontology>"},
                    content=serialized,
                    headers={"Content-Type": "text/turtle"},
                )
                response.raise_for_status()
            temporary_path.replace(settings.ontology_path)

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
                FILTER(?type != {sparql_iri(f'{ORCA}Component')} || NOT EXISTS {{ {sparql_iri(node_id)} a ?specificType . FILTER(?specificType IN ({sparql_iri(f'{ORCA}Subcomponent')}, {sparql_iri(f'{ORCA}Element')})) }})
                FILTER(?type != {sparql_iri(f'{ORCA}Subcomponent')} || NOT EXISTS {{ {sparql_iri(node_id)} a {sparql_iri(f'{ORCA}Element')} }})
              }}
            }} LIMIT 1
            """
        )
        bindings = result["results"]["bindings"]
        if not bindings:
            return None
        row = bindings[0]
        return row["graph"]["value"], NodeType(row["type"]["value"].removeprefix(ORCA))

    async def node_chain_id(self, node_id: str) -> str | None:
        result = await self.query(
            f"""
            SELECT ?chain WHERE {{
              GRAPH ?graph {{
                {sparql_iri(node_id)} {sparql_iri(f"{ORCA}inValueChain")} ?chain .
              }}
            }} LIMIT 1
            """
        )
        bindings = result.get("results", {}).get("bindings", [])
        return bindings[0]["chain"]["value"] if bindings else None

    async def source_relation_types(self, node_id: str) -> set[RelationType]:
        result = await self.query(
            f"""
            SELECT DISTINCT ?predicate WHERE {{
              GRAPH ?graph {{ {sparql_iri(node_id)} ?predicate ?target . }}
              FILTER(?predicate IN (
                {sparql_iri(RelationType.APPLIES_TO_AGENT.iri)},
                {sparql_iri(RelationType.APPLIES_TO_COMPONENT.iri)}
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
        code: str | None,
        evaluation: str | None,
        unit_iri: str | None,
        parent_id: str | None,
        relation: RelationType | None,
        support_agent_subtype: SupportAgentSubtype | None = None,
        chain_id: str | None = None,
    ) -> None:
        properties = [f"{sparql_iri(f'{ORCA}name')} {sparql_string(name)}"]
        if description:
            properties.append(
                f"{sparql_iri(f'{ORCA}description')} {sparql_string(description)}"
            )
        if code:
            properties.append(
                f"{sparql_iri(f'{ORCA}code')} {sparql_string(code)}"
            )
        if evaluation:
            properties.append(
                f"{sparql_iri(f'{ORCA}evaluation')} {sparql_string(evaluation)}"
            )
        if unit_iri:
            properties.append(
                f"{sparql_iri(f'{ORCA}unitOfMeasure')} {sparql_iri(unit_iri)}"
            )
        if chain_id:
            properties.append(
                f"{sparql_iri(f'{ORCA}inValueChain')} {sparql_iri(chain_id)}"
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

    async def value_chain_for_link(self, link_id: str) -> str | None:
        result = await self.query(
            f"""
            SELECT DISTINCT ?chain WHERE {{
              GRAPH ?graph {{
                {{
                  ?chain {sparql_iri(RelationType.HAS_VALUE_CHAIN_LINK.iri)}
                  {sparql_iri(link_id)} .
                }}
                UNION
                {{
                  {sparql_iri(link_id)}
                  {sparql_iri(RelationType.IS_VALUE_CHAIN_LINK_OF.iri)} ?chain .
                }}
              }}
            }}
            LIMIT 1
            """
        )
        bindings = result.get("results", {}).get("bindings", [])
        return bindings[0]["chain"]["value"] if bindings else None

    async def value_chain_name_exists(self, name: str) -> bool:
        result = await self.query(
            f"""
            ASK {{
              GRAPH ?graph {{
                ?chain a {sparql_iri(f'{ORCA}ValueChain')} ;
                       {sparql_iri(f'{ORCA}name')} ?name .
                FILTER(LCASE(STR(?name)) = LCASE({sparql_string(name.strip())}))
              }}
            }}
            """
        )
        return bool(result.get("boolean"))

    @staticmethod
    def _binding_term(binding: dict) -> str:
        if binding["type"] == "uri":
            return sparql_iri(binding["value"])
        if binding["type"] in {"literal", "typed-literal"}:
            term = sparql_string(binding["value"])
            language = binding.get("xml:lang")
            datatype = binding.get("datatype")
            if language:
                return f"{term}@{language}"
            if datatype:
                return f"{term}^^{sparql_iri(datatype)}"
            return term
        raise ValueError("Unsupported RDF term while duplicating a value chain")

    async def duplicate_value_chain(
        self,
        graph_uri: str,
        source_chain_id: str,
        node_ids: set[str],
        new_name: str,
    ) -> str:
        """Copy a complete value-chain workspace into the requesting user's graph."""
        if source_chain_id not in node_ids:
            raise ValueError("The source value chain is not part of its workspace")
        values = " ".join(sparql_iri(node_id) for node_id in sorted(node_ids))
        result = await self.query(
            f"""
            SELECT ?subject ?predicate ?object WHERE {{
              VALUES ?subject {{ {values} }}
              GRAPH ?sourceGraph {{ ?subject ?predicate ?object }}
            }}
            """
        )
        mapping = {
            node_id: f"https://orca-graph.example/resource/{uuid4()}"
            for node_id in node_ids
        }
        new_chain_id = mapping[source_chain_id]
        triples: list[str] = []
        for row in result.get("results", {}).get("bindings", []):
            old_subject = row["subject"]["value"]
            predicate = row["predicate"]["value"]
            if predicate == f"{ORCA}name" and old_subject == source_chain_id:
                object_term = sparql_string(new_name)
            elif predicate == f"{ORCA}inValueChain":
                object_term = sparql_iri(new_chain_id)
            else:
                object_binding = row["object"]
                object_term = (
                    sparql_iri(mapping[object_binding["value"]])
                    if object_binding.get("type") == "uri"
                    and object_binding["value"] in mapping
                    else self._binding_term(object_binding)
                )
            triples.append(
                f"{sparql_iri(mapping[old_subject])} "
                f"{sparql_iri(predicate)} {object_term} ."
            )
        # Older workspaces may lack explicit scoping. Make every copied resource
        # unambiguously part of the new chain without changing its other values.
        for old_id, new_id in mapping.items():
            if old_id != source_chain_id:
                triples.append(
                    f"{sparql_iri(new_id)} {sparql_iri(f'{ORCA}inValueChain')} "
                    f"{sparql_iri(new_chain_id)} ."
                )
        if not triples:
            raise LookupError("The value chain has no RDF content to duplicate")
        await self.update(
            f"INSERT DATA {{ GRAPH {sparql_iri(graph_uri)} {{ {' '.join(triples)} }} }}"
        )
        return new_chain_id

    async def update_node(
        self,
        graph_uri: str,
        node_id: str,
        node_type: NodeType,
        name: str,
        description: str,
        code: str | None,
        evaluation: str | None,
        unit_iri: str | None,
        support_agent_subtype: SupportAgentSubtype | None,
    ) -> None:
        editable_properties = [
            f"{ORCA}name", f"{ORCA}description", f"{ORCA}definition",
            f"{ORCA}identification", f"{ORCA}code", f"{ORCA}evaluation",
            f"{ORCA}hasApplicationLevel", f"{ORCA}applicationScope",
            f"{ORCA}unitOfMeasure",
        ]
        support_types = [
            subtype.iri for subtype in SupportAgentSubtype
            if subtype != SupportAgentSubtype.GENERAL
        ]
        filters = ", ".join(sparql_iri(item) for item in editable_properties)
        type_filters = ", ".join(sparql_iri(item) for item in support_types)
        await self.update(
            f"""
            DELETE {{
              GRAPH {sparql_iri(graph_uri)} {{
                {sparql_iri(node_id)} ?predicate ?value .
                {sparql_iri(node_id)} a ?supportType .
              }}
            }}
            WHERE {{
              GRAPH {sparql_iri(graph_uri)} {{
                OPTIONAL {{
                  {sparql_iri(node_id)} ?predicate ?value .
                  FILTER(?predicate IN ({filters}))
                }}
                OPTIONAL {{
                  {sparql_iri(node_id)} a ?supportType .
                  FILTER(?supportType IN ({type_filters}))
                }}
              }}
            }}
            """
        )
        properties = [f"{sparql_iri(f'{ORCA}name')} {sparql_string(name)}"]
        if description:
            properties.append(f"{sparql_iri(f'{ORCA}description')} {sparql_string(description)}")
        if code:
            properties.append(f"{sparql_iri(f'{ORCA}code')} {sparql_string(code)}")
        if evaluation:
            properties.append(f"{sparql_iri(f'{ORCA}evaluation')} {sparql_string(evaluation)}")
        if unit_iri:
            properties.append(f"{sparql_iri(f'{ORCA}unitOfMeasure')} {sparql_iri(unit_iri)}")
        triples = [f"{sparql_iri(node_id)} " + " ; ".join(properties) + " ."]
        if (
            node_type == NodeType.SUPPORT_AGENT
            and support_agent_subtype
            and support_agent_subtype != SupportAgentSubtype.GENERAL
        ):
            triples.append(f"{sparql_iri(node_id)} a {sparql_iri(support_agent_subtype.iri)} .")
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
        delegated_node_ids: set[str] | None = None,
        current_user_role: str | None = None,
    ) -> GraphSnapshot:
        delegated_node_ids = delegated_node_ids or set()
        user_by_graph = {user.graph_uri: user for user in users}
        node_result = await self.query(
            f"""
            SELECT ?graph ?id ?type ?name ?description ?code ?evaluation
                   ?supportAgentSubtype ?chain
            WHERE {{
              GRAPH ?graph {{
                ?id a ?type ; {sparql_iri(f"{ORCA}name")} ?name .
                FILTER(?type IN ({self.node_type_iris()}))
                FILTER(?type != {sparql_iri(f'{ORCA}Component')} || NOT EXISTS {{ ?id a ?specificType . FILTER(?specificType IN ({sparql_iri(f'{ORCA}Subcomponent')}, {sparql_iri(f'{ORCA}Element')})) }})
                FILTER(?type != {sparql_iri(f'{ORCA}Subcomponent')} || NOT EXISTS {{ ?id a {sparql_iri(f'{ORCA}Element')} }})
                OPTIONAL {{ ?id {sparql_iri(f"{ORCA}description")} ?description }}
                OPTIONAL {{ ?id {sparql_iri(f"{ORCA}code")} ?code }}
                OPTIONAL {{ ?id {sparql_iri(f"{ORCA}evaluation")} ?evaluation }}
                OPTIONAL {{ ?id {sparql_iri(f"{ORCA}inValueChain")} ?chain }}
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
        nodes: list[Node] = []
        seen_ids: set[str] = set()
        for row in node_result["results"]["bindings"]:
            node_id = row["id"]["value"]
            if node_id in seen_ids:
                continue
            seen_ids.add(node_id)
            graph_uri = row["graph"]["value"]
            owner = user_by_graph.get(graph_uri)
            nodes.append(
                Node(
                    id=node_id,
                    type=NodeType(row["type"]["value"].removeprefix(ORCA)),
                    name=row["name"]["value"],
                    description=row.get("description", {}).get("value", ""),
                    code=row.get("code", {}).get("value"),
                    evaluation=row.get("evaluation", {}).get("value"),
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
                    editable=(owner is not None and owner.id == current_user_id) or (
                        (
                            row["id"]["value"] in delegated_node_ids
                            or row.get("chain", {}).get("value") in delegated_node_ids
                        )
                        and role_can_manage_node_type(
                            current_user_role or "",
                            NodeType(row["type"]["value"].removeprefix(ORCA)),
                        )
                    ),
                    chain_id=row.get("chain", {}).get("value"),
                )
            )
        node_ids = {node.id for node in nodes}
        visible_relation_types = {
            RelationType.HAS_COMPONENT,
            RelationType.HAS_SUBCOMPONENT,
            RelationType.HAS_ELEMENT,
            RelationType.SIMILAR_TO,
            RelationType.HAS_VALUE_CHAIN_LINK,
            RelationType.BELONGS_TO,
            RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK,
            RelationType.APPLIES_TO_AGENT,
            RelationType.HAS_KPI,
            RelationType.HAS_ASSOCIATED_KPI,
            RelationType.IS_RELATED,
            RelationType.MOVES_FRESH_FISH,
            RelationType.MOVES_DRY_FISH,
            RelationType.MOVES_FISHMEAL,
            RelationType.TRANSFERS_FUNDING,
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
        relation_rows = relation_result["results"]["bindings"]
        specific_link_predicates = {
            RelationType.MOVES_FRESH_FISH.iri,
            RelationType.MOVES_DRY_FISH.iri,
            RelationType.MOVES_FISHMEAL.iri,
            RelationType.TRANSFERS_FUNDING.iri,
        }
        specifically_related_pairs = {
            frozenset((row["source"]["value"], row["target"]["value"]))
            for row in relation_rows
            if row["predicate"]["value"] in specific_link_predicates
        }
        for row in relation_rows:
            source = row["source"]["value"]
            target = row["target"]["value"]
            predicate = row["predicate"]["value"]
            if (
                predicate == RelationType.IS_RELATED.iri
                and frozenset((source, target)) in specifically_related_pairs
            ):
                # Older inference indexes may still expose the former
                # subproperty entailment until GraphDB refreshes its rules.
                # Never display that generic duplicate beside the explicit
                # relation chosen in the value-chain-link form.
                continue
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
        seed_marker = "https://orca-graph.example/system/seed/7.0.0"
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
                <https://orca-graph.example/resource/link-resource-recovery>,
                <https://orca-graph.example/resource/link-primary-sector>,
                <https://orca-graph.example/resource/link-marketer> .
              <https://orca-graph.example/resource/link-resource-recovery>
                a <{ORCA}ValueChainLink> ;
                <{ORCA}name> "Resource recovery" ;
                <{ORCA}description> "Recovery and reuse of fishing by-products." ;
                <{ORCA}isValueChainLinkOf>
                <https://orca-graph.example/resource/value-chain-circular-pilot> .
              <https://orca-graph.example/resource/link-primary-sector>
                a <{ORCA}ValueChainLink> ;
                <{ORCA}name> "Primary sector" ;
                <{ORCA}description> "Primary extraction and production." ;
                <{ORCA}isValueChainLinkOf>
                <https://orca-graph.example/resource/value-chain-circular-pilot> ;
                <{ORCA}muevePescadoFresco>
                <https://orca-graph.example/resource/link-marketer> .
              <https://orca-graph.example/resource/link-marketer>
                a <{ORCA}ValueChainLink> ;
                <{ORCA}name> "Marketer" ;
                <{ORCA}description> "Marketing and initial distribution." ;
                <{ORCA}isValueChainLinkOf>
                <https://orca-graph.example/resource/value-chain-circular-pilot> .
            """,
            "user-andrea": f"""
              <https://orca-graph.example/resource/scope-sustainability>
                a <{ORCA}Scope> ;
                <{ORCA}name> "Sustainability" ;
                <{ORCA}description> "Sustainability scope created by Andrea." ;
                <{ORCA}hasComponent>
                <https://orca-graph.example/resource/component-energy> .
              <https://orca-graph.example/resource/component-energy> a <{ORCA}Component> ;
                <{ORCA}name> "Energy" ;
                <{ORCA}description> "Energy use and efficiency." ;
                <{ORCA}isComponentOf>
                <https://orca-graph.example/resource/scope-sustainability> .
              <https://orca-graph.example/resource/scope-sustainability>
                <{ORCA}hasComponent>
                <https://orca-graph.example/resource/component-energy> .
              <https://orca-graph.example/resource/agent-fishing-cooperative> a <{ORCA}PrincipalAgent> ;
                <{ORCA}name> "Angolan fishing cooperative" ;
                <{ORCA}belongsTo>
                <https://orca-graph.example/resource/link-primary-sector> .
              <https://orca-graph.example/resource/kpi-energy> a <{ORCA}KPI> ;
                <{ORCA}name> "Energy consumption" ;
                <{ORCA}definition> "Total energy consumed during production." ;
                <{ORCA}unitOfMeasure>
                <http://www.ontology-of-units-of-measure.org/resource/om-2/kilowattHour> ;
                <{ORCA}appliesToComponent>
                <https://orca-graph.example/resource/component-energy> .
            """,
            "user-maria": f"""
              <https://orca-graph.example/resource/agent-logistics> a <{ORCA}AuxiliaryAgent> ;
                <{ORCA}name> "Logistics provider" ;
                <{ORCA}participatesInValueChainLink>
                <https://orca-graph.example/resource/link-marketer> .
              <https://orca-graph.example/resource/kpi-delivery> a <{ORCA}KPI> ;
                <{ORCA}name> "On-time delivery" ;
                <{ORCA}definition> "Share of deliveries completed on time." ;
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
        # Remove unit assertions left by installations created before v7.22.0.
        await self.update(
            f"DELETE WHERE {{ GRAPH ?graph {{ ?kpi {sparql_iri(f'{ORCA}unitOfMeasure')} ?unit }} }}"
        )
        # Remove KPI properties retired in v7.10.0 from all user graphs.
        await self.update(
            f"""
            DELETE {{ GRAPH ?graph {{ ?kpi ?predicate ?value }} }}
            WHERE {{
              GRAPH ?graph {{
                ?kpi a {sparql_iri(f"{ORCA}KPI")} ;
                     ?predicate ?value .
                FILTER(?predicate IN (
                  {sparql_iri(f"{ORCA}hasApplicationLevel")},
                  {sparql_iri(f"{ORCA}applicationScope")}
                ))
              }}
            }}
            """
        )
        # Versions before 7.5.0 inserted application entities into a global
        # graph with no user owner. Remove that known legacy graph during the
        # upgrade; all current seed entities live in a real user's named graph.
        await self.update(
            f"CLEAR SILENT GRAPH {sparql_iri(settings.global_graph_uri)}"
        )
        # Migrate the relations retired in v7.21.0. KPI-to-link assertions are
        # removed; legacy ordering is preserved as the new general relation.
        await self.update(
            f"""
            DELETE {{ GRAPH ?graph {{ ?kpi {sparql_iri(f'{ORCA}appliesToValueChainLink')} ?link }} }}
            WHERE  {{ GRAPH ?graph {{ ?kpi {sparql_iri(f'{ORCA}appliesToValueChainLink')} ?link }} }} ;
            DELETE {{ GRAPH ?graph {{ ?left {sparql_iri(f'{ORCA}precedes')} ?right }} }}
            INSERT {{ GRAPH ?graph {{ ?left {sparql_iri(RelationType.IS_RELATED.iri)} ?right }} }}
            WHERE  {{ GRAPH ?graph {{ ?left {sparql_iri(f'{ORCA}precedes')} ?right }} }}
            """
        )
        await self.seed_user_examples(users)


graphdb = GraphDB()
