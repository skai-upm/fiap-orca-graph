import pytest
from pydantic import ValidationError

from app.domain import (
    OM,
    NodeCreate,
    NodeType,
    ParentLink,
    RelationType,
    SupportAgentSubtype,
    UserCreateCommand,
    validate_relation,
)


def test_scope_component_and_component_hierarchy_are_valid():
    validate_relation(NodeType.SCOPE, NodeType.COMPONENT, RelationType.HAS_COMPONENT)
    validate_relation(NodeType.COMPONENT, NodeType.COMPONENT, RelationType.HAS_SUBCOMPONENT)


def test_similarity_cannot_cross_scope_and_kpi():
    with pytest.raises(ValueError):
        validate_relation(NodeType.SCOPE, NodeType.KPI, RelationType.SIMILAR_TO)


def test_value_chain_and_agent_relations():
    validate_relation(
        NodeType.VALUE_CHAIN,
        NodeType.VALUE_CHAIN_LINK,
        RelationType.HAS_VALUE_CHAIN_LINK,
    )
    validate_relation(
        NodeType.PRINCIPAL_AGENT,
        NodeType.VALUE_CHAIN_LINK,
        RelationType.BELONGS_TO,
    )
    validate_relation(
        NodeType.AUXILIARY_AGENT,
        NodeType.VALUE_CHAIN_LINK,
        RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK,
    )


def test_kpi_target_rules():
    validate_relation(
        NodeType.KPI,
        NodeType.COMPONENT,
        RelationType.APPLIES_TO_COMPONENT,
    )
    validate_relation(
        NodeType.COMPONENT,
        NodeType.KPI,
        RelationType.HAS_KPI,
    )
    with pytest.raises(ValueError):
        validate_relation(NodeType.KPI, NodeType.VALUE_CHAIN_LINK, RelationType.APPLIES_TO_AGENT)
    validate_relation(
        NodeType.KPI,
        NodeType.SUPPORT_AGENT,
        RelationType.APPLIES_TO_AGENT,
    )
    validate_relation(
        NodeType.KPI,
        NodeType.PRINCIPAL_AGENT,
        RelationType.APPLIES_TO_AGENT,
    )
    validate_relation(
        NodeType.PRINCIPAL_AGENT,
        NodeType.KPI,
        RelationType.HAS_ASSOCIATED_KPI,
    )


def test_value_chain_links_support_typed_relations():
    for relation in (
        RelationType.MOVES_FRESH_FISH,
        RelationType.MOVES_DRY_FISH,
        RelationType.MOVES_FISHMEAL,
        RelationType.TRANSFERS_FUNDING,
    ):
        validate_relation(NodeType.VALUE_CHAIN_LINK, NodeType.VALUE_CHAIN_LINK, relation)


def test_kpi_requires_identification_description_and_evaluation_but_no_unit():
    with pytest.raises(ValidationError):
        NodeCreate(type=NodeType.KPI, name="Incomplete KPI")
    command = NodeCreate(
        type=NodeType.KPI,
        name="Recycling rate",
        identification="KPI-01",
        description="Share of recycled waste.",
        evaluation="Percentage of recycled waste over total waste.",
    )
    assert command.identification == "KPI-01"
    assert command.description == "Share of recycled waste."
    assert command.evaluation == "Percentage of recycled waste over total waste."
    assert not hasattr(command, "unit_iri")


def test_scope_requires_name_and_description():
    with pytest.raises(ValidationError):
        NodeCreate(type=NodeType.SCOPE, name="Scope", description="")


def test_new_user_password_requires_eight_characters():
    with pytest.raises(ValidationError):
        UserCreateCommand(
            username="newuser",
            display_name="New User",
            password="demo123",
        )
    command = UserCreateCommand(
        username="newuser",
        display_name="New User",
        password="demo1234",
    )
    assert command.password == "demo1234"


def test_support_agent_accepts_controlled_subtype():
    command = NodeCreate(
        type=NodeType.SUPPORT_AGENT,
        name="Regional ministry",
        support_agent_subtype=SupportAgentSubtype.REGIONAL_GOVERNMENT,
        parent=ParentLink(
            parent_id="https://example.org/link",
            relation=RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK,
        ),
    )
    assert command.support_agent_subtype == SupportAgentSubtype.REGIONAL_GOVERNMENT


def test_non_support_agent_rejects_support_subtype():
    with pytest.raises(ValidationError):
        NodeCreate(
            type=NodeType.SCOPE,
            name="Scope",
            description="Description",
            support_agent_subtype=SupportAgentSubtype.RESEARCH,
        )


def test_value_chain_link_can_be_created_before_order_relations_are_added():
    command = NodeCreate(
        type=NodeType.VALUE_CHAIN_LINK,
        name="Transformación",
        description="Procesamiento del producto",
    )
    assert command.parent is None
