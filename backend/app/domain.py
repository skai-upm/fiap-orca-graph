from enum import StrEnum

from pydantic import BaseModel, Field, model_validator


ORCA = "https://orca-graph.example/ontology/"
OM = "http://www.ontology-of-units-of-measure.org/resource/om-2/"


class NodeType(StrEnum):
    SCOPE = "Scope"
    COMPONENT = "Component"
    KPI = "KPI"
    VALUE_CHAIN = "ValueChain"
    VALUE_CHAIN_LINK = "ValueChainLink"
    PRINCIPAL_AGENT = "PrincipalAgent"
    AUXILIARY_AGENT = "AuxiliaryAgent"
    SUPPORT_AGENT = "SupportAgent"


class UserRole(StrEnum):
    ADMIN = "admin"
    SPECIAL = "special"
    NORMAL = "normal"


class SupportAgentSubtype(StrEnum):
    GENERAL = "SupportAgent"
    RESEARCH = "ResearchSupportAgent"
    TRAINING = "TrainingSupportAgent"
    GOVERNMENT = "GovernmentSupportAgent"
    NATIONAL_GOVERNMENT = "NationalGovernmentSupportAgent"
    REGIONAL_GOVERNMENT = "RegionalGovernmentSupportAgent"
    LOCAL_GOVERNMENT = "LocalGovernmentSupportAgent"

    @property
    def iri(self) -> str:
        return f"{ORCA}{self.value}"


class RelationType(StrEnum):
    HAS_COMPONENT = "hasComponent"
    IS_COMPONENT_OF = "isComponentOf"
    HAS_SUBCOMPONENT = "hasSubcomponent"
    HAS_SUPERCOMPONENT = "hasSupercomponent"
    SIMILAR_TO = "similarTo"
    HAS_VALUE_CHAIN_LINK = "hasValueChainLink"
    IS_VALUE_CHAIN_LINK_OF = "isValueChainLinkOf"
    BELONGS_TO = "belongsTo"
    HAS_PRINCIPAL_AGENT = "hasPrincipalAgent"
    PARTICIPATES_IN_VALUE_CHAIN_LINK = "participatesInValueChainLink"
    HAS_PARTICIPATING_AGENT = "hasParticipatingAgent"
    APPLIES_TO_AGENT = "appliesToAgent"
    APPLIES_TO_COMPONENT = "appliesToComponent"
    HAS_KPI = "hasKPI"
    HAS_ASSOCIATED_KPI = "hasAssociatedKPI"
    IS_RELATED = "isRelated"
    MOVES_FRESH_FISH = "muevePescadoFresco"
    MOVES_DRY_FISH = "muevePescadoSeco"
    MOVES_FISHMEAL = "mueveHarinaDePescado"
    TRANSFERS_FUNDING = "financiación"

    @property
    def iri(self) -> str:
        return f"{ORCA}{self.value}"


INVERSE_RELATIONS: dict[RelationType, RelationType] = {
    RelationType.HAS_COMPONENT: RelationType.IS_COMPONENT_OF,
    RelationType.IS_COMPONENT_OF: RelationType.HAS_COMPONENT,
    RelationType.HAS_SUBCOMPONENT: RelationType.HAS_SUPERCOMPONENT,
    RelationType.HAS_SUPERCOMPONENT: RelationType.HAS_SUBCOMPONENT,
    RelationType.HAS_VALUE_CHAIN_LINK: RelationType.IS_VALUE_CHAIN_LINK_OF,
    RelationType.IS_VALUE_CHAIN_LINK_OF: RelationType.HAS_VALUE_CHAIN_LINK,
    RelationType.BELONGS_TO: RelationType.HAS_PRINCIPAL_AGENT,
    RelationType.HAS_PRINCIPAL_AGENT: RelationType.BELONGS_TO,
    RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK: RelationType.HAS_PARTICIPATING_AGENT,
    RelationType.HAS_PARTICIPATING_AGENT: RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK,
    RelationType.APPLIES_TO_COMPONENT: RelationType.HAS_KPI,
    RelationType.HAS_KPI: RelationType.APPLIES_TO_COMPONENT,
    RelationType.APPLIES_TO_AGENT: RelationType.HAS_ASSOCIATED_KPI,
    RelationType.HAS_ASSOCIATED_KPI: RelationType.APPLIES_TO_AGENT,
}

NEW_NODE_SOURCE_RELATIONS = {
    RelationType.BELONGS_TO,
    RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK,
    RelationType.APPLIES_TO_AGENT,
    RelationType.APPLIES_TO_COMPONENT,
}


