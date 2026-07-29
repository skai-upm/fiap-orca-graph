import pytest

from app.domain import (
    OM,
    ApplicationLevel,
    NodeType,
    RelationType,
    SupportAgentSubtype,
    UserPublic,
)
from app.graphdb import GraphDB


def test_scope_kpi_relation_serializes_both_directions():
    triples = GraphDB.relation_triples(
        "https://example.org/scope",
        "https://example.org/kpi",
        RelationType.HAS_KPI,
    )
    joined = " ".join(triples)
    assert "<https://example.org/scope>" in joined
    assert "<https://orca-graph.example/ontology/hasKPI>" in joined
    assert "<https://orca-graph.example/ontology/appliesToScope>" in joined


@pytest.mark.asyncio
async def test_kpi_created_for_scope_uses_kpi_to_scope_direction(monkeypatch):
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
        definition="Definition",
        application_level=ApplicationLevel.GENERAL,
        application_scope="Angola",
        unit_iri=f"{OM}percent",
        parent_id="https://example.org/scope",
        relation=RelationType.APPLIES_TO_SCOPE,
    )

    sparql = captured["sparql"]
    assert (
        "<https://example.org/kpi> "
        "<https://orca-graph.example/ontology/appliesToScope> "
        "<https://example.org/scope>"
    ) in sparql
    assert (
        "<https://example.org/scope> "
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
        definition=None,
        application_level=None,
        application_scope=None,
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
            ("user-orca", "orca", "ORCA", "OR", "orca"),
            ("user-andrea", "andrea", "Andrea Cimmino", "AC", "editor"),
            ("user-maria", "maria", "María Pérez", "MP", "editor"),
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
    assert "scope-energy" in joined
    assert "kpi-delivery" in joined
    assert "system/seed/6.0.0" in joined
