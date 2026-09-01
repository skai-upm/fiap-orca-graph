from datetime import UTC, datetime, timedelta
from hashlib import sha256
from secrets import token_urlsafe
from uuid import uuid4

from argon2 import PasswordHasher
from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint, delete, event, select, update
from sqlalchemy.ext.asyncio import AsyncAttrs, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .config import settings
from .domain import NodePermissionGrant, PermissionTargetType, Team, UserPublic, UserRole


class Base(AsyncAttrs, DeclarativeBase):
    pass


class UserModel(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(200))
    initials: Mapped[str] = mapped_column(String(4))
    role: Mapped[str] = mapped_column(String(30), default=UserRole.NORMAL.value)
    graph_uri: Mapped[str] = mapped_column(String(500), unique=True)
    password_hash: Mapped[str] = mapped_column(String(500))
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    def public(self) -> UserPublic:
        return UserPublic(
            id=self.id,
            username=self.username,
            display_name=self.display_name,
            initials=self.initials,
            role=self.role,
            graph_uri=self.graph_uri,
        )


class SessionModel(Base):
    __tablename__ = "sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class AppMetadataModel(Base):
    __tablename__ = "app_metadata"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(String(500))


class TeamModel(Base):
    __tablename__ = "teams"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    name_key: Mapped[str] = mapped_column(String(200), unique=True, index=True)


