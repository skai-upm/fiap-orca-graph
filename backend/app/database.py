from datetime import UTC, datetime, timedelta
from hashlib import sha256
from secrets import token_urlsafe
from uuid import uuid4

from argon2 import PasswordHasher
from sqlalchemy import Boolean, DateTime, ForeignKey, String, delete, event, select, update
from sqlalchemy.ext.asyncio import AsyncAttrs, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .config import settings
from .domain import UserPublic


class Base(AsyncAttrs, DeclarativeBase):
    pass


class UserModel(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(200))
    initials: Mapped[str] = mapped_column(String(4))
    role: Mapped[str] = mapped_column(String(30), default="editor")
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


BOOTSTRAP_USERS_VERSION = "6.0.0"

BOOTSTRAP_USERS = [
    {
        "id": "user-orca",
        "username": "orca",
        "display_name": "ORCA",
        "initials": "OR",
        "role": "orca",
        "password": "orca123",
    },
    {
        "id": "user-andrea",
        "username": "andrea",
        "display_name": "Andrea Cimmino",
        "initials": "AC",
        "role": "editor",
        "password": "demo123",
    },
    {
        "id": "user-maria",
        "username": "maria",
        "display_name": "María Pérez",
        "initials": "MP",
        "role": "editor",
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
                existing.username = item["username"]
                existing.display_name = item["display_name"]
                existing.initials = item["initials"]
                existing.role = item["role"]
                existing.graph_uri = f"{settings.personal_graph_prefix}{item['id']}"
                existing.password_hash = password_hasher.hash(item["password"])
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
            existing.role = "editor"
            existing.active = True
            model = existing
        else:
            user_id = str(uuid4())
            model = UserModel(
                id=user_id,
                username=normalized,
                display_name=display_name.strip(),
                initials=initials_for(display_name),
                role="editor",
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
