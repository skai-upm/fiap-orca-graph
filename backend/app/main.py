from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware

from .auth import CurrentUser, SESSION_COOKIE
from .config import settings
from .database import (
    authenticate,
    create_session,
    create_or_reactivate_user,
    delete_user_permanently,
    get_user,
    initialize_database,
    list_users,
    revoke_session,
    update_password,
    user_from_token,
)
from .domain import (
    ALLOWED_RELATIONS,
    GraphSnapshot,
    LoginCommand,
    NEW_NODE_SOURCE_RELATIONS,
    Node,
    NodeCreate,
    NodeType,
    OM_UNITS,
    PasswordChangeCommand,
    RelationCreate,
    RelationType,
    UnitOption,
    UserCreateCommand,
    UserPublic,
    validate_relation,
)
from .graphdb import graphdb
from .realtime import hub


@asynccontextmanager
async def lifespan(_: FastAPI):
    await initialize_database()
    await graphdb.ensure_repository()
    await graphdb.wait_until_ready()
    await graphdb.seed(await list_users())
    yield


app = FastAPI(title="ORCA Graph API", version="6.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/auth/login", response_model=UserPublic)
async def login(command: LoginCommand, response: Response) -> UserPublic:
    user = await authenticate(command.username.strip().lower(), command.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos")
    token = await create_session(user.id)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_days * 86400,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return user.public()


@app.post("/api/auth/logout", status_code=204)
async def logout(request: Request, response: Response) -> None:
    await revoke_session(request.cookies.get(SESSION_COOKIE))
    response.delete_cookie(SESSION_COOKIE, path="/")


@app.get("/api/auth/me", response_model=UserPublic)
async def me(user: CurrentUser) -> UserPublic:
    return user.public()


@app.post("/api/auth/change-password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(command: PasswordChangeCommand, user: CurrentUser) -> None:
    if await authenticate(user.username, command.current_password) is None:
        raise HTTPException(status_code=400, detail="La contraseña actual no es correcta")
    if command.current_password == command.new_password:
        raise HTTPException(
            status_code=400,
            detail="La nueva contraseña debe ser diferente de la actual",
        )
    await update_password(user.id, command.new_password)


@app.get("/api/users", response_model=list[UserPublic])
async def users(_user: CurrentUser) -> list[UserPublic]:
    return await list_users()


@app.post("/api/users", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
async def create_user_account(
    command: UserCreateCommand,
    user: CurrentUser,
) -> UserPublic:
    if user.role != "orca":
        raise HTTPException(
            status_code=403,
            detail="Solo la cuenta ORCA puede administrar usuarios",
        )
    try:
        created = await create_or_reactivate_user(
            command.username,
            command.display_name,
            command.password,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await hub.publish(
        {
            "type": "graph.changed",
            "action": "user.created",
            "actor": user.public().model_dump(),
            "user": created.public().model_dump(),
        }
    )
    return created.public()


@app.delete("/api/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user_account(user_id: str, user: CurrentUser) -> None:
    if user.role != "orca":
        raise HTTPException(
            status_code=403,
            detail="Solo la cuenta ORCA puede administrar usuarios",
        )
    if user_id == user.id:
        raise HTTPException(
            status_code=400,
            detail="La cuenta ORCA no puede eliminarse a sí misma",
        )
    target = await get_user(user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    await graphdb.delete_graph(target.graph_uri)
    if not await delete_user_permanently(user_id):
        raise HTTPException(status_code=404, detail="Usuario no encontrado")
    await hub.publish(
        {
            "type": "graph.changed",
            "action": "user.deleted",
            "actor": user.public().model_dump(),
            "user_id": user_id,
        }
    )


@app.get("/api/units", response_model=list[UnitOption])
async def units(_user: CurrentUser) -> list[UnitOption]:
    return OM_UNITS


@app.get("/api/model")
async def model(_user: CurrentUser) -> dict:
    return {
        "nodeTypes": [item.value for item in NodeType],
        "relations": [
            {
                "source": source.value,
                "target": target.value,
                "allowed": [relation.value for relation in sorted(allowed, key=lambda x: x.value)],
            }
            for (source, target), allowed in ALLOWED_RELATIONS.items()
        ],
    }


@app.get("/api/graph", response_model=GraphSnapshot)
async def graph(user: CurrentUser) -> GraphSnapshot:
    return await graphdb.snapshot(await list_users(include_inactive=True), user.id)


@app.post("/api/nodes", response_model=Node, status_code=status.HTTP_201_CREATED)
async def create_node(command: NodeCreate, user: CurrentUser) -> Node:
    if command.type in {NodeType.VALUE_CHAIN, NodeType.VALUE_CHAIN_LINK} and user.role != "orca":
        raise HTTPException(
            status_code=403,
            detail="Only the ORCA account can create value chains or value-chain links",
        )
    parent_id = None
    relation = None
    if command.parent:
        parent = await graphdb.node(command.parent.parent_id)
        if parent is None:
            raise HTTPException(status_code=404, detail="No se ha encontrado el nodo padre")
        parent_id = command.parent.parent_id
        relation = command.parent.relation
        try:
            if relation in NEW_NODE_SOURCE_RELATIONS:
                validate_relation(command.type, parent[1], relation)
            else:
                validate_relation(parent[1], command.type, relation)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    node_id = f"https://orca-graph.example/resource/{uuid4()}"
    await graphdb.create_node(
        graph_uri=user.graph_uri,
        node_id=node_id,
        node_type=command.type,
        name=command.name.strip(),
        description=command.description.strip(),
        definition=command.definition,
        application_level=command.application_level,
        application_scope=command.application_scope,
        unit_iri=command.unit_iri,
        support_agent_subtype=command.support_agent_subtype,
        parent_id=parent_id,
        relation=relation,
    )
    node = Node(
        id=node_id,
        type=command.type,
        name=command.name.strip(),
        description=command.description.strip(),
        definition=command.definition,
        application_level=command.application_level,
        application_scope=command.application_scope,
        unit_iri=command.unit_iri,
        unit_label=next(
            (
                f"{unit.label} ({unit.symbol})"
                for unit in OM_UNITS
                if unit.iri == command.unit_iri
            ),
            None,
        ),
        support_agent_subtype=command.support_agent_subtype,
        graph=user.graph_uri,
        owner_id=user.id,
        owner_name=user.display_name,
        owner_initials=user.initials,
        editable=True,
    )
    await hub.publish(
        {
            "type": "graph.changed",
            "action": "node.created",
            "actor": user.public().model_dump(),
            "node": node.model_dump(),
        }
    )
    return node


@app.post("/api/relations", status_code=status.HTTP_201_CREATED)
async def create_relation(command: RelationCreate, user: CurrentUser) -> dict:
    source = await graphdb.node(command.source_id)
    target = await graphdb.node(command.target_id)
    if source is None or target is None:
        raise HTTPException(status_code=404, detail="No se encuentra el origen o destino")
    try:
        validate_relation(source[1], target[1], command.relation)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if command.relation in {
        RelationType.HAS_VALUE_CHAIN_LINK,
        RelationType.IS_VALUE_CHAIN_LINK_OF,
        RelationType.PRECEDES,
    } and user.role != "orca":
        raise HTTPException(
            status_code=403,
            detail="Only the ORCA account can modify value-chain structure",
        )
    kpi_id: str | None = None
    application_relation: RelationType | None = None
    if source[1] == NodeType.KPI and command.relation in {
        RelationType.APPLIES_TO_VALUE_CHAIN_LINK,
        RelationType.APPLIES_TO_AGENT,
        RelationType.APPLIES_TO_SCOPE,
    }:
        kpi_id = command.source_id
        application_relation = command.relation
    elif (
        target[1] == NodeType.KPI
        and source[1] == NodeType.SCOPE
        and command.relation == RelationType.HAS_KPI
    ):
        kpi_id = command.target_id
        application_relation = RelationType.APPLIES_TO_SCOPE
    if kpi_id and application_relation:
        existing = await graphdb.source_relation_types(kpi_id)
        incompatible_by_relation = {
            RelationType.APPLIES_TO_VALUE_CHAIN_LINK: {
                RelationType.APPLIES_TO_AGENT
            },
            RelationType.APPLIES_TO_AGENT: {
                RelationType.APPLIES_TO_VALUE_CHAIN_LINK
            },
            RelationType.APPLIES_TO_SCOPE: set(),
        }
        incompatible = incompatible_by_relation[application_relation]
        if existing & incompatible:
            raise HTTPException(
                status_code=422,
                detail=(
                    "A KPI cannot apply simultaneously to a value-chain link "
                    "and directly to an auxiliary or support agent"
                ),
            )
    await graphdb.create_relation(
        graph_uri=user.graph_uri,
        source_id=command.source_id,
        target_id=command.target_id,
        relation=command.relation,
    )
    payload = {
        "source": command.source_id,
        "target": command.target_id,
        "type": command.relation.value,
        "graph": user.graph_uri,
        "owner_id": user.id,
        "owner_name": user.display_name,
        "editable": True,
    }
    await hub.publish(
        {
            "type": "graph.changed",
            "action": "relation.created",
            "actor": user.public().model_dump(),
            "relation": payload,
        }
    )
    return payload


@app.delete("/api/relations", status_code=status.HTTP_204_NO_CONTENT)
async def delete_relation(command: RelationCreate, user: CurrentUser) -> None:
    if not await graphdb.relation_exists(
        user.graph_uri,
        command.source_id,
        command.target_id,
        command.relation,
    ):
        raise HTTPException(
            status_code=403,
            detail="You can only delete relations created in your personal graph",
        )
    await graphdb.delete_relation(
        graph_uri=user.graph_uri,
        source_id=command.source_id,
        target_id=command.target_id,
        relation=command.relation,
    )
    await hub.publish(
        {
            "type": "graph.changed",
            "action": "relation.deleted",
            "actor": user.public().model_dump(),
            "relation": command.model_dump(),
        }
    )


@app.delete("/api/nodes", status_code=status.HTTP_204_NO_CONTENT)
async def delete_node(node_id: str, user: CurrentUser) -> None:
    node = await graphdb.node(node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    if node[0] != user.graph_uri:
        raise HTTPException(
            status_code=403,
            detail="You can only delete nodes created in your personal graph",
        )
    await graphdb.delete_node(user.graph_uri, node_id)
    await hub.publish(
        {
            "type": "graph.changed",
            "action": "node.deleted",
            "actor": user.public().model_dump(),
            "node_id": node_id,
        }
    )


@app.websocket("/api/ws")
async def websocket(websocket: WebSocket) -> None:
    user = await user_from_token(websocket.cookies.get(SESSION_COOKIE))
    if user is None:
        await websocket.close(code=1008)
        return
    await hub.connect(websocket)
    await hub.publish(
        {
            "type": "presence.changed",
            "action": "joined",
            "user": user.public().model_dump(),
            "connected": hub.count,
        }
    )
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        hub.disconnect(websocket)
        await hub.publish(
            {
                "type": "presence.changed",
                "action": "left",
                "user": user.public().model_dump(),
                "connected": hub.count,
            }
        )
