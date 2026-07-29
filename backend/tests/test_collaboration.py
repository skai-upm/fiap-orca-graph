import pytest
from fastapi import HTTPException

from app.database import UserModel
from app.domain import (
    NodeCreate,
    NodeType,
    PasswordChangeCommand,
    RelationCreate,
    RelationType,
    UserCreateCommand,
)
from app.main import (
    change_password,
    create_node,
    create_relation,
    create_user_account,
    delete_node,
    delete_relation,
    delete_user_account,
)


def demo_user() -> UserModel:
    return UserModel(
        id="user-test",
        username="test",
        display_name="Test User",
        initials="TU",
        role="editor",
        graph_uri="https://orca-graph.example/graph/users/user-test",
        password_hash="not-used",
        active=True,
    )


def orca_user() -> UserModel:
    return UserModel(
        id="user-orca",
        username="orca",
        display_name="ORCA",
        initials="OR",
        role="orca",
        graph_uri="https://orca-graph.example/graph/users/user-orca",
        password_hash="not-used",
        active=True,
    )


@pytest.mark.asyncio
async def test_node_is_written_to_authenticated_users_graph(monkeypatch):
    captured = {}

    async def fake_create_node(**kwargs):
        captured.update(kwargs)

    async def fake_publish(_payload):
        return None

    monkeypatch.setattr("app.main.graphdb.create_node", fake_create_node)
    monkeypatch.setattr("app.main.hub.publish", fake_publish)

    result = await create_node(
        NodeCreate(
            type=NodeType.SCOPE,
            name="Test scope",
            description="A complete test scope.",
        ),
        demo_user(),
    )

    assert captured["graph_uri"] == demo_user().graph_uri
    assert result.owner_id == "user-test"
    assert result.editable is True


@pytest.mark.asyncio
async def test_invalid_cross_type_similarity_is_rejected(monkeypatch):
    async def fake_node(node_id):
        if node_id == "scope":
            return "global", NodeType.SCOPE
        return "personal", NodeType.KPI

    monkeypatch.setattr("app.main.graphdb.node", fake_node)

    with pytest.raises(HTTPException) as error:
        await create_relation(
            RelationCreate(
                source_id="scope",
                target_id="kpi",
                relation=RelationType.SIMILAR_TO,
            ),
            demo_user(),
        )

    assert error.value.status_code == 422


@pytest.mark.asyncio
async def test_kpi_application_patterns_are_exclusive(monkeypatch):
    async def fake_node(node_id):
        if node_id == "kpi":
            return "personal", NodeType.KPI
        return "global", NodeType.VALUE_CHAIN_LINK

    async def fake_source_relation_types(_node_id):
        return {RelationType.APPLIES_TO_AGENT}

    monkeypatch.setattr("app.main.graphdb.node", fake_node)
    monkeypatch.setattr(
        "app.main.graphdb.source_relation_types",
        fake_source_relation_types,
    )

    with pytest.raises(HTTPException) as error:
        await create_relation(
            RelationCreate(
                source_id="kpi",
                target_id="link",
                relation=RelationType.APPLIES_TO_VALUE_CHAIN_LINK,
            ),
            demo_user(),
        )

    assert error.value.status_code == 422


@pytest.mark.asyncio
async def test_editor_cannot_create_value_chain():
    with pytest.raises(HTTPException) as error:
        await create_node(
            NodeCreate(
                type=NodeType.VALUE_CHAIN,
                name="Private chain",
            ),
            demo_user(),
        )

    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_orca_account_can_create_value_chain(monkeypatch):
    captured = {}

    async def fake_create_node(**kwargs):
        captured.update(kwargs)

    async def fake_publish(_payload):
        return None

    monkeypatch.setattr("app.main.graphdb.create_node", fake_create_node)
    monkeypatch.setattr("app.main.hub.publish", fake_publish)

    result = await create_node(
        NodeCreate(type=NodeType.VALUE_CHAIN, name="New value chain"),
        orca_user(),
    )

    assert captured["graph_uri"] == orca_user().graph_uri
    assert result.type == NodeType.VALUE_CHAIN
    assert result.owner_id == "user-orca"


