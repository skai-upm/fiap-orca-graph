from enum import StrEnum

from pydantic import BaseModel, Field, model_validator


ORCA = "https://orca-graph.example/ontology/"
OM = "http://www.ontology-of-units-of-measure.org/resource/om-2/"


class NodeType(StrEnum):
    SCOPE = "Scope"
    KPI = "KPI"
    VALUE_CHAIN = "ValueChain"
    VALUE_CHAIN_LINK = "ValueChainLink"
    PRINCIPAL_AGENT = "PrincipalAgent"
    AUXILIARY_AGENT = "AuxiliaryAgent"
    SUPPORT_AGENT = "SupportAgent"


class ApplicationLevel(StrEnum):
    GENERAL = "General"
    REGIONAL = "Regional"
    PROVINCIAL = "Provincial"
    LOCALITY = "Locality"

    @property
    def iri(self) -> str:
        return f"{ORCA}{self.value}"


class SupportAgentSubtype(StrEnum):
    GENERAL = "SupportAgent"
    RESEARCH = "ResearchSupportAgent"
    TRAINING = "TrainingSupportAgent"
    GOVERNMENT = "GovernmentSupportAgent"
    NATIONAL_GOVERNMENT = "NationalGovernmentSupportAgent"
    REGIONAL_GOVERNMENT = "RegionalGovernmentSupportAgent"

    @property
    def iri(self) -> str:
        return f"{ORCA}{self.value}"


class RelationType(StrEnum):
    HAS_SUBSCOPE = "hasSubscope"
    HAS_SUPERSCOPE = "hasSuperscope"
    SIMILAR_TO = "similarTo"
    HAS_VALUE_CHAIN_LINK = "hasValueChainLink"
    IS_VALUE_CHAIN_LINK_OF = "isValueChainLinkOf"
    BELONGS_TO = "belongsTo"
    HAS_PRINCIPAL_AGENT = "hasPrincipalAgent"
    PARTICIPATES_IN_VALUE_CHAIN_LINK = "participatesInValueChainLink"
    HAS_PARTICIPATING_AGENT = "hasParticipatingAgent"
    APPLIES_TO_VALUE_CHAIN_LINK = "appliesToValueChainLink"
    APPLIES_TO_AGENT = "appliesToAgent"
    APPLIES_TO_SCOPE = "appliesToScope"
    HAS_KPI = "hasKPI"
    PRECEDES = "precedes"

    @property
    def iri(self) -> str:
        return f"{ORCA}{self.value}"


INVERSE_RELATIONS: dict[RelationType, RelationType] = {
    RelationType.HAS_SUBSCOPE: RelationType.HAS_SUPERSCOPE,
    RelationType.HAS_SUPERSCOPE: RelationType.HAS_SUBSCOPE,
    RelationType.HAS_VALUE_CHAIN_LINK: RelationType.IS_VALUE_CHAIN_LINK_OF,
    RelationType.IS_VALUE_CHAIN_LINK_OF: RelationType.HAS_VALUE_CHAIN_LINK,
    RelationType.BELONGS_TO: RelationType.HAS_PRINCIPAL_AGENT,
    RelationType.HAS_PRINCIPAL_AGENT: RelationType.BELONGS_TO,
    RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK: RelationType.HAS_PARTICIPATING_AGENT,
    RelationType.HAS_PARTICIPATING_AGENT: RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK,
    RelationType.APPLIES_TO_SCOPE: RelationType.HAS_KPI,
    RelationType.HAS_KPI: RelationType.APPLIES_TO_SCOPE,
}

NEW_NODE_SOURCE_RELATIONS = {
    RelationType.BELONGS_TO,
    RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK,
    RelationType.APPLIES_TO_VALUE_CHAIN_LINK,
    RelationType.APPLIES_TO_AGENT,
    RelationType.APPLIES_TO_SCOPE,
}


ALLOWED_RELATIONS: dict[tuple[NodeType, NodeType], set[RelationType]] = {
    (NodeType.SCOPE, NodeType.SCOPE): {
        RelationType.HAS_SUBSCOPE,
        RelationType.HAS_SUPERSCOPE,
        RelationType.SIMILAR_TO,
    },
    (NodeType.SCOPE, NodeType.KPI): {RelationType.HAS_KPI},
    (NodeType.KPI, NodeType.KPI): {RelationType.SIMILAR_TO},
    (NodeType.KPI, NodeType.SCOPE): {RelationType.APPLIES_TO_SCOPE},
    (NodeType.VALUE_CHAIN, NodeType.VALUE_CHAIN_LINK): {
        RelationType.HAS_VALUE_CHAIN_LINK
    },
    (NodeType.VALUE_CHAIN_LINK, NodeType.VALUE_CHAIN): {
        RelationType.IS_VALUE_CHAIN_LINK_OF
    },
    (NodeType.PRINCIPAL_AGENT, NodeType.VALUE_CHAIN_LINK): {
        RelationType.BELONGS_TO
    },
    (NodeType.VALUE_CHAIN_LINK, NodeType.PRINCIPAL_AGENT): {
        RelationType.HAS_PRINCIPAL_AGENT
    },
    (NodeType.AUXILIARY_AGENT, NodeType.VALUE_CHAIN_LINK): {
        RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK
    },
    (NodeType.SUPPORT_AGENT, NodeType.VALUE_CHAIN_LINK): {
        RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK
    },
    (NodeType.VALUE_CHAIN_LINK, NodeType.AUXILIARY_AGENT): {
        RelationType.HAS_PARTICIPATING_AGENT
    },
    (NodeType.VALUE_CHAIN_LINK, NodeType.SUPPORT_AGENT): {
        RelationType.HAS_PARTICIPATING_AGENT
    },
    (NodeType.VALUE_CHAIN_LINK, NodeType.VALUE_CHAIN_LINK): {
        RelationType.PRECEDES
    },
    (NodeType.KPI, NodeType.VALUE_CHAIN_LINK): {
        RelationType.APPLIES_TO_VALUE_CHAIN_LINK
    },
    (NodeType.KPI, NodeType.AUXILIARY_AGENT): {
        RelationType.APPLIES_TO_AGENT
    },
    (NodeType.KPI, NodeType.SUPPORT_AGENT): {
        RelationType.APPLIES_TO_AGENT
    },
}