ALLOWED_RELATIONS: dict[tuple[NodeType, NodeType], set[RelationType]] = {
    (NodeType.SCOPE, NodeType.COMPONENT): {RelationType.HAS_COMPONENT},
    (NodeType.COMPONENT, NodeType.SCOPE): {RelationType.IS_COMPONENT_OF},
    (NodeType.COMPONENT, NodeType.COMPONENT): {
        RelationType.HAS_SUBCOMPONENT,
        RelationType.HAS_SUPERCOMPONENT,
    },
    (NodeType.COMPONENT, NodeType.KPI): {RelationType.HAS_KPI},
    (NodeType.KPI, NodeType.KPI): {RelationType.SIMILAR_TO},
    (NodeType.KPI, NodeType.COMPONENT): {RelationType.APPLIES_TO_COMPONENT},
    (NodeType.VALUE_CHAIN, NodeType.VALUE_CHAIN_LINK): {
        RelationType.HAS_VALUE_CHAIN_LINK
    },
    (NodeType.VALUE_CHAIN_LINK, NodeType.VALUE_CHAIN): {
        RelationType.IS_VALUE_CHAIN_LINK_OF
    },
    (NodeType.PRINCIPAL_AGENT, NodeType.VALUE_CHAIN_LINK): {
        RelationType.BELONGS_TO,
        RelationType.PARTICIPATES_IN_VALUE_CHAIN_LINK,
    },
    (NodeType.VALUE_CHAIN_LINK, NodeType.PRINCIPAL_AGENT): {
        RelationType.HAS_PRINCIPAL_AGENT,
        RelationType.HAS_PARTICIPATING_AGENT,
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
        RelationType.IS_RELATED,
        RelationType.MOVES_FRESH_FISH,
        RelationType.MOVES_DRY_FISH,
        RelationType.MOVES_FISHMEAL,
        RelationType.TRANSFERS_FUNDING,
    },
    (NodeType.KPI, NodeType.AUXILIARY_AGENT): {
        RelationType.APPLIES_TO_AGENT
    },
    (NodeType.KPI, NodeType.PRINCIPAL_AGENT): {
        RelationType.APPLIES_TO_AGENT
    },
    (NodeType.KPI, NodeType.SUPPORT_AGENT): {
        RelationType.APPLIES_TO_AGENT
    },
    (NodeType.PRINCIPAL_AGENT, NodeType.KPI): {
        RelationType.HAS_ASSOCIATED_KPI
    },
    (NodeType.AUXILIARY_AGENT, NodeType.KPI): {
        RelationType.HAS_ASSOCIATED_KPI
    },
    (NodeType.SUPPORT_AGENT, NodeType.KPI): {
        RelationType.HAS_ASSOCIATED_KPI
    },
}


class ParentLink(BaseModel):
    parent_id: str = Field(min_length=1)
    relation: RelationType


class NodeCreate(BaseModel):
    type: NodeType
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    identification: str | None = Field(default=None, max_length=2000)
    evaluation: str | None = Field(default=None, max_length=2000)
    support_agent_subtype: SupportAgentSubtype | None = None
    parent: ParentLink | None = None
    chain_id: str | None = None

    @model_validator(mode="after")
    def validate_required_fields(self) -> "NodeCreate":
        self.name = self.name.strip()
        self.description = self.description.strip()
        if not self.name:
            raise ValueError("Name is required")
        if self.type in {NodeType.SCOPE, NodeType.COMPONENT} and not self.description:
            raise ValueError(f"A {self.type.value.lower()} requires a description")
        if self.type == NodeType.KPI:
            self.identification = (self.identification or "").strip()
            self.evaluation = (self.evaluation or "").strip()
            if not self.identification or not self.description or not self.evaluation:
                raise ValueError("A KPI requires identification, description and evaluation")
        elif self.identification is not None or self.evaluation is not None:
            raise ValueError("Only a KPI can have identification and evaluation")
        if self.type == NodeType.SUPPORT_AGENT:
            self.support_agent_subtype = (
                self.support_agent_subtype or SupportAgentSubtype.GENERAL
            )
        elif self.support_agent_subtype is not None:
            raise ValueError("Only a support agent can have a support-agent subtype")
        required_parent = {
            NodeType.PRINCIPAL_AGENT,
            NodeType.AUXILIARY_AGENT,
            NodeType.SUPPORT_AGENT,
        }
        if self.type in required_parent and self.parent is None:
            raise ValueError(f"{self.type.value} requires a compatible relation")
        return self


class NodeUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    identification: str | None = Field(default=None, max_length=2000)
    evaluation: str | None = Field(default=None, max_length=2000)
    support_agent_subtype: SupportAgentSubtype | None = None


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
    identification: str | None = None
    evaluation: str | None = None
    support_agent_subtype: SupportAgentSubtype | None = None
    graph: str
    owner_id: str | None = None
    owner_name: str = "ORCA Graph"
    owner_initials: str = "OG"
    editable: bool = False
    chain_id: str | None = None


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


class OntologyConcept(BaseModel):
    iri: str
    label: str
    definition: str
    visible: bool = True
    deletable: bool = False


class OntologyConceptCreate(BaseModel):
    label: str = Field(min_length=1, max_length=200)
    definition: str = Field(min_length=1, max_length=4000)

    @model_validator(mode="after")
    def trim_values(self) -> "OntologyConceptCreate":
        self.label = self.label.strip()
        self.definition = self.definition.strip()
        if not self.label or not self.definition:
            raise ValueError("Label and definition are required")
        return self


class OntologyConceptUpdate(OntologyConceptCreate):
    pass


class OntologyConceptVisibilityUpdate(BaseModel):
    visible: bool


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
    role: UserRole = UserRole.NORMAL


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