@pytest.mark.asyncio
async def test_admin_role_cannot_create_value_chain():
    user = demo_user()
    user.role = "admin"

    with pytest.raises(HTTPException) as error:
        await create_node(
            NodeCreate(type=NodeType.VALUE_CHAIN, name="Admin chain"),
            user,
        )

    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_only_orca_can_create_user(monkeypatch):
    async def fake_create_user(*_args, **_kwargs):
        raise AssertionError("Persistence must not be called")

    monkeypatch.setattr("app.main.create_or_reactivate_user", fake_create_user)

    with pytest.raises(HTTPException) as error:
        await create_user_account(
            UserCreateCommand(
                username="new-user",
                display_name="New User",
                password="password123",
            ),
            demo_user(),
        )

    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_orca_can_create_user(monkeypatch):
    created = demo_user()
    created.id = "new-user-id"
    created.username = "new-user"

    async def fake_create_user(*_args, **_kwargs):
        return created

    async def fake_publish(_payload):
        return None

    monkeypatch.setattr("app.main.create_or_reactivate_user", fake_create_user)
    monkeypatch.setattr("app.main.hub.publish", fake_publish)

    result = await create_user_account(
        UserCreateCommand(
            username="new-user",
            display_name="New User",
            password="password123",
        ),
        orca_user(),
    )

    assert result.id == "new-user-id"
    assert result.username == "new-user"


@pytest.mark.asyncio
async def test_orca_cannot_delete_itself():
    with pytest.raises(HTTPException) as error:
        await delete_user_account(orca_user().id, orca_user())

    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_deleting_user_clears_graph_before_account(monkeypatch):
    operations = []
    target = demo_user().public()

    async def fake_get_user(_user_id):
        return target

    async def fake_delete_graph(graph_uri):
        operations.append(("graph", graph_uri))

    async def fake_delete_account(user_id):
        operations.append(("account", user_id))
        return True

    async def fake_publish(_payload):
        return None

    monkeypatch.setattr("app.main.get_user", fake_get_user)
    monkeypatch.setattr("app.main.graphdb.delete_graph", fake_delete_graph)
    monkeypatch.setattr("app.main.delete_user_permanently", fake_delete_account)
    monkeypatch.setattr("app.main.hub.publish", fake_publish)

    await delete_user_account(target.id, orca_user())

    assert operations == [
        ("graph", target.graph_uri),
        ("account", target.id),
    ]


