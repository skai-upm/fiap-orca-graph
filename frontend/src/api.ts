export type NodeType =
  | "Scope"
  | "Component"
  | "KPI"
  | "ValueChain"
  | "ValueChainLink"
  | "PrincipalAgent"
  | "AuxiliaryAgent"
  | "SupportAgent";

export type SupportAgentSubtype =
  | "SupportAgent"
  | "ResearchSupportAgent"
  | "TrainingSupportAgent"
  | "GovernmentSupportAgent"
  | "NationalGovernmentSupportAgent"
  | "RegionalGovernmentSupportAgent"
  | "LocalGovernmentSupportAgent";

export type RelationType =
  | "hasComponent"
  | "isComponentOf"
  | "hasSubcomponent"
  | "hasSupercomponent"
  | "similarTo"
  | "hasValueChainLink"
  | "isValueChainLinkOf"
  | "belongsTo"
  | "hasPrincipalAgent"
  | "participatesInValueChainLink"
  | "hasParticipatingAgent"
  | "appliesToAgent"
  | "appliesToComponent"
  | "hasKPI"
  | "hasAssociatedKPI"
  | "isRelated"
  | "muevePescadoFresco"
  | "muevePescadoSeco"
  | "mueveHarinaDePescado"
  | "financiación";

export interface User {
  id: string;
  username: string;
  display_name: string;
  initials: string;
  role: UserRole;
  graph_uri: string;
}

export type UserRole = "admin" | "special" | "normal";

export interface OntologyConcept {
  iri: string;
  label: string;
  definition: string;
  visible: boolean;
  deletable: boolean;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  identification: string | null;
  evaluation: string | null;
  support_agent_subtype: SupportAgentSubtype | null;
  graph: string;
  owner_id: string | null;
  owner_name: string;
  owner_initials: string;
  editable: boolean;
  chain_id: string | null;
}

export interface GraphRelation {
  source: string;
  target: string;
  type: RelationType;
  graph: string;
  owner_id: string | null;
  owner_name: string;
  editable: boolean;
}

export interface Snapshot {
  nodes: GraphNode[];
  relations: GraphRelation[];
  current_user_id: string;
}

export interface NodePayload {
  type: NodeType;
  name: string;
  description: string;
  identification?: string;
  evaluation?: string;
  support_agent_subtype?: SupportAgentSubtype;
  parent?: { parent_id: string; relation: RelationType };
  chain_id?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export const api = {
  login: (username: string, password: string) =>
    request<User>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  me: () => request<User>("/api/auth/me"),
  users: () => request<User[]>("/api/users"),
  createUser: (body: { username: string; display_name: string; password: string; role: UserRole }) =>
    request<User>("/api/users", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  deleteUser: (userId: string) =>
    request<void>(`/api/users/${encodeURIComponent(userId)}`, {
      method: "DELETE"
    }),
  changePassword: (body: { current_password: string; new_password: string }) =>
    request<void>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  concepts: () => request<OntologyConcept[]>("/api/concepts"),
  createConcept: (body: { label: string; definition: string }) =>
    request<OntologyConcept>("/api/concepts", { method: "POST", body: JSON.stringify(body) }),
  updateConcept: (iri: string, body: { label: string; definition: string }) =>
    request<OntologyConcept>(`/api/concepts?concept_iri=${encodeURIComponent(iri)}`, {
      method: "PUT",
      body: JSON.stringify(body)
    }),
  updateConceptVisibility: (iri: string, visible: boolean) =>
    request<OntologyConcept>(`/api/concepts/visibility?concept_iri=${encodeURIComponent(iri)}`, {
      method: "PUT",
      body: JSON.stringify({ visible })
    }),
  deleteConcept: (iri: string) =>
    request<void>(`/api/concepts?concept_iri=${encodeURIComponent(iri)}`, {
      method: "DELETE"
    }),
  graph: () => request<Snapshot>("/api/graph"),
  createNode: (body: NodePayload) =>
    request<GraphNode>("/api/nodes", { method: "POST", body: JSON.stringify(body) }),
  updateNode: (nodeId: string, body: Omit<NodePayload, "type" | "parent">) =>
    request<GraphNode>(`/api/nodes?node_id=${encodeURIComponent(nodeId)}`, {
      method: "PUT",
      body: JSON.stringify(body)
    }),
  createRelation: (body: { source: string; target: string; type: RelationType }) =>
    request<GraphRelation>("/api/relations", {
      method: "POST",
      body: JSON.stringify({
        source_id: body.source,
        target_id: body.target,
        relation: body.type
      })
    }),
  deleteNode: (nodeId: string) =>
    request<void>(`/api/nodes?node_id=${encodeURIComponent(nodeId)}`, {
      method: "DELETE"
    }),
  deleteRelation: (body: { source: string; target: string; type: RelationType }) =>
    request<void>("/api/relations", {
      method: "DELETE",
      body: JSON.stringify({
        source_id: body.source,
        target_id: body.target,
        relation: body.type
      })
    })
};
