from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware

from .auth import CurrentUser, SESSION_COOKIE
from .config import settings
from .database import (
    add_concept_permissions_bulk,
    add_node_permissions_bulk,
    authenticate,
    create_session,
    create_or_reactivate_user,
    create_team,
    concept_permissions,
    delete_concept_permissions,
    delete_node_permissions,
    delete_team,
    delete_user_permanently,
    get_user,
    initialize_database,
    list_users,
    list_teams,
    leave_team,
    node_permissions,
    replace_node_permissions,
    replace_concept_permissions,
    revoke_session,
    update_password,
    update_team,
    user_editable_node_ids,
    user_editable_concept_iris,
    user_from_token,
)
from .domain import (
    ALLOWED_RELATIONS,
    BulkPermissionUpdate,
    GraphSnapshot,
    LoginCommand,
    NEW_NODE_SOURCE_RELATIONS,
    Node,
    NodeCreate,
    NodeUpdate,
    NodePermissionUpdate,
    NodeType,
    OntologyConcept,
    OntologyConceptCreate,
    OntologyConceptUpdate,
    OntologyConceptVisibilityUpdate,
    PasswordChangeCommand,
    RelationCreate,
    RelationType,
    SupportAgentSubtype,
    Team,
    TeamCreate,
    TeamUpdate,
    UserCreateCommand,
    UserPublic,
    UserRole,
    ValueChainDuplicate,
    validate_relation,
    role_can_manage_node_type,
)
from .graphdb import graphdb
from .realtime import hub


@asynccontextmanager
async def lifespan(_: FastAPI):
    await initialize_database()
    await graphdb.ensure_repository()
    await graphdb.wait_until_ready()
    await graphdb.seed(await list_users())
    await graphdb.migrate_kpi_text_fields()
    await graphdb.migrate_component_levels()
    yield


app = FastAPI(title="ORCA Graph API", version="8.11.0", lifespan=lifespan)
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


def require_team_manager(user: CurrentUser) -> None:
    if user.role not in {UserRole.ADMIN.value, UserRole.SPECIAL.value}:
        raise HTTPException(status_code=403, detail="Solo los usuarios especiales o administradores pueden gestionar equipos")


@app.get("/api/teams", response_model=list[Team])
async def teams(user: CurrentUser) -> list[Team]:
    return await list_teams(None if user.role in {UserRole.ADMIN.value, UserRole.SPECIAL.value} else user.id)


@app.post("/api/teams", response_model=Team, status_code=status.HTTP_201_CREATED)
async def add_team(command: TeamCreate, user: CurrentUser) -> Team:
    require_team_manager(user)
    try:
        return await create_team(command.name, command.member_ids)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.put("/api/teams/{team_id}", response_model=Team)
async def edit_team(team_id: str, command: TeamUpdate, user: CurrentUser) -> Team:
    require_team_manager(user)
    try:
        result = await update_team(team_id, command.name, command.member_ids)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Equipo no encontrado")
    return result


