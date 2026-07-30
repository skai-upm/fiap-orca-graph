from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    graphdb_url: str = "http://graphdb:7200"
    graphdb_repository: str = "orca-graph"
    global_graph_uri: str = "https://orca-graph.example/graph/global"
    personal_graph_prefix: str = "https://orca-graph.example/graph/users/"
    ontology_path: Path = Path("/app/ontology/orca-graph.ttl")
    om_ontology_path: Path = Path("/app/ontology/om-2.0.rdf")
    om_graph_uri: str = "https://orca-graph.example/graph/ontology/om-2.0"
    database_url: str = "sqlite+aiosqlite:////app/data/orca.db"
    session_days: int = 7
    cookie_secure: bool = False
    cors_origins: str = "http://localhost:9090,http://localhost:5173"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def repository_url(self) -> str:
        return f"{self.graphdb_url}/repositories/{self.graphdb_repository}"

    @property
    def statements_url(self) -> str:
        return f"{self.repository_url}/statements"

    @property
    def allowed_origins(self) -> list[str]:
        return [value.strip() for value in self.cors_origins.split(",") if value.strip()]


settings = Settings()
