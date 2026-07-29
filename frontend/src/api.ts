export type NodeType =
  | "Scope"
  | "KPI"
  | "ValueChain"
  | "ValueChainLink"
  | "PrincipalAgent"
  | "AuxiliaryAgent"
  | "SupportAgent";

export type ApplicationLevel = "General" | "Regional" | "Provincial" | "Locality";
export type SupportAgentSubtype =
  | "SupportAgent"
  | "ResearchSupportAgent"
  | "TrainingSupportAgent"
  | "GovernmentSupportAgent"
  | "NationalGovernmentSupportAgent"
  | "RegionalGovernmentSupportAgent";

export type RelationType =
  | "hasSubscope"
  | "hasSuperscope"
  | "similarTo"
  | "hasValueChainLink"
  | "isValueChainLinkOf"
  | "belongsTo"
  | "hasPrincipalAgent"
  | "participatesInValueChainLink"
  | "hasParticipatingAgent"
  | "appliesToValueChainLink"
  | "appliesToAgent"
  | "appliesToScope"
  | "hasKPI"
  | "precedes";

export interface User {
  id: string;
  username: string;
  display_name: string;
  initials: string;
  role: string;
  graph_uri: string;
}

export interface UnitOption {
  iri: string;
  label: string;
  symbol: string;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  definition: string | null;
  application_level: ApplicationLevel | null;
  application_scope: string | null;
  unit_iri: string | null;
  unit_label: string | null;
  support_agent_subtype: SupportAgentSubtype | null;
  graph: string;
  owner_id: string | null;
  owner_name: string;
  owner_initials: string;
  editable: boolean;
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
  definition?: string;
  application_level?: ApplicationLevel;
  application_scope?: string;
  unit_iri?: string;
  support_agent_subtype?: SupportAgentSubtype;
  parent?: { parent_id: string; relation: RelationType };
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
  createUser: (body: { username: string; display_name: string; password: string }) =>
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
  units: () => request<UnitOption[]>("/api/units"),
  graph: () => request<Snapshot>("/api/graph"),
  createNode: (body: NodePayload) =>
    request<GraphNode>("/api/nodes", { method: "POST", body: JSON.stringify(body) }),
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