class ParentLink(BaseModel):
    parent_id: str = Field(min_length=1)
    relation: RelationType


class NodeCreate(BaseModel):
    type: NodeType
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    definition: str | None = Field(default=None, max_length=2000)
    application_level: ApplicationLevel | None = None
    application_scope: str | None = Field(default=None, max_length=500)
    unit_iri: str | None = Field(default=None, max_length=500)
    support_agent_subtype: SupportAgentSubtype | None = None
    parent: ParentLink | None = None

    @model_validator(mode="after")
    def validate_required_fields(self) -> "NodeCreate":
        self.name = self.name.strip()
        self.description = self.description.strip()
        if not self.name:
            raise ValueError("Name is required")
        if self.type == NodeType.SCOPE and not self.description:
            raise ValueError("A scope requires a description")
        if self.type == NodeType.KPI:
            self.definition = (self.definition or "").strip()
            self.application_scope = (self.application_scope or "").strip()
            if not self.definition:
                raise ValueError("A KPI requires a definition")
            if self.application_level is None:
                raise ValueError("A KPI requires an application level")
            if not self.application_scope:
                raise ValueError("A KPI requires a free-text application scope")
            if not self.unit_iri:
                raise ValueError("A KPI requires an OM unit")
            if not self.unit_iri.startswith(OM):
                raise ValueError("The KPI unit must be an OM 2 resource")
        if self.type == NodeType.SUPPORT_AGENT:
            self.support_agent_subtype = (
                self.support_agent_subtype or SupportAgentSubtype.GENERAL
            )
        elif self.support_agent_subtype is not None:
            raise ValueError("Only a support agent can have a support-agent subtype")
        required_parent = {
            NodeType.VALUE_CHAIN_LINK,
            NodeType.PRINCIPAL_AGENT,
            NodeType.AUXILIARY_AGENT,
            NodeType.SUPPORT_AGENT,
            NodeType.KPI,
        }
        if self.type in required_parent and self.parent is None:
            raise ValueError(f"{self.type.value} requires a compatible relation")
        return self


class RelationCreate(BaseModel):
    source_id: str = Field(min_length=1)
    target_id: str = Field(min_length=1)
    relation: RelationType

    @model_validator(mode="after")
    def different_nodes(self) -> "RelationCreate":
        if self.source_id == self.target_id:
            raise ValueError("A node cannot be related to itself")
        return self


class Node(BaseModel):
    id: str
    type: NodeType
    name: str
    description: str = ""
    definition: str | None = None
    application_level: ApplicationLevel | None = None
    application_scope: str | None = None
    unit_iri: str | None = None
    unit_label: str | None = None
    support_agent_subtype: SupportAgentSubtype | None = None
    graph: str
    owner_id: str | None = None
    owner_name: str = "ORCA Graph"
    owner_initials: str = "OG"
    editable: bool = False


class Relation(BaseModel):
    source: str
    target: str
    type: RelationType
    graph: str
    owner_id: str | None = None
    owner_name: str = "ORCA Graph"
    editable: bool = False


class GraphSnapshot(BaseModel):
    nodes: list[Node]
    relations: list[Relation]
    current_user_id: str


class UnitOption(BaseModel):
    iri: str
    label: str
    symbol: str


OM_UNITS = [
    UnitOption(iri=f"{OM}one", label="Dimensionless", symbol="1"),
    UnitOption(iri=f"{OM}percent", label="Percent", symbol="%"),
    UnitOption(iri=f"{OM}kilogram", label="Kilogram", symbol="kg"),
    UnitOption(iri=f"{OM}tonne", label="Tonne", symbol="t"),
    UnitOption(iri=f"{OM}degreeCelsius", label="Degree Celsius", symbol="°C"),
    UnitOption(iri=f"{OM}kilowattHour", label="Kilowatt hour", symbol="kWh"),
    UnitOption(iri=f"{OM}euro", label="Euro", symbol="EUR"),
    UnitOption(iri=f"{OM}second-Time", label="Second", symbol="s"),
]


class UserPublic(BaseModel):
    id: str
    username: str
    display_name: str
    initials: str
    role: str
    graph_uri: str


class LoginCommand(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


class UserCreateCommand(BaseModel):
    username: str = Field(
        min_length=3,
        max_length=100,
        pattern=r"^[A-Za-z0-9._-]+$",
    )
    display_name: str = Field(min_length=2, max_length=200)
    password: str = Field(min_length=8, max_length=200)


class PasswordChangeCommand(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


def validate_relation(
    source_type: NodeType,
    target_type: NodeType,
    relation: RelationType,
) -> None:
    allowed = ALLOWED_RELATIONS.get((source_type, target_type), set())
    if relation not in allowed:
        allowed_text = ", ".join(sorted(item.value for item in allowed)) or "none"
        raise ValueError(
            f"{source_type.value} -> {target_type.value} does not allow "
            f"{relation.value}; allowed: {allowed_text}"
        )