@pytest.mark.asyncio
async def test_password_change_validates_current_password(monkeypatch):
    async def fake_authenticate(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.main.authenticate", fake_authenticate)

    with pytest.raises(HTTPException) as error:
        await change_password(
            PasswordChangeCommand(
                current_password="incorrect",
                new_password="new-password",
            ),
            demo_user(),
        )

    assert error.value.status_code == 400


@pytest.mark.asyncio
async def test_password_change_updates_hash_and_revokes_sessions(monkeypatch):
    captured = {}

    async def fake_authenticate(*_args, **_kwargs):
        return demo_user()

    async def fake_update_password(user_id, password):
        captured.update(user_id=user_id, password=password)

    monkeypatch.setattr("app.main.authenticate", fake_authenticate)
    monkeypatch.setattr("app.main.update_password", fake_update_password)

    await change_password(
        PasswordChangeCommand(
            current_password="old-password",
            new_password="new-password",
        ),
        demo_user(),
    )

    assert captured == {"user_id": "user-test", "password": "new-password"}


@pytest.mark.asyncio
async def test_editor_cannot_change_value_chain_topology(monkeypatch):
    async def fake_node(_node_id):
        return "global", NodeType.VALUE_CHAIN_LINK

    monkeypatch.setattr("app.main.graphdb.node", fake_node)

    with pytest.raises(HTTPException) as error:
        await create_relation(
            RelationCreate(
                source_id="link-a",
                target_id="link-b",
                relation=RelationType.PRECEDES,
            ),
            demo_user(),
        )

    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_scope_to_kpi_is_allowed_alongside_agent_application(monkeypatch):
    captured = {}

    async def fake_node(node_id):
        if node_id == "scope":
            return "global", NodeType.SCOPE
        return "personal", NodeType.KPI

    async def fake_source_relation_types(_node_id):
        return {RelationType.APPLIES_TO_AGENT}

    async def fake_create_relation(**kwargs):
        captured.update(kwargs)

    async def fake_publish(_payload):
        return None

    monkeypatch.setattr("app.main.graphdb.node", fake_node)
    monkeypatch.setattr(
        "app.main.graphdb.source_relation_types",
        fake_source_relation_types,
    )
    monkeypatch.setattr("app.main.graphdb.create_relation", fake_create_relation)
    monkeypatch.setattr("app.main.hub.publish", fake_publish)

    result = await create_relation(
        RelationCreate(
            source_id="scope",
            target_id="kpi",
            relation=RelationType.HAS_KPI,
        ),
        demo_user(),
    )

    assert captured["relation"] == RelationType.HAS_KPI
    assert result["type"] == RelationType.HAS_KPI.value


@pytest.mark.asyncio
async def test_user_cannot_delete_another_users_relation(monkeypatch):
    async def fake_relation_exists(*_args, **_kwargs):
        return False

    monkeypatch.setattr("app.main.graphdb.relation_exists", fake_relation_exists)

    with pytest.raises(HTTPException) as error:
        await delete_relation(
            RelationCreate(
                source_id="scope",
                target_id="kpi",
                relation=RelationType.HAS_KPI,
            ),
            demo_user(),
        )

    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_user_can_delete_own_relation(monkeypatch):
    captured = {}

    async def fake_relation_exists(*_args, **_kwargs):
        return True

    async def fake_delete_relation(**kwargs):
        captured.update(kwargs)

    async def fake_publish(_payload):
        return None

    monkeypatch.setattr("app.main.graphdb.relation_exists", fake_relation_exists)
    monkeypatch.setattr("app.main.graphdb.delete_relation", fake_delete_relation)
    monkeypatch.setattr("app.main.hub.publish", fake_publish)

    await delete_relation(
        RelationCreate(
            source_id="scope",
            target_id="kpi",
            relation=RelationType.HAS_KPI,
        ),
        demo_user(),
    )

    assert captured["graph_uri"] == demo_user().graph_uri
    assert captured["relation"] == RelationType.HAS_KPI


@pytest.mark.asyncio
async def test_user_cannot_delete_another_users_node(monkeypatch):
    async def fake_node(_node_id):
        return "https://orca-graph.example/graph/users/another-user", NodeType.SCOPE

    monkeypatch.setattr("app.main.graphdb.node", fake_node)

    with pytest.raises(HTTPException) as error:
        await delete_node("scope", demo_user())

    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_node_with_foreign_relations_is_deleted_in_cascade(monkeypatch):
    captured = {}

    async def fake_node(_node_id):
        return demo_user().graph_uri, NodeType.SCOPE

    async def fake_delete_node(*args):
        captured["args"] = args

    monkeypatch.setattr("app.main.graphdb.node", fake_node)
    monkeypatch.setattr("app.main.graphdb.delete_node", fake_delete_node)

    async def fake_publish(_payload):
        return None

    monkeypatch.setattr("app.main.hub.publish", fake_publish)

    await delete_node("scope", demo_user())

    assert captured["args"] == (demo_user().graph_uri, "scope")


@pytest.mark.asyncio
async def test_user_can_delete_own_unreferenced_node(monkeypatch):
    captured = {}

    async def fake_node(_node_id):
        return demo_user().graph_uri, NodeType.SCOPE

    async def fake_delete_node(*args, **kwargs):
        captured["args"] = args
        captured.update(kwargs)

    async def fake_publish(_payload):
        return None

    monkeypatch.setattr("app.main.graphdb.node", fake_node)
    monkeypatch.setattr("app.main.graphdb.delete_node", fake_delete_node)
    monkeypatch.setattr("app.main.hub.publish", fake_publish)

    await delete_node("scope", demo_user())

    assert captured["args"] == (demo_user().graph_uri, "scope")
