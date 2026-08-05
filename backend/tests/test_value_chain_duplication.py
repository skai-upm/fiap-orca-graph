from app.domain import GraphSnapshot, Node, NodeType, Relation, RelationType
from app.main import _node_ids_for_chain


def _node(node_id: str, node_type: NodeType, chain_id: str | None = None) -> Node:
    return Node(
        id=node_id,
        type=node_type,
        name=node_id,
        graph="https://example.org/graph",
        chain_id=chain_id,
    )


def _relation(source: str, target: str, relation: RelationType) -> Relation:
    return Relation(
        source=source,
        target=target,
        type=relation,
        graph="https://example.org/graph",
    )


def test_chain_workspace_closure_includes_legacy_content_but_not_other_chain():
    chain_a = "https://example.org/chain/a"
    chain_b = "https://example.org/chain/b"
    link_a = "https://example.org/link/a"
    link_b = "https://example.org/link/b"
    shared_agent = "https://example.org/agent/shared"
    component_a = "https://example.org/component/a"
    component_b = "https://example.org/component/b"
    snapshot = GraphSnapshot(
        current_user_id="user",
        nodes=[
            _node(chain_a, NodeType.VALUE_CHAIN),
            _node(chain_b, NodeType.VALUE_CHAIN),
            _node(link_a, NodeType.VALUE_CHAIN_LINK, chain_a),
            _node(link_b, NodeType.VALUE_CHAIN_LINK, chain_b),
            _node(shared_agent, NodeType.PRINCIPAL_AGENT),
            _node(component_a, NodeType.COMPONENT),
            _node(component_b, NodeType.COMPONENT, chain_b),
        ],
        relations=[
            _relation(chain_a, link_a, RelationType.HAS_VALUE_CHAIN_LINK),
            _relation(chain_b, link_b, RelationType.HAS_VALUE_CHAIN_LINK),
            _relation(shared_agent, link_a, RelationType.BELONGS_TO),
            _relation(shared_agent, link_b, RelationType.BELONGS_TO),
            _relation(shared_agent, component_a, RelationType.IS_RELATED),
            _relation(shared_agent, component_b, RelationType.IS_RELATED),
        ],
    )

    selected = _node_ids_for_chain(snapshot, chain_a)

    assert {chain_a, link_a, shared_agent, component_a} <= selected
    assert chain_b not in selected
    assert link_b not in selected
    assert component_b not in selected