class TeamMembershipModel(Base):
    __tablename__ = "team_memberships"
    __table_args__ = (UniqueConstraint("team_id", "user_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    team_id: Mapped[str] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)


class NodeGrantModel(Base):
    __tablename__ = "node_grants"
    __table_args__ = (UniqueConstraint("node_id", "target_type", "target_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    node_id: Mapped[str] = mapped_column(String(500), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    target_type: Mapped[str] = mapped_column(String(20))
    target_id: Mapped[str] = mapped_column(String(36), index=True)


class ConceptGrantModel(Base):
    __tablename__ = "concept_grants"
    __table_args__ = (UniqueConstraint("concept_iri", "target_type", "target_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    concept_iri: Mapped[str] = mapped_column(String(500), index=True)
    target_type: Mapped[str] = mapped_column(String(20))
    target_id: Mapped[str] = mapped_column(String(36), index=True)


engine = create_async_engine(
    settings.database_url,
    connect_args={"check_same_thread": False}
    if settings.database_url.startswith("sqlite")
    else {},
)
SessionFactory = async_sessionmaker(engine, expire_on_commit=False)
password_hasher = PasswordHasher()


if settings.database_url.startswith("sqlite"):
    @event.listens_for(engine.sync_engine, "connect")
    def configure_sqlite(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()


BOOTSTRAP_USERS_VERSION = "7.2.0"

BOOTSTRAP_USERS = [
    {
        "id": "user-orca",
        "username": "orca",
        "display_name": "ORCA",
        "initials": "OR",
        "role": UserRole.ADMIN.value,
        "password": "orca123",
    },
    {
        "id": "user-andrea",
        "username": "andrea",
        "display_name": "Andrea Cimmino",
        "initials": "AC",
        "role": UserRole.NORMAL.value,
        "password": "demo123",
    },
    {
        "id": "user-maria",
        "username": "maria",
        "display_name": "María Pérez",
        "initials": "MP",
        "role": UserRole.NORMAL.value,
        "password": "demo123",
    },
]


async def initialize_database() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with SessionFactory() as session:
        marker = await session.get(AppMetadataModel, "bootstrap_users_version")
        must_apply_bootstrap = (
            marker is None or marker.value != BOOTSTRAP_USERS_VERSION
        )
        for item in BOOTSTRAP_USERS:
            with session.no_autoflush:
                result = await session.execute(
                    select(UserModel).where(UserModel.username == item["username"])
                )
                existing = result.scalar_one_or_none()
                if existing is None:
                    existing = await session.get(UserModel, item["id"])
            if existing is None:
                session.add(
                    UserModel(
                        id=item["id"],
                        username=item["username"],
                        display_name=item["display_name"],
                        initials=item["initials"],
                        role=item["role"],
                        graph_uri=f"{settings.personal_graph_prefix}{item['id']}",
                        password_hash=password_hasher.hash(item["password"]),
                    )
                )
            elif must_apply_bootstrap:
                existing.display_name = item["display_name"]
                existing.initials = item["initials"]
                existing.role = item["role"]
                existing.active = True
        if must_apply_bootstrap:
            if marker is None:
                session.add(
                    AppMetadataModel(
                        key="bootstrap_users_version",
                        value=BOOTSTRAP_USERS_VERSION,
                    )
                )
            else:
                marker.value = BOOTSTRAP_USERS_VERSION
            existing_users = await session.execute(select(UserModel))
            valid_roles = {role.value for role in UserRole}
            for existing_user in existing_users.scalars().all():
                if existing_user.role == "orca":
                    existing_user.role = UserRole.ADMIN.value
                elif existing_user.role not in valid_roles:
                    existing_user.role = UserRole.NORMAL.value
        await session.commit()


async def authenticate(username: str, password: str) -> UserModel | None:
    async with SessionFactory() as session:
        result = await session.execute(
            select(UserModel).where(UserModel.username == username, UserModel.active.is_(True))
        )
        user = result.scalar_one_or_none()
        if user is None:
            return None
        try:
            password_hasher.verify(user.password_hash, password)
        except Exception:
            return None
        return user


async def create_session(user_id: str) -> str:
    token = token_urlsafe(32)
    async with SessionFactory() as session:
        session.add(
            SessionModel(
                token_hash=sha256(token.encode()).hexdigest(),
                user_id=user_id,
                expires_at=datetime.now(UTC) + timedelta(days=settings.session_days),
            )
        )
        await session.commit()
    return token


async def user_from_token(token: str | None) -> UserModel | None:
    if not token:
        return None
    async with SessionFactory() as session:
        result = await session.execute(
            select(UserModel)
            .join(SessionModel, SessionModel.user_id == UserModel.id)
            .where(
                SessionModel.token_hash == sha256(token.encode()).hexdigest(),
                SessionModel.revoked.is_(False),
                SessionModel.expires_at > datetime.now(UTC),
                UserModel.active.is_(True),
            )
        )
        return result.scalar_one_or_none()


async def revoke_session(token: str | None) -> None:
    if not token:
        return
    async with SessionFactory() as session:
        model = await session.get(SessionModel, sha256(token.encode()).hexdigest())
        if model:
            model.revoked = True
            await session.commit()


async def list_users(include_inactive: bool = False) -> list[UserPublic]:
    async with SessionFactory() as session:
        statement = select(UserModel)
        if not include_inactive:
            statement = statement.where(UserModel.active.is_(True))
        result = await session.execute(statement)
        return [item.public() for item in result.scalars().all()]


def initials_for(display_name: str) -> str:
    words = [word for word in display_name.strip().split() if word]
    if not words:
        return "US"
    return "".join(word[0] for word in words[:2]).upper()


async def create_or_reactivate_user(
    username: str,
    display_name: str,
    password: str,
    role: UserRole,
) -> UserModel:
    normalized = username.strip().lower()
    async with SessionFactory() as session:
        result = await session.execute(
            select(UserModel).where(UserModel.username == normalized)
        )
        existing = result.scalar_one_or_none()
        if existing and existing.active:
            raise ValueError("El nombre de usuario ya existe")
        if existing:
            existing.display_name = display_name.strip()
            existing.initials = initials_for(display_name)
            existing.password_hash = password_hasher.hash(password)
            existing.role = role.value
            existing.active = True
            model = existing
        else:
            user_id = str(uuid4())
            model = UserModel(
                id=user_id,
                username=normalized,
                display_name=display_name.strip(),
                initials=initials_for(display_name),
                role=role.value,
                graph_uri=f"{settings.personal_graph_prefix}{user_id}",
                password_hash=password_hasher.hash(password),
                active=True,
            )
            session.add(model)
        await session.commit()
        await session.refresh(model)
        return model


async def get_user(user_id: str) -> UserPublic | None:
    async with SessionFactory() as session:
        model = await session.get(UserModel, user_id)
        return model.public() if model and model.active else None


async def delete_user_permanently(user_id: str) -> bool:
    async with SessionFactory() as session:
        model = await session.get(UserModel, user_id)
        if model is None:
            return False
        await session.execute(
            delete(SessionModel).where(SessionModel.user_id == user_id)
        )
        await session.execute(delete(NodeGrantModel).where(
            (NodeGrantModel.owner_id == user_id)
            | ((NodeGrantModel.target_type == PermissionTargetType.USER.value) & (NodeGrantModel.target_id == user_id))
        ))
        await session.execute(delete(ConceptGrantModel).where(
            (ConceptGrantModel.target_type == PermissionTargetType.USER.value)
            & (ConceptGrantModel.target_id == user_id)
        ))
        await session.delete(model)
        await session.commit()
        return True


async def update_password(user_id: str, new_password: str) -> None:
    async with SessionFactory() as session:
        model = await session.get(UserModel, user_id)
        if model is None or not model.active:
            raise ValueError("Usuario no encontrado")
        model.password_hash = password_hasher.hash(new_password)
        await session.execute(
            update(SessionModel)
            .where(SessionModel.user_id == user_id)
            .values(revoked=True)
        )
        await session.commit()


async def list_teams(user_id: str | None = None) -> list[Team]:
    async with SessionFactory() as session:
        teams = (await session.execute(select(TeamModel).order_by(TeamModel.name))).scalars().all()
        result: list[Team] = []
        for team in teams:
            members = (await session.execute(
                select(TeamMembershipModel.user_id).where(TeamMembershipModel.team_id == team.id)
            )).scalars().all()
            if user_id is None or user_id in members:
                result.append(Team(id=team.id, name=team.name, member_ids=list(members)))
        return result


async def create_team(name: str, member_ids: list[str]) -> Team:
    normalized = name.strip()
    name_key = normalized.casefold()
    async with SessionFactory() as session:
        duplicate = await session.execute(select(TeamModel).where(TeamModel.name_key == name_key))
        if duplicate.scalar_one_or_none() is not None:
            raise ValueError("Ya existe un equipo con ese nombre")
        active_ids = set((await session.execute(
            select(UserModel.id).where(UserModel.id.in_(member_ids), UserModel.active.is_(True))
        )).scalars().all()) if member_ids else set()
        if active_ids != set(member_ids):
            raise LookupError("Alguno de los usuarios seleccionados no existe")
        team = TeamModel(id=str(uuid4()), name=normalized, name_key=name_key)
        session.add(team)
        await session.flush()
        session.add_all([TeamMembershipModel(id=str(uuid4()), team_id=team.id, user_id=item) for item in member_ids])
        await session.commit()
        return Team(id=team.id, name=team.name, member_ids=member_ids)


async def update_team(team_id: str, name: str, member_ids: list[str]) -> Team | None:
    normalized = name.strip()
    name_key = normalized.casefold()
    async with SessionFactory() as session:
        team = await session.get(TeamModel, team_id)
        if team is None:
            return None
        duplicate = await session.execute(select(TeamModel).where(TeamModel.name_key == name_key, TeamModel.id != team_id))
        if duplicate.scalar_one_or_none() is not None:
            raise ValueError("Ya existe un equipo con ese nombre")
        active_ids = set((await session.execute(
            select(UserModel.id).where(UserModel.id.in_(member_ids), UserModel.active.is_(True))
        )).scalars().all()) if member_ids else set()
        if active_ids != set(member_ids):
            raise LookupError("Alguno de los usuarios seleccionados no existe")
        team.name = normalized
        team.name_key = name_key
        await session.execute(delete(TeamMembershipModel).where(TeamMembershipModel.team_id == team_id))
        session.add_all([TeamMembershipModel(id=str(uuid4()), team_id=team_id, user_id=item) for item in member_ids])
        await session.commit()
        return Team(id=team.id, name=team.name, member_ids=member_ids)


async def delete_team(team_id: str) -> bool:
    async with SessionFactory() as session:
        team = await session.get(TeamModel, team_id)
        if team is None:
            return False
        await session.execute(delete(NodeGrantModel).where(NodeGrantModel.target_type == PermissionTargetType.TEAM.value, NodeGrantModel.target_id == team_id))
        await session.execute(delete(ConceptGrantModel).where(ConceptGrantModel.target_type == PermissionTargetType.TEAM.value, ConceptGrantModel.target_id == team_id))
        await session.delete(team)
        await session.commit()
        return True


async def leave_team(team_id: str, user_id: str) -> bool:
    async with SessionFactory() as session:
        result = await session.execute(delete(TeamMembershipModel).where(TeamMembershipModel.team_id == team_id, TeamMembershipModel.user_id == user_id))
        await session.commit()
        return bool(result.rowcount)


async def user_editable_node_ids(user_id: str) -> set[str]:
    async with SessionFactory() as session:
        team_ids = select(TeamMembershipModel.team_id).where(TeamMembershipModel.user_id == user_id)
        statement = select(NodeGrantModel.node_id).where(
            ((NodeGrantModel.target_type == PermissionTargetType.USER.value) & (NodeGrantModel.target_id == user_id))
            | ((NodeGrantModel.target_type == PermissionTargetType.TEAM.value) & NodeGrantModel.target_id.in_(team_ids))
        )
        return set((await session.execute(statement)).scalars().all())


async def node_permissions(node_id: str) -> list[NodePermissionGrant]:
    async with SessionFactory() as session:
        rows = (await session.execute(select(NodeGrantModel).where(NodeGrantModel.node_id == node_id))).scalars().all()
        return [NodePermissionGrant(target_type=row.target_type, target_id=row.target_id) for row in rows]


async def replace_node_permissions(node_id: str, owner_id: str, grants: list[NodePermissionGrant]) -> None:
    async with SessionFactory() as session:
        user_ids = [item.target_id for item in grants if item.target_type == PermissionTargetType.USER]
        team_ids = [item.target_id for item in grants if item.target_type == PermissionTargetType.TEAM]
        valid_users = set((await session.execute(select(UserModel.id).where(UserModel.id.in_(user_ids), UserModel.active.is_(True)))).scalars().all()) if user_ids else set()
        valid_teams = set((await session.execute(select(TeamModel.id).where(TeamModel.id.in_(team_ids)))).scalars().all()) if team_ids else set()
        if valid_users != set(user_ids) or valid_teams != set(team_ids):
            raise LookupError("Algún usuario o equipo seleccionado ya no existe")
        if owner_id in valid_users:
            raise ValueError("El propietario ya tiene permisos sobre el nodo")
        await session.execute(delete(NodeGrantModel).where(NodeGrantModel.node_id == node_id))
        session.add_all([NodeGrantModel(id=str(uuid4()), node_id=node_id, owner_id=owner_id, target_type=item.target_type.value, target_id=item.target_id) for item in grants])
        await session.commit()


async def add_node_permissions_bulk(node_ids: list[str], owner_id: str, grants: list[NodePermissionGrant]) -> None:
    async with SessionFactory() as session:
        user_ids = [item.target_id for item in grants if item.target_type == PermissionTargetType.USER]
        team_ids = [item.target_id for item in grants if item.target_type == PermissionTargetType.TEAM]
        valid_users = set((await session.execute(select(UserModel.id).where(UserModel.id.in_(user_ids), UserModel.active.is_(True)))).scalars().all()) if user_ids else set()
        valid_teams = set((await session.execute(select(TeamModel.id).where(TeamModel.id.in_(team_ids)))).scalars().all()) if team_ids else set()
        if valid_users != set(user_ids) or valid_teams != set(team_ids):
            raise LookupError("Algún usuario o equipo seleccionado ya no existe")
        if owner_id in valid_users:
            raise ValueError("El propietario ya tiene permisos sobre el nodo")
        existing_rows = (await session.execute(select(NodeGrantModel).where(NodeGrantModel.node_id.in_(node_ids)))).scalars().all()
        existing = {(row.node_id, row.target_type, row.target_id) for row in existing_rows}
        session.add_all([
            NodeGrantModel(id=str(uuid4()), node_id=node_id, owner_id=owner_id, target_type=grant.target_type.value, target_id=grant.target_id)
            for node_id in node_ids for grant in grants
            if (node_id, grant.target_type.value, grant.target_id) not in existing
        ])
        await session.commit()


async def delete_node_permissions(node_id: str) -> None:
    async with SessionFactory() as session:
        await session.execute(delete(NodeGrantModel).where(NodeGrantModel.node_id == node_id))
        await session.commit()


async def user_editable_concept_iris(user_id: str) -> set[str]:
    async with SessionFactory() as session:
        team_ids = select(TeamMembershipModel.team_id).where(TeamMembershipModel.user_id == user_id)
        statement = select(ConceptGrantModel.concept_iri).where(
            ((ConceptGrantModel.target_type == PermissionTargetType.USER.value) & (ConceptGrantModel.target_id == user_id))
            | ((ConceptGrantModel.target_type == PermissionTargetType.TEAM.value) & ConceptGrantModel.target_id.in_(team_ids))
        )
        return set((await session.execute(statement)).scalars().all())


async def concept_permissions(concept_iri: str) -> list[NodePermissionGrant]:
    async with SessionFactory() as session:
        rows = (await session.execute(select(ConceptGrantModel).where(ConceptGrantModel.concept_iri == concept_iri))).scalars().all()
        return [NodePermissionGrant(target_type=row.target_type, target_id=row.target_id) for row in rows]


async def replace_concept_permissions(concept_iri: str, grants: list[NodePermissionGrant]) -> None:
    async with SessionFactory() as session:
        user_ids = [item.target_id for item in grants if item.target_type == PermissionTargetType.USER]
        team_ids = [item.target_id for item in grants if item.target_type == PermissionTargetType.TEAM]
        valid_users = set((await session.execute(select(UserModel.id).where(UserModel.id.in_(user_ids), UserModel.active.is_(True)))).scalars().all()) if user_ids else set()
        valid_teams = set((await session.execute(select(TeamModel.id).where(TeamModel.id.in_(team_ids)))).scalars().all()) if team_ids else set()
        if valid_users != set(user_ids) or valid_teams != set(team_ids):
            raise LookupError("Algún usuario o equipo seleccionado ya no existe")
        await session.execute(delete(ConceptGrantModel).where(ConceptGrantModel.concept_iri == concept_iri))
        session.add_all([ConceptGrantModel(id=str(uuid4()), concept_iri=concept_iri, target_type=item.target_type.value, target_id=item.target_id) for item in grants])
        await session.commit()


async def add_concept_permissions_bulk(concept_iris: list[str], grants: list[NodePermissionGrant]) -> None:
    async with SessionFactory() as session:
        user_ids = [item.target_id for item in grants if item.target_type == PermissionTargetType.USER]
        team_ids = [item.target_id for item in grants if item.target_type == PermissionTargetType.TEAM]
        valid_users = set((await session.execute(select(UserModel.id).where(UserModel.id.in_(user_ids), UserModel.active.is_(True)))).scalars().all()) if user_ids else set()
        valid_teams = set((await session.execute(select(TeamModel.id).where(TeamModel.id.in_(team_ids)))).scalars().all()) if team_ids else set()
        if valid_users != set(user_ids) or valid_teams != set(team_ids):
            raise LookupError("Algún usuario o equipo seleccionado ya no existe")
        existing_rows = (await session.execute(select(ConceptGrantModel).where(ConceptGrantModel.concept_iri.in_(concept_iris)))).scalars().all()
        existing = {(row.concept_iri, row.target_type, row.target_id) for row in existing_rows}
        session.add_all([
            ConceptGrantModel(id=str(uuid4()), concept_iri=concept_iri, target_type=grant.target_type.value, target_id=grant.target_id)
            for concept_iri in concept_iris for grant in grants
            if (concept_iri, grant.target_type.value, grant.target_id) not in existing
        ])
        await session.commit()


async def delete_concept_permissions(concept_iri: str) -> None:
    async with SessionFactory() as session:
        await session.execute(delete(ConceptGrantModel).where(ConceptGrantModel.concept_iri == concept_iri))
        await session.commit()