@app.delete("/api/teams/{team_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_team(team_id: str, user: CurrentUser) -> None:
    require_team_manager(user)
    if not await delete_team(team_id):
        raise HTTPException(status_code=404, detail="Equipo no encontrado")


@app.delete("/api/teams/{team_id}/membership", status_code=status.HTTP_204_NO_CONTENT)
async def resign_from_team(team_id: str, user: CurrentUser) -> None:
    if not await leave_team(team_id, user.id):
        raise HTTPException(status_code=404, detail="No perteneces a ese equipo")


@app.post("/api/users", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
async def create_user_account(
    command: UserCreateCommand,
    user: CurrentUser,
) -> UserPublic:
    if user.role != UserRole.ADMIN.value:
        raise HTTPException(
            status_code=403,
            detail="Solo las cuentas administradoras pueden administrar usuarios",
        )
    try:
        created = await create_or_reactivate_user(
            command.username,
            command.display_name,
            command.password,
            command.role,
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
    if user.role != UserRole.ADMIN.value:
        raise HTTPException(
            status_code=403,
            detail="Solo las cuentas administradoras pueden administrar usuarios",
        )
    if user_id == user.id:
        raise HTTPException(
            status_code=400,
            detail="Una cuenta administradora no puede eliminarse a sí misma",
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


@app.get("/api/concepts", response_model=list[OntologyConcept])
async def concepts(user: CurrentUser) -> list[OntologyConcept]:
    result = await graphdb.concepts(include_hidden=user.role in {UserRole.ADMIN.value, UserRole.SPECIAL.value})
    privileged = user.username == "orca" or user.role in {UserRole.ADMIN.value, UserRole.SPECIAL.value}
    shared = await user_editable_concept_iris(user.id)
    for concept in result:
        concept.editable = privileged or concept.iri in shared
        concept.deletable = concept.editable
    return result


async def require_ontology_editor(user: CurrentUser, concept_iri: str | None = None) -> None:
    privileged = user.username == "orca" or user.role in {UserRole.ADMIN.value, UserRole.SPECIAL.value}
    delegated = concept_iri is not None and concept_iri in await user_editable_concept_iris(user.id)
    if not privileged and not delegated:
        raise HTTPException(
            status_code=403,
            detail="Solo los usuarios especiales o administradores pueden modificar definiciones",
        )


@app.post("/api/concepts", response_model=OntologyConcept, status_code=status.HTTP_201_CREATED)
async def create_concept(command: OntologyConceptCreate, user: CurrentUser) -> OntologyConcept:
    await require_ontology_editor(user)
    try:
        concept = await graphdb.save_concept(command.label, command.definition)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await hub.publish({"type": "ontology.changed", "action": "concept.created", "actor": user.public().model_dump(), "concept": concept.model_dump()})
    return concept


@app.put("/api/concepts/visibility", response_model=OntologyConcept)
async def update_concept_visibility(
    concept_iri: str,
    command: OntologyConceptVisibilityUpdate,
    user: CurrentUser,
) -> OntologyConcept:
    if user.username != "orca" and user.role != UserRole.ADMIN.value:
        raise HTTPException(status_code=403, detail="Solo los administradores pueden cambiar la visibilidad")
    try:
        concept = await graphdb.set_concept_visibility(concept_iri, command.visible)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await hub.publish({"type": "ontology.changed", "action": "concept.visibility", "actor": user.public().model_dump(), "concept": concept.model_dump()})
    return concept


@app.put("/api/concepts", response_model=OntologyConcept)
async def update_concept(concept_iri: str, command: OntologyConceptUpdate, user: CurrentUser) -> OntologyConcept:
    await require_ontology_editor(user, concept_iri)
    try:
        concept = await graphdb.save_concept(command.label, command.definition, concept_iri)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await hub.publish({"type": "ontology.changed", "action": "concept.updated", "actor": user.public().model_dump(), "concept": concept.model_dump()})
    return concept


@app.delete("/api/concepts", status_code=status.HTTP_204_NO_CONTENT)
async def delete_concept(concept_iri: str, user: CurrentUser) -> None:
    await require_ontology_editor(user, concept_iri)
    try:
        await graphdb.delete_concept(concept_iri)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await delete_concept_permissions(concept_iri)
    await hub.publish({
        "type": "ontology.changed",
        "action": "concept.deleted",
        "actor": user.public().model_dump(),
        "concept_iri": concept_iri,
    })


@app.get("/api/concepts/permissions", response_model=list[dict])
async def get_concept_permissions(concept_iri: str, user: CurrentUser) -> list[dict]:
    require_team_manager(user)
    return [item.model_dump() for item in await concept_permissions(concept_iri)]


@app.put("/api/concepts/permissions", response_model=list[dict])
async def set_concept_permissions(concept_iri: str, command: NodePermissionUpdate, user: CurrentUser) -> list[dict]:
    require_team_manager(user)
    known = {item.iri for item in await graphdb.concepts(include_hidden=True)}
    if concept_iri not in known:
        raise HTTPException(status_code=404, detail="Definición no encontrada")
    try:
        await replace_concept_permissions(concept_iri, command.grants)
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return [item.model_dump() for item in await concept_permissions(concept_iri)]


@app.post("/api/concepts/permissions/bulk", status_code=status.HTTP_204_NO_CONTENT)
async def add_bulk_concept_permissions(command: BulkPermissionUpdate, user: CurrentUser) -> None:
    require_team_manager(user)
    known = {item.iri for item in await graphdb.concepts(include_hidden=True)}
    if any(concept_iri not in known for concept_iri in command.resource_ids):
        raise HTTPException(status_code=404, detail="Alguna definición seleccionada ya no existe")
    try:
        await add_concept_permissions_bulk(command.resource_ids, command.grants)
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


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
    return await graphdb.snapshot(await list_users(include_inactive=True), user.id, await user_editable_node_ids(user.id), user.role)


async def has_delegated_node_access(user: CurrentUser, node_id: str, node_type: NodeType) -> bool:
    grants = await user_editable_node_ids(user.id)
    chain_id = await graphdb.node_chain_id(node_id)
    delegated = node_id in grants or (chain_id is not None and chain_id in grants)
    if not delegated:
        return False
    return role_can_manage_node_type(user.role, node_type)


@app.post("/api/nodes", response_model=Node, status_code=status.HTTP_201_CREATED)
async def create_node(command: NodeCreate, user: CurrentUser) -> Node:
    privileged_roles = {UserRole.ADMIN.value, UserRole.SPECIAL.value}
    agent_types = {
        NodeType.PRINCIPAL_AGENT,
        NodeType.AUXILIARY_AGENT,
        NodeType.SUPPORT_AGENT,
    }
    if command.type in agent_types and user.role not in privileged_roles:
        raise HTTPException(
            status_code=403,
            detail="Solo los usuarios especiales o administradores pueden crear agentes",
        )
    if (
        command.support_agent_subtype == SupportAgentSubtype.LOCAL_GOVERNMENT
        and user.role not in privileged_roles
    ):
        raise HTTPException(
            status_code=403,
            detail="Solo los usuarios especiales o administradores pueden crear agentes gubernamentales locales",
        )
    if command.type != NodeType.VALUE_CHAIN and command.chain_id:
        active_chain = await graphdb.node(command.chain_id)
        if active_chain is None or active_chain[1] != NodeType.VALUE_CHAIN:
            raise HTTPException(status_code=422, detail="La cadena activa no es válida")
    if (
        command.type in {NodeType.VALUE_CHAIN, NodeType.VALUE_CHAIN_LINK}
        and user.role not in {UserRole.ADMIN.value, UserRole.SPECIAL.value}
    ):
        raise HTTPException(
            status_code=403,
            detail="Solo los usuarios especiales o administradores pueden crear cadenas o eslabones",
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
        code=command.code,
        evaluation=command.evaluation,
        unit_iri=None,
        support_agent_subtype=command.support_agent_subtype,
        parent_id=parent_id,
        relation=relation,
        chain_id=command.chain_id,
    )
    node = Node(
        id=node_id,
        type=command.type,
        name=command.name.strip(),
        description=command.description.strip(),
        code=command.code,
        evaluation=command.evaluation,
        support_agent_subtype=command.support_agent_subtype,
        graph=user.graph_uri,
        owner_id=user.id,
        owner_name=user.display_name,
        owner_initials=user.initials,
        editable=True,
        chain_id=command.chain_id,
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


def _node_ids_for_chain(snapshot: GraphSnapshot, chain_id: str) -> set[str]:
    chain_ids = {node.id for node in snapshot.nodes if node.type == NodeType.VALUE_CHAIN}
    explicitly_scoped = {node.id for node in snapshot.nodes if node.chain_id == chain_id}
    foreign_scoped = {
        node.id for node in snapshot.nodes
        if node.chain_id is not None and node.chain_id != chain_id
    }
    membership_links: set[str] = set()
    foreign_links: set[str] = set()
    for edge in snapshot.relations:
        if edge.type == RelationType.HAS_VALUE_CHAIN_LINK:
            if edge.source == chain_id:
                membership_links.add(edge.target)
            elif edge.source in chain_ids:
                foreign_links.add(edge.target)
        elif edge.type == RelationType.IS_VALUE_CHAIN_LINK_OF:
            if edge.target == chain_id:
                membership_links.add(edge.source)
            elif edge.target in chain_ids:
                foreign_links.add(edge.source)
    visible = {chain_id, *explicitly_scoped, *membership_links}
    changed = True
    while changed:
        changed = False
        for edge in snapshot.relations:
            candidate = (
                edge.target if edge.source in visible
                else edge.source if edge.target in visible
                else None
            )
            if (
                candidate
                and candidate not in chain_ids
                and candidate not in foreign_links
                and candidate not in foreign_scoped
                and candidate not in visible
            ):
                visible.add(candidate)
                changed = True
    return visible


@app.post("/api/value-chains/{chain_id:path}/duplicate", response_model=Node)
async def duplicate_value_chain(
    chain_id: str,
    command: ValueChainDuplicate,
    user: CurrentUser,
) -> Node:
    if user.role not in {UserRole.ADMIN.value, UserRole.SPECIAL.value}:
        raise HTTPException(
            status_code=403,
            detail="Solo los usuarios especiales o administradores pueden duplicar cadenas",
        )
    source = await graphdb.node(chain_id)
    if source is None or source[1] != NodeType.VALUE_CHAIN:
        raise HTTPException(status_code=404, detail="Cadena de valor no encontrada")
    if await graphdb.value_chain_name_exists(command.name):
        raise HTTPException(
            status_code=409,
            detail="Ya existe una cadena de valor con ese nombre",
        )
    snapshot = await graphdb.snapshot(await list_users(include_inactive=True), user.id, await user_editable_node_ids(user.id), user.role)
    node_ids = _node_ids_for_chain(snapshot, chain_id)
    try:
        new_chain_id = await graphdb.duplicate_value_chain(
            graph_uri=user.graph_uri,
            source_chain_id=chain_id,
            node_ids=node_ids,
            new_name=command.name,
        )
    except (LookupError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    updated = await graphdb.snapshot(await list_users(include_inactive=True), user.id, await user_editable_node_ids(user.id), user.role)
    node = next(item for item in updated.nodes if item.id == new_chain_id)
    await hub.publish({
        "type": "graph.changed",
        "action": "value_chain.duplicated",
        "actor": user.public().model_dump(),
        "source_chain_id": chain_id,
        "node": node.model_dump(),
    })
    return node


@app.put("/api/nodes", response_model=Node)
async def update_node(node_id: str, command: NodeUpdate, user: CurrentUser) -> Node:
    existing = await graphdb.node(node_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Nodo no encontrado")
    graph_uri, node_type = existing
    delegated = graph_uri != user.graph_uri and await has_delegated_node_access(user, node_id, node_type)
    if graph_uri != user.graph_uri and not delegated:
        raise HTTPException(status_code=403, detail="No tienes permisos para editar este nodo")
    privileged_roles = {UserRole.ADMIN.value, UserRole.SPECIAL.value}
    if node_type == NodeType.AUXILIARY_AGENT and user.role not in privileged_roles and not delegated:
        raise HTTPException(
            status_code=403,
            detail="Solo los usuarios especiales o administradores pueden editar agentes auxiliares",
        )
    if (
        command.support_agent_subtype == SupportAgentSubtype.LOCAL_GOVERNMENT
        and user.role not in privileged_roles and not delegated
    ):
        raise HTTPException(
            status_code=403,
            detail="Solo los usuarios especiales o administradores pueden crear o editar agentes gubernamentales locales",
        )
    try:
        validated = NodeCreate(
            type=node_type,
            name=command.name,
            description=command.description,
            code=command.code,
            evaluation=command.evaluation,
            support_agent_subtype=command.support_agent_subtype,
            parent={"parent_id": node_id, "relation": "similarTo"}
            if node_type in {NodeType.KPI}
            else {"parent_id": node_id, "relation": "participatesInValueChainLink"}
            if node_type in {NodeType.PRINCIPAL_AGENT}
            else {"parent_id": node_id, "relation": "participatesInValueChainLink"}
            if node_type in {NodeType.AUXILIARY_AGENT, NodeType.SUPPORT_AGENT, NodeType.VALUE_CHAIN_LINK}
            else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await graphdb.update_node(
        graph_uri=graph_uri,
        node_id=node_id,
        node_type=node_type,
        name=validated.name,
        description=validated.description,
        code=validated.code,
        evaluation=validated.evaluation,
        unit_iri=None,
        support_agent_subtype=validated.support_agent_subtype,
    )
    snapshot = await graphdb.snapshot(await list_users(include_inactive=True), user.id, await user_editable_node_ids(user.id), user.role)
    node = next(item for item in snapshot.nodes if item.id == node_id)
    await hub.publish({"type": "graph.changed", "action": "node.updated", "actor": user.public().model_dump(), "node": node.model_dump()})
    return node


@app.post("/api/relations", status_code=status.HTTP_201_CREATED)
async def create_relation(command: RelationCreate, user: CurrentUser) -> dict:
    source = await graphdb.node(command.source_id)
    target = await graphdb.node(command.target_id)
    if source is None or target is None:
        raise HTTPException(status_code=404, detail="No se encuentra el origen o destino")
    if (
        NodeType.AUXILIARY_AGENT in {source[1], target[1]}
        and user.role not in {UserRole.ADMIN.value, UserRole.SPECIAL.value}
    ):
        raise HTTPException(
            status_code=403,
            detail="Solo los usuarios especiales o administradores pueden editar agentes auxiliares",
        )
    try:
        validate_relation(source[1], target[1], command.relation)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if command.relation in {
        RelationType.HAS_VALUE_CHAIN_LINK,
        RelationType.IS_VALUE_CHAIN_LINK_OF,
        RelationType.IS_RELATED,
        RelationType.MOVES_FRESH_FISH,
        RelationType.MOVES_DRY_FISH,
        RelationType.MOVES_FISHMEAL,
        RelationType.TRANSFERS_FUNDING,
    } and user.role not in {UserRole.ADMIN.value, UserRole.SPECIAL.value}:
        raise HTTPException(
            status_code=403,
            detail="Solo los usuarios especiales o administradores pueden modificar la estructura de cadenas",
        )
    if command.relation in {
        RelationType.HAS_VALUE_CHAIN_LINK,
        RelationType.IS_VALUE_CHAIN_LINK_OF,
    }:
        chain_id, link_id = (
            (command.source_id, command.target_id)
            if command.relation == RelationType.HAS_VALUE_CHAIN_LINK
            else (command.target_id, command.source_id)
        )
        existing_chain = await graphdb.value_chain_for_link(link_id)
        if existing_chain is not None and existing_chain != chain_id:
            raise HTTPException(
                status_code=409,
                detail="Un eslabón solo puede pertenecer a una cadena de valor",
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
    agent_relations = {
        RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK,
        RelationType.HAS_PARTICIPATING_AGENT,
        RelationType.APPLIES_TO_AGENT,
        RelationType.HAS_ASSOCIATED_KPI,
    }
    if command.relation in agent_relations:
        source = await graphdb.node(command.source_id)
        target = await graphdb.node(command.target_id)
        if (
            source is not None
            and target is not None
            and NodeType.AUXILIARY_AGENT in {source[1], target[1]}
            and user.role not in {UserRole.ADMIN.value, UserRole.SPECIAL.value}
        ):
            raise HTTPException(
                status_code=403,
                detail="Solo los usuarios especiales o administradores pueden editar agentes auxiliares",
            )
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


@app.get("/api/nodes/permissions", response_model=list[dict])
async def get_node_permissions(node_id: str, user: CurrentUser) -> list[dict]:
    node = await graphdb.node(node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Nodo no encontrado")
    if node[0] != user.graph_uri:
        raise HTTPException(status_code=403, detail="Solo el propietario puede consultar o cambiar los permisos")
    return [item.model_dump() for item in await node_permissions(node_id)]


@app.put("/api/nodes/permissions", response_model=list[dict])
async def set_node_permissions(node_id: str, command: NodePermissionUpdate, user: CurrentUser) -> list[dict]:
    node = await graphdb.node(node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Nodo no encontrado")
    if node[0] != user.graph_uri:
        raise HTTPException(status_code=403, detail="Solo el propietario puede compartir el nodo")
    try:
        await replace_node_permissions(node_id, user.id, command.grants)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return [item.model_dump() for item in await node_permissions(node_id)]


@app.post("/api/nodes/permissions/bulk", status_code=status.HTTP_204_NO_CONTENT)
async def add_bulk_node_permissions(command: BulkPermissionUpdate, user: CurrentUser) -> None:
    for node_id in command.resource_ids:
        node = await graphdb.node(node_id)
        if node is None:
            raise HTTPException(status_code=404, detail="Algún nodo seleccionado ya no existe")
        if node[0] != user.graph_uri:
            raise HTTPException(status_code=403, detail="Solo puedes compartir en bloque nodos de tu propiedad")
    try:
        await add_node_permissions_bulk(command.resource_ids, user.id, command.grants)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.delete("/api/nodes", status_code=status.HTTP_204_NO_CONTENT)
async def delete_node(node_id: str, user: CurrentUser) -> None:
    node = await graphdb.node(node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    if node[0] != user.graph_uri and not await has_delegated_node_access(user, node_id, node[1]):
        raise HTTPException(status_code=403, detail="No tienes permisos para borrar este nodo")
    await graphdb.delete_node(node[0], node_id)
    await delete_node_permissions(node_id)
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
