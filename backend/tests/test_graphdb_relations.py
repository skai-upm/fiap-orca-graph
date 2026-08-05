import pytest

from app.domain import (
    OM,
    NodeType,
    RelationType,
    SupportAgentSubtype,
    UserPublic,
)
from app.graphdb import GraphDB


def test_component_kpi_relation_serializes_both_directions():
    triples = GraphDB.relation_triples(
        "https://example.org/component",
        "https://example.org/kpi",
        RelationType.HAS_KPI,
    )
    joined = " ".join(triples)
    assert "<https://example.org/component>" in joined
    assert "<https://orca-graph.example/ontology/hasKPI>" in joined
    assert "<https://orca-graph.example/ontology/appliesToComponent>" in joined


@pytest.mark.asyncio
async def test_kpi_created_for_component_uses_kpi_to_component_direction(monkeypatch):
    captured = {}

    async def fake_update(sparql):
        captured["sparql"] = sparql

    client = GraphDB()
    monkeypatch.setattr(client, "update", fake_update)
    await client.create_node(
        graph_uri="https://example.org/graph",
        node_id="https://example.org/kpi",
        node_type=NodeType.KPI,
        name="KPI",
        description="",
        identification="KPI-01",
        evaluation="Evaluation",
        unit_iri=f"{OM}percent",
        parent_id="https://example.org/component",
        relation=RelationType.APPLIES_TO_COMPONENT,
    )

    sparql = captured["sparql"]
    assert (
        "<https://example.org/kpi> "
        "<https://orca-graph.example/ontology/appliesToComponent> "
        "<https://example.org/component>"
    ) in sparql
    assert (
        "<https://example.org/component> "
        "<https://orca-graph.example/ontology/hasKPI> "
        "<https://example.org/kpi>"
    ) in sparql


@pytest.mark.asyncio
async def test_support_agent_is_typed_as_base_class_and_selected_subclass(monkeypatch):
    captured = {}

    async def fake_update(sparql):
        captured["sparql"] = sparql

    client = GraphDB()
    monkeypatch.setattr(client, "update", fake_update)
    await client.create_node(
        graph_uri="https://example.org/graph",
        node_id="https://example.org/support-agent",
        node_type=NodeType.SUPPORT_AGENT,
        name="Research centre",
        description="",
        identification=None,
        evaluation=None,
        unit_iri=None,
        parent_id="https://example.org/link",
        relation=RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK,
        support_agent_subtype=SupportAgentSubtype.RESEARCH,
    )

    assert (
        "a <https://orca-graph.example/ontology/SupportAgent>, "
        "<https://orca-graph.example/ontology/ResearchSupportAgent>"
    ) in captured["sparql"]


@pytest.mark.asyncio
async def test_new_node_persists_active_value_chain_workspace(monkeypatch):
    captured = {}

    async def fake_update(sparql):
        captured["sparql"] = sparql

    client = GraphDB()
    monkeypatch.setattr(client, "update", fake_update)
    await client.create_node(
        graph_uri="https://example.org/graph",
        node_id="https://example.org/component",
        node_type=NodeType.COMPONENT,
        name="Component",
        description="Description",
        identification=None,
        evaluation=None,
        unit_iri=None,
        parent_id=None,
        relation=None,
        chain_id="https://example.org/value-chain",
    )

    assert (
        "<https://orca-graph.example/ontology/inValueChain> "
        "<https://example.org/value-chain>"
    ) in captured["sparql"]


@pytest.mark.asyncio
async def test_duplicate_value_chain_remaps_every_application_resource(monkeypatch):
    source_chain = "https://example.org/chain/source"
    source_component = "https://example.org/component/source"
    captured = {}

    async def fake_query(_sparql):
        return {
            "results": {
                "bindings": [
                    {
                        "subject": {"type": "uri", "value": source_chain},
                        "predicate": {"type": "uri", "value": "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"},
                        "object": {"type": "uri", "value": "https://orca-graph.example/ontology/ValueChain"},
                    },
                    {
                        "subject": {"type": "uri", "value": source_chain},
                        "predicate": {"type": "uri", "value": "https://orca-graph.example/ontology/name"},
                        "object": {"type": "literal", "value": "Original"},
                    },
                    {
                        "subject": {"type": "uri", "value": source_chain},
                        "predicate": {"type": "uri", "value": "https://orca-graph.example/ontology/hasComponent"},
                        "object": {"type": "uri", "value": source_component},
                    },
                    {
                        "subject": {"type": "uri", "value": source_component},
                        "predicate": {"type": "uri", "value": "https://orca-graph.example/ontology/name"},
                        "object": {"type": "literal", "value": "Componente"},
                    },
                    {
                        "subject": {"type": "uri", "value": source_component},
                        "predicate": {"type": "uri", "value": "https://orca-graph.example/ontology/inValueChain"},
                        "object": {"type": "uri", "value": source_chain},
                    },
                ]
            }
        }

    async def fake_update(sparql):
        captured["sparql"] = sparql

    client = GraphDB()
    monkeypatch.setattr(client, "query", fake_query)
    monkeypatch.setattr(client, "update", fake_update)
    new_chain = await client.duplicate_value_chain(
        graph_uri="https://example.org/graph/user",
        source_chain_id=source_chain,
        node_ids={source_chain, source_component},
        new_name="Copia independiente",
    )

    inserted = captured["sparql"]
    assert '"Copia independiente"' in inserted
    assert source_chain not in inserted
    assert source_component not in inserted
    assert new_chain in inserted
    assert inserted.count("https://orca-graph.example/resource/") >= 2


@pytest.mark.asyncio
async def test_value_chain_name_uniqueness_is_case_insensitive(monkeypatch):
    captured = {}

    async def fake_query(sparql):
        captured["sparql"] = sparql
        return {"boolean": True}

    client = GraphDB()
    monkeypatch.setattr(client, "query", fake_query)

    assert await client.value_chain_name_exists("  Cadena Azul  ") is True
    assert "LCASE" in captured["sparql"]
    assert '"Cadena Azul"' in captured["sparql"]


@pytest.mark.asyncio
async def test_node_deletion_cascades_relations_across_named_graphs(monkeypatch):
    updates = []

    async def fake_update(sparql):
        updates.append(sparql)

    client = GraphDB()
    monkeypatch.setattr(client, "update", fake_update)

    await client.delete_node(
        "https://example.org/graph/owner",
        "https://example.org/node",
    )

    assert len(updates) == 2
    assert "DELETE WHERE" in updates[0]
    assert "GRAPH ?graph" in updates[1]
    assert "FILTER(?outRelation IN" in updates[1]
    assert "FILTER(?inRelation IN" in updates[1]


@pytest.mark.asyncio
async def test_user_graph_deletion_removes_foreign_references_then_clears(monkeypatch):
    updates = []

    async def fake_update(sparql):
        updates.append(sparql)

    client = GraphDB()
    monkeypatch.setattr(client, "update", fake_update)

    await client.delete_graph("https://example.org/graph/user")

    assert len(updates) == 2
    assert "GRAPH ?relationGraph" in updates[0]
    assert updates[1] == "CLEAR GRAPH <https://example.org/graph/user>"


@pytest.mark.asyncio
async def test_versioned_example_graph_has_contributions_from_each_user(monkeypatch):
    updates = []

    async def fake_query(_sparql):
        return {"boolean": False}

    async def fake_update(sparql):
        updates.append(sparql)

    users = [
        UserPublic(
            id=user_id,
            username=username,
            display_name=display_name,
            initials=initials,
            role=role,
            graph_uri=f"https://example.org/graph/{username}",
        )
        for user_id, username, display_name, initials, role in [
            ("user-orca", "orca", "ORCA", "OR", "admin"),
            ("user-andrea", "andrea", "Andrea Cimmino", "AC", "normal"),
            ("user-maria", "maria", "María Pérez", "MP", "normal"),
        ]
    ]
    client = GraphDB()
    monkeypatch.setattr(client, "query", fake_query)
    monkeypatch.setattr(client, "update", fake_update)

    await client.seed_user_examples(users)

    joined = "\n".join(updates)
    assert "GRAPH <https://example.org/graph/orca>" in joined
    assert "GRAPH <https://example.org/graph/andrea>" in joined
    assert "GRAPH <https://example.org/graph/maria>" in joined
    assert "value-chain-circular-pilot" in joined
    assert "component-energy" in joined
    assert "kpi-delivery" in joined
    assert "system/seed/7.0.0" in joined
