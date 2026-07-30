import cytoscape, { Core } from "cytoscape";
import {
  CircleDot,
  FilterX,
  GitBranch,
  KeyRound,
  LogOut,
  Maximize2,
  FileSpreadsheet,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  UserCog,
  UserPlus,
  Users,
  X
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

import {
  api,
  GraphNode,
  GraphRelation,
  NodePayload,
  NodeType,
  RelationType,
  Snapshot,
  SupportAgentSubtype,
  UnitOption,
  User,
  UserRole
} from "./api";

const emptySnapshot: Snapshot = { nodes: [], relations: [], current_user_id: "" };
const APP_VERSION = "7.11.0";

const roleLabels: Record<UserRole, string> = {
  admin: "Administrador",
  special: "Usuario especial",
  normal: "Usuario normal"
};

function isAdmin(user: User) {
  return user.role === "admin";
}

function canManageValueChains(user: User) {
  return user.role === "admin" || user.role === "special";
}

const supportAgentSubtypeLabels: Record<SupportAgentSubtype, string> = {
  SupportAgent: "Agente de apoyo (general)",
  ResearchSupportAgent: "Agente de apoyo a la investigación",
  TrainingSupportAgent: "Agente de apoyo formativo",
  GovernmentSupportAgent: "Agente de apoyo gubernamental",
  NationalGovernmentSupportAgent: "Agente gubernamental nacional",
  RegionalGovernmentSupportAgent: "Agente gubernamental regional"
};

const typeInfo: Record<NodeType, { label: string; description: string }> = {
  Scope: { label: "Ámbito", description: "Área temática que agrupa componentes." },
  Component: { label: "Componente", description: "Elemento jerárquico que agrupa KPI." },
  KPI: { label: "KPI", description: "Indicador aplicado a un eslabón o agente." },
  ValueChain: { label: "Cadena de valor", description: "Agrupación de eslabones." },
  ValueChainLink: { label: "Eslabón", description: "Etapa de una cadena de valor." },
  PrincipalAgent: { label: "Agente principal", description: "Pertenece a un eslabón." },
  AuxiliaryAgent: { label: "Agente auxiliar", description: "Participa de forma auxiliar." },
  SupportAgent: { label: "Agente de apoyo", description: "Presta apoyo a un eslabón." }
};

const relationLabels: Record<RelationType, string> = {
  hasComponent: "tiene componente",
  isComponentOf: "es componente de",
  hasSubcomponent: "tiene subcomponente",
  hasSupercomponent: "tiene supercomponente",
  similarTo: "similar a",
  hasValueChainLink: "tiene eslabón",
  isValueChainLinkOf: "es eslabón de",
  belongsTo: "pertenece",
  hasPrincipalAgent: "tiene agente principal",
  participatesInValueChainLink: "participa en",
  hasParticipatingAgent: "tiene agente participante",
  appliesToValueChainLink: "se aplica al eslabón",
  appliesToAgent: "se aplica al agente",
  appliesToComponent: "se aplica al componente",
  hasKPI: "tiene KPI",
  hasAssociatedKPI: "tiene KPI asociado",
  precedes: "precede a"
};

const allowedMatrix: Partial<Record<NodeType, Partial<Record<NodeType, RelationType[]>>>> = {
  Scope: {
    Component: ["hasComponent"]
  },
  Component: {
    Scope: ["isComponentOf"],
    Component: ["hasSubcomponent", "hasSupercomponent"],
    KPI: ["hasKPI"]
  },
  KPI: {
    KPI: ["similarTo"],
    Component: ["appliesToComponent"],
    ValueChainLink: ["appliesToValueChainLink"],
    PrincipalAgent: ["appliesToAgent"],
    AuxiliaryAgent: ["appliesToAgent"],
    SupportAgent: ["appliesToAgent"]
  },
  ValueChain: { ValueChainLink: ["hasValueChainLink"] },
  ValueChainLink: {
    ValueChainLink: ["precedes"],
    ValueChain: ["isValueChainLinkOf"],
    PrincipalAgent: ["hasPrincipalAgent"],
    AuxiliaryAgent: ["hasParticipatingAgent"],
    SupportAgent: ["hasParticipatingAgent"]
  },
  PrincipalAgent: { ValueChainLink: ["belongsTo"], KPI: ["hasAssociatedKPI"] },
  AuxiliaryAgent: { ValueChainLink: ["participatesInValueChainLink"], KPI: ["hasAssociatedKPI"] },
  SupportAgent: { ValueChainLink: ["participatesInValueChainLink"], KPI: ["hasAssociatedKPI"] }
};

function allowedRelations(source?: GraphNode, target?: GraphNode): RelationType[] {
  if (!source || !target) return [];
  return allowedMatrix[source.type]?.[target.type] ?? [];
}

function RdfMark() {
  return (
    <div className="orca-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32">
        <path d="M8 9 22 7M8 10l7 13M22 8l-6 15M22 8l4 11" />
        <circle className="rdf-subject" cx="7" cy="9" r="4" />
        <circle className="rdf-predicate" cx="22" cy="7" r="3.5" />
        <circle className="rdf-object" cx="15" cy="24" r="4" />
        <rect className="rdf-literal" x="23" y="18" width="7" height="7" rx="1.5" />
      </svg>
    </div>
  );
}

interface Filters {
  scope: string;
  user: string;
  type: string;
  node: string;
}

function scopeMembership(snapshot: Snapshot) {
  const children = new Map<string, string[]>();
  snapshot.relations
    .filter((edge) => edge.type === "hasSubcomponent")
    .forEach((edge) => children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target]));
  const memberships = new Map<string, Set<string>>();
  snapshot.nodes.filter((node) => node.type === "Scope").forEach((scope) => {
    const queue = snapshot.relations
      .filter((edge) => edge.type === "hasComponent" && edge.source === scope.id)
      .map((edge) => edge.target);
    const visited = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      memberships.set(id, new Set([...(memberships.get(id) ?? []), scope.id]));
      (children.get(id) ?? []).forEach((child) => queue.push(child));
    }
  });
  return memberships;
}

function filterGraph(snapshot: Snapshot, filters: Filters): Snapshot {
  const memberships = scopeMembership(snapshot);
  const focus = new Set<string>();
  if (filters.node) {
    focus.add(filters.node);
    snapshot.relations.forEach((edge) => {
      if (edge.source === filters.node) focus.add(edge.target);
      if (edge.target === filters.node) focus.add(edge.source);
    });
  }
  const nodes = snapshot.nodes.filter((node) =>
    (!filters.scope || memberships.get(node.id)?.has(filters.scope)) &&
    (!filters.user || node.owner_id === filters.user ||
      (filters.user === "global" && node.owner_id === null)) &&
    (!filters.type || node.type === filters.type) &&
    (!filters.node || focus.has(node.id))
  );
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...snapshot,
    nodes,
    relations: snapshot.relations.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  };
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      onLogin(await api.login(username, password));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo iniciar sesión");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-brand">
          <RdfMark />
          <div>
            <h1><em>ORCA</em> Graph</h1>
            <p>Ontology-Restricted Collaborative Authoring of Graphs</p>
          </div>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="username">Usuario</label>
          <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <label htmlFor="password">Contraseña</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <button className="primary wide" disabled={loading}>
            {loading ? "Entrando…" : "Entrar"}
          </button>
        </form>
        <img src="/skai-logo.png" alt="SKAI Research Group" />
      </section>
    </main>
  );
}

function GraphCanvas({
  snapshot,
  selected,
  onSelect
}: {
  snapshot: Snapshot;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<Core | null>(null);

  useEffect(() => {
    if (!container.current) return;
    instance.current?.destroy();
    const neighbours = new Map<string, Set<string>>();
    snapshot.nodes.forEach((node) => neighbours.set(node.id, new Set()));
    snapshot.relations.forEach((edge) => {
      neighbours.get(edge.source)?.add(edge.target);
      neighbours.get(edge.target)?.add(edge.source);
    });
    const maxDegree = Math.max(
      1,
      ...snapshot.nodes.map((node) => neighbours.get(node.id)?.size ?? 0)
    );
    const dimensions: Record<NodeType, [number, number]> = {
      Scope: [136, 88],
      Component: [130, 84],
      KPI: [120, 120],
      ValueChain: [124, 124],
      ValueChainLink: [140, 88],
      PrincipalAgent: [120, 116],
      AuxiliaryAgent: [120, 116],
      SupportAgent: [120, 116]
    };
    instance.current = cytoscape({
      container: container.current,
      elements: [
        ...snapshot.nodes.map((node) => ({
          ...(() => {
            const degree = neighbours.get(node.id)?.size ?? 0;
            const scale = 1 + 0.45 * Math.sqrt(degree / maxDegree);
            const [baseWidth, baseHeight] = dimensions[node.type];
            return {
              data: {
                id: node.id,
                label: `${node.name}\n${node.owner_initials}`,
                type: node.type,
                editable: node.editable,
                degree,
                width: Math.round(baseWidth * scale),
                height: Math.round(baseHeight * scale)
              }
            };
          })()
        })),
        ...snapshot.relations.map((edge, index) => ({
          data: {
            id: `${edge.source}-${edge.type}-${edge.target}-${index}`,
            source: edge.source,
            target: edge.target,
            label: relationLabels[edge.type],
            editable: edge.editable,
            semantic: ["similarTo", "appliesToAgent", "appliesToValueChainLink", "appliesToComponent", "hasKPI", "hasAssociatedKPI"].includes(edge.type)
          }
        }))
      ],
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#e9fff9",
            "border-color": "#467599",
            "border-width": 2,
            color: "#17273e",
            label: "data(label)",
            "font-size": 15,
            "font-weight": 700,
            "text-wrap": "wrap",
            "text-max-width": "108px",
            "text-valign": "center",
            "text-halign": "center",
            width: "data(width)",
            height: "data(height)"
          }
        },
        { selector: 'node[type = "Scope"]', style: { shape: "rectangle", "background-color": "#b8e1e3", "border-color": "#4e86a6", color: "#16324a" } },
        { selector: 'node[type = "Component"]', style: { shape: "round-rectangle", "background-color": "#d6efe3", "border-color": "#4d9b78", color: "#163f34" } },
        { selector: 'node[type = "KPI"]', style: { shape: "diamond", "background-color": "#cff2e3", "border-color": "#2f9d79", color: "#16324a", "text-max-width": "88px" } },
        { selector: 'node[type = "ValueChain"]', style: { shape: "ellipse", "background-color": "#9fdadd", "border-color": "#315a78", color: "#16324a", "text-max-width": "96px" } },
        { selector: 'node[type = "ValueChainLink"]', style: { shape: "ellipse", "background-color": "#d7eaf5", "border-color": "#4e7fa0", color: "#16324a", "text-max-width": "116px" } },
        { selector: 'node[type = "PrincipalAgent"]', style: { shape: "pentagon", "background-color": "#afcbe0", "border-color": "#3e6f91", color: "#16324a" } },
        { selector: 'node[type = "AuxiliaryAgent"]', style: { shape: "round-pentagon", "background-color": "#c4e6e8", "border-color": "#5792a5", color: "#16324a" } },
        { selector: 'node[type = "SupportAgent"]', style: { shape: "heptagon", "background-color": "#bde8d7", "border-color": "#2f9d79", color: "#16324a" } },
        { selector: "node[?editable]", style: { "border-width": 5 } },
        { selector: 'node[type = "Scope"][!editable]', style: { "background-color": "#e3f3f4", "border-color": "#b7d5dc" } },
        { selector: 'node[type = "Component"][!editable]', style: { "background-color": "#edf8f2", "border-color": "#bddfcf" } },
        { selector: 'node[type = "KPI"][!editable]', style: { "background-color": "#e8f8f1", "border-color": "#b9decf" } },
        { selector: 'node[type = "ValueChain"][!editable]', style: { "background-color": "#dcf1f2", "border-color": "#b6d8da" } },
        { selector: 'node[type = "ValueChainLink"][!editable]', style: { "background-color": "#eff6fa", "border-color": "#c7dce8" } },
        { selector: 'node[type = "PrincipalAgent"][!editable]', style: { "background-color": "#e3edf4", "border-color": "#bfd0dc" } },
        { selector: 'node[type = "AuxiliaryAgent"][!editable]', style: { "background-color": "#e6f3f4", "border-color": "#c1dcde" } },
        { selector: 'node[type = "SupportAgent"][!editable]', style: { "background-color": "#e6f6f0", "border-color": "#bedfd2" } },
        { selector: "node[!editable]", style: { opacity: 0.9, "text-opacity": 0.94 } },
        {
          selector: "edge",
          style: {
            width: 2,
            "line-color": "#467599",
            "target-arrow-color": "#467599",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            color: "#657789",
            "font-size": 12,
            "font-weight": 600,
            "text-background-color": "#f7fbfc",
            "text-background-opacity": 0.94,
            "text-background-padding": "3px"
          }
        },
        { selector: "edge[?semantic]", style: { "line-color": "#33a37a", "target-arrow-color": "#33a37a", "line-style": "dashed" } },
        { selector: "edge[!editable]", style: { opacity: 0.92, "text-opacity": 0.96, "line-color": "#a8c5d7", "target-arrow-color": "#a8c5d7" } },
        { selector: ":selected", style: { "border-color": "#9ed8db", "border-width": 6, opacity: 1, "text-opacity": 1 } },
        { selector: "node[!editable]:selected", style: { opacity: 0.98, "text-opacity": 1 } }
      ],
      layout: {
        name: snapshot.nodes.length > 28 ? "cose" : "breadthfirst",
        directed: true,
        padding: 60,
        spacingFactor: snapshot.nodes.length > 25 ? 1.05 : 1.25,
        animate: false
      }
    });
    instance.current.on("tap", "node", (event) => onSelect(event.target.id()));
    instance.current.on("tap", (event) => {
      if (event.target === instance.current) onSelect(null);
    });
    return () => instance.current?.destroy();
  }, [snapshot, onSelect]);

  useEffect(() => {
    if (!instance.current) return;
    instance.current.$(":selected").unselect();
    if (selected) instance.current.getElementById(selected).select();
  }, [selected]);

  return <div className="graph" ref={container} />;
}

function creationTargets(type: NodeType, nodes: GraphNode[]) {
  if (type === "Scope") {
    return [];
  }
  if (type === "Component") {
    return nodes
      .filter((node) => node.type === "Scope" || node.type === "Component")
      .map((node) => ({
        node,
        relation: node.type === "Scope"
          ? "hasComponent" as RelationType
          : "hasSubcomponent" as RelationType
      }));
  }
  if (type === "ValueChainLink") {
    return nodes.filter((node) => node.type === "ValueChain")
      .map((node) => ({ node, relation: "hasValueChainLink" as RelationType }));
  }
  if (type === "PrincipalAgent") {
    return nodes.filter((node) => node.type === "ValueChainLink")
      .map((node) => ({ node, relation: "belongsTo" as RelationType }));
  }
  if (type === "AuxiliaryAgent" || type === "SupportAgent") {
    return nodes.filter((node) => node.type === "ValueChainLink")
      .map((node) => ({ node, relation: "participatesInValueChainLink" as RelationType }));
  }
  if (type === "KPI") {
    return nodes
      .filter((node) => ["Component", "ValueChainLink", "PrincipalAgent", "AuxiliaryAgent", "SupportAgent"].includes(node.type))
      .map((node) => ({
        node,
        relation: node.type === "Component"
          ? "appliesToComponent" as RelationType
          : node.type === "ValueChainLink"
            ? "appliesToValueChainLink" as RelationType
            : "appliesToAgent" as RelationType
      }));
  }
  return [];
}

function MultiNodeSelect({
  label,
  options,
  selected,
  onChange,
  placeholder
}: {
  label: string;
  options: GraphNode[];
  selected: string[];
  onChange: (ids: string[]) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selectedNodes = selected
    .map((id) => options.find((node) => node.id === id))
    .filter((node): node is GraphNode => Boolean(node));
  const available = options.filter((node) =>
    !selected.includes(node.id) &&
    `${node.name} ${typeInfo[node.type].label}`.toLowerCase().includes(query.toLowerCase())
  );
  return (
    <div className="multi-field">
      <label>{label}</label>
      <div className="multi-tags">
        {selectedNodes.map((node) => (
          <span className="multi-tag" key={node.id}>
            {node.name}
            <button type="button" aria-label={`Eliminar ${node.name}`} onClick={() => onChange(selected.filter((id) => id !== node.id))}>×</button>
          </span>
        ))}
      </div>
      <div className="multi-combobox">
        <input
          value={query}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        />
        <button type="button" className="multi-toggle" aria-label="Mostrar opciones" onClick={() => setOpen(!open)}>⌄</button>
        {open && (
          <div className="multi-options">
            {available.length ? available.map((node) => (
              <button
                type="button"
                key={node.id}
                onClick={() => { onChange([...selected, node.id]); setQuery(""); setOpen(false); }}
              >
                <strong>{node.name}</strong><span>{typeInfo[node.type].label} · {node.owner_name}</span>
              </button>
            )) : <p>No hay más coincidencias</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function UnitSelect({
  units,
  value,
  onChange
}: {
  units: UnitOption[];
  value: string;
  onChange: (iri: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = units.find((unit) => unit.iri === value);
  const normalizedQuery = query.trim().toLowerCase();
  const available = units.filter((unit) =>
    `${unit.label} ${unit.symbol} ${unit.iri}`.toLowerCase().includes(normalizedQuery)
  );
  return (
    <div className="multi-field">
      <label>Unidad OM</label>
      {selected && (
        <div className="multi-tags">
          <span className="multi-tag">
            {selected.label}{selected.symbol ? ` (${selected.symbol})` : ""}
            <button type="button" aria-label="Quitar unidad" onClick={() => onChange("")}>×</button>
          </span>
        </div>
      )}
      <div className="multi-combobox">
        <input
          value={query}
          placeholder="Buscar por nombre, símbolo o IRI..."
          onFocus={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        />
        <button type="button" className="multi-toggle" aria-label="Mostrar unidades" onClick={() => setOpen(!open)}>⌄</button>
        {open && (
          <div className="multi-options unit-options">
            {available.length ? available.map((unit) => (
              <button
                type="button"
                key={unit.iri}
                onClick={() => { onChange(unit.iri); setQuery(""); setOpen(false); }}
              >
                <strong>{unit.label}{unit.symbol ? ` (${unit.symbol})` : ""}</strong>
                <span>{unit.iri}</span>
              </button>
            )) : <p>No se han encontrado unidades</p>}
          </div>
        )}
      </div>
      {!value && <span className="field-hint">Selecciona una unidad de la ontología OM 2.0.</span>}
    </div>
  );
}

function NodeDialog({
  initialType,
  initialNode,
  nodes,
  relations,
  units,
  canManageValueChain,
  onClose,
  onCreated
}: {
  initialType: NodeType;
  initialNode?: GraphNode | null;
  nodes: GraphNode[];
  relations: GraphRelation[];
  units: UnitOption[];
  canManageValueChain: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [type, setType] = useState<NodeType>(initialType);
  const [targetId, setTargetId] = useState("");
  const editing = Boolean(initialNode);
  const [name, setName] = useState(initialNode?.name ?? "");
  const [description, setDescription] = useState(initialNode?.description ?? "");
  const [definition, setDefinition] = useState(initialNode?.definition ?? "");
  const [unitIri, setUnitIri] = useState(initialNode?.unit_iri ?? "");
  const [supportAgentSubtype, setSupportAgentSubtype] =
    useState<SupportAgentSubtype>(initialNode?.support_agent_subtype ?? "SupportAgent");
  const canonicalScopeComponent = (edge: Pick<GraphRelation, "source" | "target" | "type">) =>
    edge.type === "hasComponent"
      ? { scopeId: edge.source, componentId: edge.target }
      : edge.type === "isComponentOf"
        ? { scopeId: edge.target, componentId: edge.source }
        : null;
  const canonicalComponentHierarchy = (edge: Pick<GraphRelation, "source" | "target" | "type">) =>
    edge.type === "hasSubcomponent"
      ? { superId: edge.source, subId: edge.target }
      : edge.type === "hasSupercomponent"
        ? { superId: edge.target, subId: edge.source }
        : null;
  const canonicalComponentKpi = (edge: Pick<GraphRelation, "source" | "target" | "type">) =>
    edge.type === "hasKPI"
      ? { componentId: edge.source, kpiId: edge.target }
      : edge.type === "appliesToComponent"
        ? { componentId: edge.target, kpiId: edge.source }
        : null;
  const canonicalAgentKpi = (edge: Pick<GraphRelation, "source" | "target" | "type">) =>
    edge.type === "hasAssociatedKPI"
      ? { agentId: edge.source, kpiId: edge.target }
      : edge.type === "appliesToAgent"
        ? { agentId: edge.target, kpiId: edge.source }
        : null;
  const canonicalAgentLink = (edge: Pick<GraphRelation, "source" | "target" | "type">) => {
    if (edge.type === "belongsTo" || edge.type === "participatesInValueChainLink") {
      return { agentId: edge.source, linkId: edge.target };
    }
    if (edge.type === "hasPrincipalAgent" || edge.type === "hasParticipatingAgent") {
      return { agentId: edge.target, linkId: edge.source };
    }
    return null;
  };
  const canonicalKpiLink = (edge: Pick<GraphRelation, "source" | "target" | "type">) =>
    edge.type === "appliesToValueChainLink" ? { kpiId: edge.source, linkId: edge.target } : null;
  const unique = (ids: string[]) => [...new Set(ids)];
  const [scopeComponentIds, setScopeComponentIds] = useState<string[]>(
    initialNode?.type === "Scope"
      ? unique(relations.map(canonicalScopeComponent).filter((item) => item?.scopeId === initialNode.id).map((item) => item!.componentId))
      : []
  );
  const [scopeIds, setScopeIds] = useState<string[]>(
    initialNode?.type === "Component"
      ? unique(relations.map(canonicalScopeComponent).filter((item) => item?.componentId === initialNode.id).map((item) => item!.scopeId))
      : []
  );
  const [supercomponentIds, setSupercomponentIds] = useState<string[]>(
    initialNode?.type === "Component"
      ? unique(relations.map(canonicalComponentHierarchy).filter((item) => item?.subId === initialNode.id).map((item) => item!.superId))
      : []
  );
  const [subcomponentIds, setSubcomponentIds] = useState<string[]>(
    initialNode?.type === "Component"
      ? unique(relations.map(canonicalComponentHierarchy).filter((item) => item?.superId === initialNode.id).map((item) => item!.subId))
      : []
  );
  const [componentKpiIds, setComponentKpiIds] = useState<string[]>(
    initialNode?.type === "Component"
      ? unique(relations.map(canonicalComponentKpi).filter((item) => item?.componentId === initialNode.id).map((item) => item!.kpiId))
      : []
  );
  const membership = (edge: Pick<GraphRelation, "source" | "target" | "type">) => edge.type === "hasValueChainLink"
    ? { chainId: edge.source, linkId: edge.target }
    : edge.type === "isValueChainLinkOf"
      ? { chainId: edge.target, linkId: edge.source }
      : null;
  const initialChainLinkIds = initialNode?.type === "ValueChain"
    ? relations.map(membership).filter((item) => item?.chainId === initialNode.id).map((item) => item!.linkId)
    : [];
  const initialLinkChainId = initialNode?.type === "ValueChainLink"
    ? relations.map(membership).find((item) => item?.linkId === initialNode.id)?.chainId ?? ""
    : "";
  const [chainLinkIds, setChainLinkIds] = useState<string[]>(initialChainLinkIds);
  const [chainId, setChainId] = useState(initialLinkChainId);
  const [previousLinkIds, setPreviousLinkIds] = useState<string[]>(
    initialNode?.type === "ValueChainLink"
      ? relations.filter((edge) => edge.type === "precedes" && edge.target === initialNode.id).map((edge) => edge.source)
      : []
  );
  const [nextLinkIds, setNextLinkIds] = useState<string[]>(
    initialNode?.type === "ValueChainLink"
      ? relations.filter((edge) => edge.type === "precedes" && edge.source === initialNode.id).map((edge) => edge.target)
      : []
  );
  const [linkKpiIds, setLinkKpiIds] = useState<string[]>(
    initialNode?.type === "ValueChainLink"
      ? unique(relations.map(canonicalKpiLink).filter((item) => item?.linkId === initialNode.id).map((item) => item!.kpiId))
      : []
  );
  const [relatedLinkIds, setRelatedLinkIds] = useState<string[]>(
    initialNode && ["PrincipalAgent", "AuxiliaryAgent", "SupportAgent"].includes(initialNode.type)
      ? unique(relations.map(canonicalAgentLink).filter((item) => item?.agentId === initialNode.id).map((item) => item!.linkId))
      : []
  );
  const [agentKpiIds, setAgentKpiIds] = useState<string[]>(
    initialNode && ["PrincipalAgent", "AuxiliaryAgent", "SupportAgent"].includes(initialNode.type)
      ? unique(relations.map(canonicalAgentKpi).filter((item) => item?.agentId === initialNode.id).map((item) => item!.kpiId))
      : []
  );
  const [kpiComponentIds, setKpiComponentIds] = useState<string[]>(
    initialNode?.type === "KPI"
      ? unique(relations.map(canonicalComponentKpi).filter((item) => item?.kpiId === initialNode.id).map((item) => item!.componentId))
      : []
  );
  const [kpiAgentIds, setKpiAgentIds] = useState<string[]>(
    initialNode?.type === "KPI"
      ? unique(relations.map(canonicalAgentKpi).filter((item) => item?.kpiId === initialNode.id).map((item) => item!.agentId))
      : []
  );
  const [kpiLinkIds, setKpiLinkIds] = useState<string[]>(
    initialNode?.type === "KPI"
      ? unique(relations.map(canonicalKpiLink).filter((item) => item?.kpiId === initialNode.id).map((item) => item!.linkId))
      : []
  );
  const [error, setError] = useState("");
  const isAgent = ["PrincipalAgent", "AuxiliaryAgent", "SupportAgent"].includes(type);
  const links = nodes.filter((node) => node.type === "ValueChainLink" && node.id !== initialNode?.id);
  const chains = nodes.filter((node) => node.type === "ValueChain");
  const chainForLink = new Map(
    relations.map(membership).filter((item): item is { chainId: string; linkId: string } => Boolean(item))
      .map((item) => [item.linkId, item.chainId])
  );
  const selectableChainLinks = links.filter((link) => {
    const assignedChain = chainForLink.get(link.id);
    return !assignedChain || assignedChain === initialNode?.id;
  });
  const orderableLinks = links.filter((link) => chainForLink.get(link.id) === chainId);
  const scopes = nodes.filter((node) => node.type === "Scope");
  const components = nodes.filter((node) => node.type === "Component" && node.id !== initialNode?.id);
  const kpis = nodes.filter((node) => node.type === "KPI");
  const agents = nodes.filter((node) => ["PrincipalAgent", "AuxiliaryAgent", "SupportAgent"].includes(node.type));
  const targets = creationTargets(type, nodes);
  const selectedTarget = targets.find((item) => item.node.id === targetId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const payload: NodePayload = { type, name, description };
    if (type === "KPI") {
      payload.definition = definition;
      payload.unit_iri = unitIri;
    }
    if (type === "SupportAgent") {
      payload.support_agent_subtype = supportAgentSubtype;
    }
    if (!editing && isAgent && relatedLinkIds.length) {
      payload.parent = {
        parent_id: relatedLinkIds[0],
        relation: type === "PrincipalAgent" ? "belongsTo" : "participatesInValueChainLink"
      };
    }
    if (!editing && type === "ValueChainLink" && chainId) {
      payload.parent = { parent_id: chainId, relation: "hasValueChainLink" };
    }
    if (!editing && type === "Component") {
      const parentId = scopeIds[0] ?? supercomponentIds[0];
      if (parentId) {
        payload.parent = {
          parent_id: parentId,
          relation: scopeIds.length ? "hasComponent" : "hasSubcomponent"
        };
      }
    }
    try {
      if (initialNode) {
        const { type: _type, parent: _parent, ...changes } = payload;
        await api.updateNode(initialNode.id, changes);
        const desired: { source: string; target: string; type: RelationType }[] = [];
        if (type === "ValueChain") {
          chainLinkIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "hasValueChainLink" }));
        }
        if (type === "ValueChainLink") {
          desired.push({ source: chainId, target: initialNode.id, type: "hasValueChainLink" });
          previousLinkIds.forEach((id) => desired.push({ source: id, target: initialNode.id, type: "precedes" }));
          nextLinkIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "precedes" }));
          linkKpiIds.forEach((id) => desired.push({ source: id, target: initialNode.id, type: "appliesToValueChainLink" }));
        }
        if (type === "Scope") {
          scopeComponentIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "hasComponent" }));
        }
        if (type === "Component") {
          scopeIds.forEach((id) => desired.push({ source: id, target: initialNode.id, type: "hasComponent" }));
          supercomponentIds.forEach((id) => desired.push({ source: id, target: initialNode.id, type: "hasSubcomponent" }));
          subcomponentIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "hasSubcomponent" }));
          componentKpiIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "hasKPI" }));
        }
        if (isAgent) {
          relatedLinkIds.forEach((id) => desired.push({
            source: initialNode.id,
            target: id,
            type: type === "PrincipalAgent" ? "belongsTo" : "participatesInValueChainLink"
          }));
          agentKpiIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "hasAssociatedKPI" }));
        }
        if (type === "KPI") {
          kpiComponentIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "appliesToComponent" }));
          kpiAgentIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "appliesToAgent" }));
          kpiLinkIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "appliesToValueChainLink" }));
        }
        if (["ValueChain", "ValueChainLink", "Scope", "Component", "KPI"].includes(type) || isAgent) {
          const relevant = (edge: GraphRelation) => {
            const item = membership(edge);
            const scopeComponent = canonicalScopeComponent(edge);
            const hierarchy = canonicalComponentHierarchy(edge);
            const componentKpi = canonicalComponentKpi(edge);
            return (
              (type === "ValueChain" && item?.chainId === initialNode.id) ||
              (type === "ValueChainLink" && (item?.linkId === initialNode.id ||
                canonicalKpiLink(edge)?.linkId === initialNode.id ||
                (edge.type === "precedes" && (edge.source === initialNode.id || edge.target === initialNode.id)))) ||
              (type === "Scope" && scopeComponent?.scopeId === initialNode.id) ||
              (type === "Component" && (
                scopeComponent?.componentId === initialNode.id ||
                hierarchy?.superId === initialNode.id ||
                hierarchy?.subId === initialNode.id ||
                componentKpi?.componentId === initialNode.id
              )) ||
              (isAgent && (
                canonicalAgentLink(edge)?.agentId === initialNode.id ||
                canonicalAgentKpi(edge)?.agentId === initialNode.id
              )) ||
              (type === "KPI" && (
                canonicalComponentKpi(edge)?.kpiId === initialNode.id ||
                canonicalAgentKpi(edge)?.kpiId === initialNode.id ||
                canonicalKpiLink(edge)?.kpiId === initialNode.id
              ))
            );
          };
          const current = relations.filter((edge) => edge.editable && relevant(edge));
          const currentIncludingReadOnly = relations.filter(relevant);
          const normalized = (edge: { source: string; target: string; type: RelationType }) => {
            const item = membership(edge);
            const scopeComponent = canonicalScopeComponent(edge);
            const hierarchy = canonicalComponentHierarchy(edge);
            const componentKpi = canonicalComponentKpi(edge);
            const agentLink = canonicalAgentLink(edge);
            const agentKpi = canonicalAgentKpi(edge);
            const kpiLink = canonicalKpiLink(edge);
            if (item) return `${item.chainId}|${item.linkId}|membership`;
            if (scopeComponent) return `${scopeComponent.scopeId}|${scopeComponent.componentId}|scope-component`;
            if (hierarchy) return `${hierarchy.superId}|${hierarchy.subId}|component-hierarchy`;
            if (componentKpi) return `${componentKpi.componentId}|${componentKpi.kpiId}|component-kpi`;
            if (agentLink) return `${agentLink.agentId}|${agentLink.linkId}|agent-link`;
            if (agentKpi) return `${agentKpi.agentId}|${agentKpi.kpiId}|agent-kpi`;
            if (kpiLink) return `${kpiLink.kpiId}|${kpiLink.linkId}|kpi-link`;
            return `${edge.source}|${edge.target}|${edge.type}`;
          };
          const desiredKeys = new Set(desired.map(normalized));
          const currentKeys = new Set(currentIncludingReadOnly.map(normalized));
          for (const edge of current) {
            if (!desiredKeys.has(normalized(edge))) await api.deleteRelation(edge);
          }
          for (const edge of desired) {
            if (!currentKeys.has(normalized(edge))) await api.createRelation(edge);
          }
        }
      } else {
        const created = await api.createNode(payload);
        const relations: { source: string; target: string; type: RelationType }[] = [];
        if (type === "ValueChain") {
          chainLinkIds.forEach((id) => relations.push({ source: created.id, target: id, type: "hasValueChainLink" }));
        }
        if (type === "Scope") {
          scopeComponentIds.forEach((id) => relations.push({ source: created.id, target: id, type: "hasComponent" }));
        }
        scopeIds.slice(payload.parent?.relation === "hasComponent" ? 1 : 0)
          .forEach((id) => relations.push({ source: id, target: created.id, type: "hasComponent" }));
        supercomponentIds.slice(payload.parent?.relation === "hasSubcomponent" ? 1 : 0)
          .forEach((id) => relations.push({ source: id, target: created.id, type: "hasSubcomponent" }));
        subcomponentIds.forEach((id) => relations.push({ source: created.id, target: id, type: "hasSubcomponent" }));
        componentKpiIds.forEach((id) => relations.push({ source: created.id, target: id, type: "hasKPI" }));
        previousLinkIds.forEach((id) => relations.push({ source: id, target: created.id, type: "precedes" }));
        nextLinkIds.forEach((id) => relations.push({ source: created.id, target: id, type: "precedes" }));
        linkKpiIds.forEach((id) => relations.push({ source: id, target: created.id, type: "appliesToValueChainLink" }));
        relatedLinkIds.slice(payload.parent ? 1 : 0).forEach((id) => relations.push({
          source: created.id,
          target: id,
          type: type === "PrincipalAgent" ? "belongsTo" : "participatesInValueChainLink"
        }));
        agentKpiIds.forEach((id) => relations.push({ source: created.id, target: id, type: "hasAssociatedKPI" }));
        if (type === "KPI") {
          kpiComponentIds.forEach((id) => relations.push({ source: created.id, target: id, type: "appliesToComponent" }));
          kpiAgentIds.forEach((id) => relations.push({ source: created.id, target: id, type: "appliesToAgent" }));
          kpiLinkIds.forEach((id) => relations.push({ source: created.id, target: id, type: "appliesToValueChainLink" }));
        }
        await Promise.all(relations.map((relation) => api.createRelation(relation)));
      }
      await onCreated();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `No se pudo ${editing ? "editar" : "crear"} la entidad`);
    }
  }

  return (
    <div className="overlay">
      <form className="dialog" onSubmit={submit}>
        <div className="dialog-title">
          <div>
            <strong>{editing ? "Editar" : "Crear"} {typeInfo[type].label.toLowerCase()}</strong>
            <span>{typeInfo[type].description} Solo se muestran los campos compatibles.</span>
          </div>
          <button type="button" className="icon" onClick={onClose}><X /></button>
        </div>
        <label htmlFor="new-name">Nombre</label>
        <input id="new-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        {type === "Scope" || type === "Component" || type === "ValueChain" || type === "ValueChainLink" ? (
          <>
            <label htmlFor="new-description">Descripción</label>
            <textarea id="new-description" required value={description} onChange={(e) => setDescription(e.target.value)} />
          </>
        ) : type === "KPI" ? (
          <>
            <label htmlFor="new-definition">Definición</label>
            <textarea id="new-definition" required value={definition} onChange={(e) => setDefinition(e.target.value)} />
            <UnitSelect units={units} value={unitIri} onChange={setUnitIri} />
          </>
        ) : (
          <>
            <label htmlFor="new-description">Descripción</label>
            <textarea id="new-description" required value={description} onChange={(e) => setDescription(e.target.value)} />
            {isAgent && !editing && (
              <label>Tipo de agente
                <select value={type} onChange={(e) => setType(e.target.value as NodeType)}>
                  <option value="PrincipalAgent">Principal</option>
                  <option value="AuxiliaryAgent">Auxiliar</option>
                  <option value="SupportAgent">Apoyo</option>
                </select>
              </label>
            )}
            {type === "SupportAgent" && (
              <label>Tipo de agente de apoyo
                <select
                  value={supportAgentSubtype}
                  onChange={(e) => setSupportAgentSubtype(e.target.value as SupportAgentSubtype)}
                >
                  {(Object.keys(supportAgentSubtypeLabels) as SupportAgentSubtype[]).map((subtype) => (
                    <option value={subtype} key={subtype}>{supportAgentSubtypeLabels[subtype]}</option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        {type === "Scope" && (
          <MultiNodeSelect label="Componentes" options={components} selected={scopeComponentIds} onChange={setScopeComponentIds} placeholder="Buscar y añadir componentes..." />
        )}
        {type === "Component" && <>
          <MultiNodeSelect label="Ámbitos" options={scopes} selected={scopeIds} onChange={setScopeIds} placeholder="Buscar y añadir ámbitos..." />
          <MultiNodeSelect label="Supercomponentes" options={components} selected={supercomponentIds} onChange={setSupercomponentIds} placeholder="Buscar y añadir supercomponentes..." />
          <MultiNodeSelect label="Subcomponentes" options={components} selected={subcomponentIds} onChange={setSubcomponentIds} placeholder="Buscar y añadir subcomponentes..." />
          <MultiNodeSelect label="KPI" options={kpis} selected={componentKpiIds} onChange={setComponentKpiIds} placeholder="Buscar y añadir KPI..." />
        </>}
        {type === "ValueChain" && (
          <MultiNodeSelect label="Eslabones de la cadena" options={selectableChainLinks} selected={chainLinkIds} onChange={setChainLinkIds} placeholder="Buscar y añadir varios eslabones..." />
        )}
        {type === "ValueChainLink" && <>
          <label>Cadena de valor
            <select required value={chainId} onChange={(e) => {
              setChainId(e.target.value);
              setPreviousLinkIds([]);
              setNextLinkIds([]);
            }}>
              <option value="">Selecciona la cadena a la que pertenece</option>
              {chains.map((chain) => <option value={chain.id} key={chain.id}>{chain.name}</option>)}
            </select>
          </label>
          <MultiNodeSelect label="Eslabones anteriores" options={orderableLinks} selected={previousLinkIds} onChange={setPreviousLinkIds} placeholder="Buscar y añadir eslabones anteriores..." />
          <MultiNodeSelect label="Eslabones siguientes" options={orderableLinks} selected={nextLinkIds} onChange={setNextLinkIds} placeholder="Buscar y añadir eslabones siguientes..." />
          <MultiNodeSelect label="KPI asociados" options={kpis} selected={linkKpiIds} onChange={setLinkKpiIds} placeholder="Buscar y añadir KPI..." />
        </>}
        {isAgent && (
          <MultiNodeSelect label="Eslabones relacionados" options={links} selected={relatedLinkIds} onChange={setRelatedLinkIds} placeholder="Buscar y añadir eslabones..." />
        )}
        {isAgent && (
          <MultiNodeSelect label="KPI asociados" options={kpis} selected={agentKpiIds} onChange={setAgentKpiIds} placeholder="Buscar y añadir KPI..." />
        )}
        {type === "KPI" && <>
          <MultiNodeSelect label="Componentes" options={components} selected={kpiComponentIds} onChange={setKpiComponentIds} placeholder="Buscar y añadir componentes..." />
          <MultiNodeSelect label="Agentes" options={agents} selected={kpiAgentIds} onChange={setKpiAgentIds} placeholder="Buscar y añadir agentes..." />
          <MultiNodeSelect label="Eslabones" options={links} selected={kpiLinkIds} onChange={setKpiLinkIds} placeholder="Buscar y añadir eslabones..." />
        </>}
        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={
            (type === "ValueChainLink" && !chainId)
          }>
            {editing ? "Guardar cambios" : `Crear ${typeInfo[type].label.toLowerCase()}`}
          </button>
        </div>
      </form>
    </div>
  );
}

function RelationDialog({
  nodes,
  relations,
  canManageValueChain,
  initialSource,
  onClose,
  onCreated
}: {
  nodes: GraphNode[];
  relations: Snapshot["relations"];
  canManageValueChain: boolean;
  initialSource: string | null;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [sourceId, setSourceId] = useState(initialSource ?? "");
  const [targetId, setTargetId] = useState("");
  const [relation, setRelation] = useState<RelationType>("similarTo");
  const [error, setError] = useState("");
  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  let allowed = allowedRelations(source, target);
  if (!canManageValueChain) {
    allowed = allowed.filter((item) =>
      !["hasValueChainLink", "isValueChainLinkOf", "precedes"].includes(item)
    );
  }

  useEffect(() => {
    if (allowed.length) setRelation(allowed[0]);
  }, [sourceId, targetId, allowed.join("|")]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.createRelation({ source: sourceId, target: targetId, type: relation });
      await onCreated();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo crear la relación");
    }
  }

  return (
    <div className="overlay">
      <form className="dialog compact" onSubmit={submit}>
        <div className="dialog-title">
          <div><strong>Nueva relación</strong><span>Se guardará en tu grafo personal.</span></div>
          <button type="button" className="icon" onClick={onClose}><X /></button>
        </div>
        <label>Origen
          <select required value={sourceId} onChange={(e) => { setSourceId(e.target.value); setTargetId(""); }}>
            <option value="">Selecciona el origen</option>
            {nodes.map((node) => <option value={node.id} key={node.id}>{node.name} · {typeInfo[node.type].label}</option>)}
          </select>
        </label>
        <label>Destino
          <select required value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">Selecciona el destino</option>
            {nodes.filter((node) => node.id !== sourceId).map((node) => (
              <option value={node.id} key={node.id}>{node.name} · {typeInfo[node.type].label}</option>
            ))}
          </select>
        </label>
        <label>Relación permitida
          <select disabled={!allowed.length} value={relation} onChange={(e) => setRelation(e.target.value as RelationType)}>
            {!allowed.length && <option>No existe una relación válida</option>}
            {allowed.map((item) => <option value={item} key={item}>{relationLabels[item]}</option>)}
          </select>
        </label>
        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={!allowed.length}>Crear relación</button>
        </div>
      </form>
    </div>
  );
}

function PasswordDialog({
  onClose,
  onChanged
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmation) {
      setError("Las nuevas contraseñas no coinciden");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.changePassword({
        current_password: currentPassword,
        new_password: newPassword
      });
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo cambiar la contraseña");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay">
      <form className="dialog compact" onSubmit={submit}>
        <div className="dialog-title">
          <div><strong>Cambiar contraseña</strong><span>Se cerrarán todas las sesiones activas.</span></div>
          <button type="button" className="icon" onClick={onClose}><X /></button>
        </div>
        <label>Contraseña actual
          <input type="password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </label>
        <label>Nueva contraseña
          <input type="password" minLength={8} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </label>
        <label>Repetir nueva contraseña
          <input type="password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={saving || newPassword.length < 8}>
            <KeyRound /> {saving ? "Guardando…" : "Cambiar contraseña"}
          </button>
        </div>
      </form>
    </div>
  );
}

function UserAdminDialog({
  currentUser,
  users,
  onClose,
  onChanged
}: {
  currentUser: User;
  users: User[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("normal");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.createUser({
        username,
        display_name: displayName,
        password,
        role
      });
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRole("normal");
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo crear el usuario");
    } finally {
      setSaving(false);
    }
  }

  async function remove(person: User) {
    if (!window.confirm(`¿Eliminar definitivamente la cuenta «${person.display_name}», todo su grafo y las relaciones que apuntan a sus nodos?`)) return;
    setError("");
    try {
      await api.deleteUser(person.id);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo eliminar el usuario");
    }
  }

  return (
    <div className="overlay">
      <section className="dialog user-admin-dialog">
        <div className="dialog-title">
          <div><strong>Administrar usuarios</strong><span>Al borrar una cuenta también se elimina todo su grafo.</span></div>
          <button type="button" className="icon" onClick={onClose}><X /></button>
        </div>
        <form className="user-create-form" onSubmit={create}>
          <label>Usuario
            <input pattern="[A-Za-z0-9._-]+" minLength={3} required value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>Nombre visible
            <input minLength={2} required value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label>Contraseña inicial
            <input
              type="password"
              minLength={8}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Mínimo 8 caracteres"
            />
          </label>
          <label>Tipo de cuenta
            <select value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
              <option value="normal">Normal · Ámbitos, componentes, agentes y KPI</option>
              <option value="special">Especial · También crea cadenas y eslabones</option>
              <option value="admin">Administrador · Gestión completa y usuarios</option>
            </select>
          </label>
          <button className="primary" disabled={saving || password.length < 8}>
            <UserPlus /> {saving ? "Creando…" : "Crear usuario"}
          </button>
        </form>
        {error && <div className="error">{error}</div>}
        <div className="user-admin-list">
          {users.map((person) => (
            <div className="user-admin-row" key={person.id}>
              <b>{person.initials}</b>
              <span><strong>{person.display_name}</strong><small>@{person.username} · {roleLabels[person.role]}</small></span>
              <button
                type="button"
                className="icon-danger"
                disabled={person.id === currentUser.id}
                title={person.id === currentUser.id ? "La cuenta ORCA no puede eliminarse" : "Eliminar usuario"}
                onClick={() => remove(person)}
              >
                <Trash2 />
              </button>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cerrar</button>
        </div>
      </section>
    </div>
  );
}

type DataSection = "ValueChain" | "ValueChainLink" | "Scope" | "Component" | "Agent" | "KPI";

const dataSections: { id: DataSection; label: string }[] = [
  { id: "ValueChain", label: "Cadena de valor" },
  { id: "ValueChainLink", label: "Eslabón" },
  { id: "Scope", label: "Ámbito" },
  { id: "Component", label: "Componente" },
  { id: "Agent", label: "Agente" },
  { id: "KPI", label: "KPI" }
];

function DataWorkspace({
  snapshot,
  user,
  onSelect,
  onCreateNode,
  onEditNode,
  onDeleteNode
}: {
  snapshot: Snapshot;
  user: User;
  onSelect: (id: string) => void;
  onCreateNode: (type: NodeType) => void;
  onEditNode: (node: GraphNode) => void;
  onDeleteNode: (node: GraphNode) => void;
}) {
  const [section, setSection] = useState<DataSection>("Scope");
  const [query, setQuery] = useState("");
  const [ownership, setOwnership] = useState<"all" | "mine" | "others">("all");
  const agents: NodeType[] = ["PrincipalAgent", "AuxiliaryAgent", "SupportAgent"];
  const nodes = snapshot.nodes.filter((node) => {
    const inSection =
      section === "Agent" ? agents.includes(node.type) : node.type === section;
    const ownerMatch =
      ownership === "all" ||
      (ownership === "mine" ? node.owner_id === user.id : node.owner_id !== user.id);
    return inSection && ownerMatch &&
      `${node.name} ${node.description} ${node.definition ?? ""} ${node.owner_name}`
        .toLowerCase().includes(query.toLowerCase());
  });
  const count = nodes.length;
  const namesForIds = (ids: string[]) => [...new Set(ids)]
    .map((id) => snapshot.nodes.find((node) => node.id === id)?.name)
    .filter((name): name is string => Boolean(name))
    .sort((left, right) => left.localeCompare(right, "es"));
  const valueChainLinkNames = (chainId: string) => {
    const linkIds = snapshot.relations.flatMap((edge) => {
      if (edge.type === "hasValueChainLink" && edge.source === chainId) return [edge.target];
      if (edge.type === "isValueChainLinkOf" && edge.target === chainId) return [edge.source];
      return [];
    });
    return namesForIds(linkIds);
  };
  const valueChainName = (linkId: string) => {
    const chainIds = snapshot.relations.flatMap((edge) => {
      if (edge.type === "hasValueChainLink" && edge.target === linkId) return [edge.source];
      if (edge.type === "isValueChainLinkOf" && edge.source === linkId) return [edge.target];
      return [];
    });
    return namesForIds(chainIds)[0];
  };
  const previousLinkNames = (linkId: string) => namesForIds(
    snapshot.relations
      .filter((edge) => edge.type === "precedes" && edge.target === linkId)
      .map((edge) => edge.source)
  );
  const nextLinkNames = (linkId: string) => namesForIds(
    snapshot.relations
      .filter((edge) => edge.type === "precedes" && edge.source === linkId)
      .map((edge) => edge.target)
  );
  const linkKpiNames = (linkId: string) => namesForIds(
    snapshot.relations
      .filter((edge) => edge.type === "appliesToValueChainLink" && edge.target === linkId)
      .map((edge) => edge.source)
  );
  const scopeComponentNames = (scopeId: string) => namesForIds(
    snapshot.relations.flatMap((edge) => {
      if (edge.type === "hasComponent" && edge.source === scopeId) return [edge.target];
      if (edge.type === "isComponentOf" && edge.target === scopeId) return [edge.source];
      return [];
    })
  );
  const componentScopeNames = (componentId: string) => namesForIds(
    snapshot.relations.flatMap((edge) => {
      if (edge.type === "hasComponent" && edge.target === componentId) return [edge.source];
      if (edge.type === "isComponentOf" && edge.source === componentId) return [edge.target];
      return [];
    })
  );
  const supercomponentNames = (componentId: string) => namesForIds(
    snapshot.relations.flatMap((edge) => {
      if (edge.type === "hasSubcomponent" && edge.target === componentId) return [edge.source];
      if (edge.type === "hasSupercomponent" && edge.source === componentId) return [edge.target];
      return [];
    })
  );
  const subcomponentNames = (componentId: string) => namesForIds(
    snapshot.relations.flatMap((edge) => {
      if (edge.type === "hasSubcomponent" && edge.source === componentId) return [edge.target];
      if (edge.type === "hasSupercomponent" && edge.target === componentId) return [edge.source];
      return [];
    })
  );
  const componentKpiNames = (componentId: string) => namesForIds(
    snapshot.relations.flatMap((edge) => {
      if (edge.type === "hasKPI" && edge.source === componentId) return [edge.target];
      if (edge.type === "appliesToComponent" && edge.target === componentId) return [edge.source];
      return [];
    })
  );
  const agentLinkNames = (agentId: string) => namesForIds(
    snapshot.relations.flatMap((edge) => {
      if ((edge.type === "belongsTo" || edge.type === "participatesInValueChainLink") && edge.source === agentId) return [edge.target];
      if ((edge.type === "hasPrincipalAgent" || edge.type === "hasParticipatingAgent") && edge.target === agentId) return [edge.source];
      return [];
    })
  );
  const agentKpiNames = (agentId: string) => namesForIds(
    snapshot.relations.flatMap((edge) => {
      if (edge.type === "hasAssociatedKPI" && edge.source === agentId) return [edge.target];
      if (edge.type === "appliesToAgent" && edge.target === agentId) return [edge.source];
      return [];
    })
  );
  const kpiComponentNames = (kpiId: string) => namesForIds(
    snapshot.relations.flatMap((edge) => {
      if (edge.type === "appliesToComponent" && edge.source === kpiId) return [edge.target];
      if (edge.type === "hasKPI" && edge.target === kpiId) return [edge.source];
      return [];
    })
  );
  const kpiAgentNames = (kpiId: string) => namesForIds(
    snapshot.relations.flatMap((edge) => {
      if (edge.type === "appliesToAgent" && edge.source === kpiId) return [edge.target];
      if (edge.type === "hasAssociatedKPI" && edge.target === kpiId) return [edge.source];
      return [];
    })
  );
  const kpiLinkNames = (kpiId: string) => namesForIds(
    snapshot.relations
      .filter((edge) => edge.type === "appliesToValueChainLink" && edge.source === kpiId)
      .map((edge) => edge.target)
  );
  const renderNamePills = (names: string[]) => names.length ? (
    <span className="entity-pills">
      {names.map((name, index) => (
        <span className="entity-pill-item" key={`${name}-${index}`}>
          <span className="entity-pill">{name}</span>
          {index < names.length - 1 && <span className="entity-pill-comma">,</span>}
        </span>
      ))}
    </span>
  ) : "—";
  const renderNamePill = (name?: string) => name ? renderNamePills([name]) : "—";
  const creationActions: { type: NodeType; label: string }[] =
    section === "Scope" ? [{ type: "Scope", label: "Crear ámbito" }] :
    section === "Component" ? [{ type: "Component", label: "Crear componente" }] :
    section === "KPI" ? [{ type: "KPI", label: "Crear KPI" }] :
    section === "Agent" ? [{ type: "PrincipalAgent", label: "Crear agente" }] :
    section === "ValueChain" && canManageValueChains(user) ? [{ type: "ValueChain", label: "Crear cadena" }] :
    section === "ValueChainLink" && canManageValueChains(user) ? [{ type: "ValueChainLink", label: "Crear eslabón" }] :
    [];

  function exportExcel() {
    const workbook = XLSX.utils.book_new();
    const byType = (types: NodeType[]) => snapshot.nodes.filter((node) => types.includes(node.type));
    const join = (values: string[]) => values.join(", ");
    const sheets: { name: string; rows: Record<string, string>[] }[] = [
      {
        name: "Cadenas",
        rows: byType(["ValueChain"]).map((node) => ({
          Nombre: node.name,
          Descripción: node.description,
          Eslabones: join(valueChainLinkNames(node.id)),
          Autor: node.owner_name
        }))
      },
      {
        name: "Eslabones",
        rows: byType(["ValueChainLink"]).map((node) => ({
          Nombre: node.name,
          Descripción: node.description,
          Cadena: valueChainName(node.id) ?? "",
          "Eslabones anteriores": join(previousLinkNames(node.id)),
          "Eslabones posteriores": join(nextLinkNames(node.id)),
          KPI: join(linkKpiNames(node.id)),
          Autor: node.owner_name
        }))
      },
      {
        name: "Ámbitos",
        rows: byType(["Scope"]).map((node) => ({
          Nombre: node.name,
          Descripción: node.description,
          Componentes: join(scopeComponentNames(node.id)),
          Autor: node.owner_name
        }))
      },
      {
        name: "Componentes",
        rows: byType(["Component"]).map((node) => ({
          Nombre: node.name,
          Descripción: node.description,
          Ámbitos: join(componentScopeNames(node.id)),
          Supercomponentes: join(supercomponentNames(node.id)),
          Subcomponentes: join(subcomponentNames(node.id)),
          KPI: join(componentKpiNames(node.id)),
          Autor: node.owner_name
        }))
      },
      {
        name: "Agentes",
        rows: byType(agents).map((node) => ({
          Nombre: node.name,
          Descripción: node.description,
          Eslabones: join(agentLinkNames(node.id)),
          KPI: join(agentKpiNames(node.id)),
          Autor: node.owner_name
        }))
      },
      {
        name: "KPI",
        rows: byType(["KPI"]).map((node) => ({
          Nombre: node.name,
          Definición: node.definition ?? "",
          Componentes: join(kpiComponentNames(node.id)),
          Agentes: join(kpiAgentNames(node.id)),
          Eslabones: join(kpiLinkNames(node.id)),
          Autor: node.owner_name
        }))
      }
    ];
    const headers: Record<string, string[]> = {
      Cadenas: ["Nombre", "Descripción", "Eslabones", "Autor"],
      Eslabones: ["Nombre", "Descripción", "Cadena", "Eslabones anteriores", "Eslabones posteriores", "KPI", "Autor"],
      Ámbitos: ["Nombre", "Descripción", "Componentes", "Autor"],
      Componentes: ["Nombre", "Descripción", "Ámbitos", "Supercomponentes", "Subcomponentes", "KPI", "Autor"],
      Agentes: ["Nombre", "Descripción", "Eslabones", "KPI", "Autor"],
      KPI: ["Nombre", "Definición", "Componentes", "Agentes", "Eslabones", "Autor"]
    };
    sheets.forEach(({ name, rows }) => {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, { header: headers[name] }), name);
    });
    const entityLabels: Record<NodeType, string> = {
      ValueChain: "Cadena de valor",
      ValueChainLink: "Eslabón",
      Scope: "Ámbito",
      Component: "Componente",
      PrincipalAgent: "Agente",
      AuxiliaryAgent: "Agente",
      SupportAgent: "Agente",
      KPI: "KPI"
    };
    const iriRows = snapshot.nodes.map((node) => ({
      Entidad: entityLabels[node.type],
      Nombre: node.name,
      IRI: node.id
    }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(iriRows, { header: ["Entidad", "Nombre", "IRI"] }), "IRIs");
    XLSX.writeFile(workbook, `orca-graph-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <section className="data-workspace">
      <aside className="data-nav">
        <span className="section-label">Modelo de datos</span>
        {dataSections.map((item) => (
          <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}>
            {item.label}
          </button>
        ))}
        <span className="data-nav-divider">Exportación</span>
        <button className="export-tables" onClick={exportExcel}>
          <FileSpreadsheet /> Exportar tablas a Excel
        </button>
      </aside>
      <div className="data-content">
        <div className="data-heading">
          <div><span>VISTA DE DATOS</span><h1>{dataSections.find((item) => item.id === section)?.label}</h1>
            <p>Consulta datos propios y ajenos sobre el mismo RDF colaborativo.</p></div>
          <div className="creation-actions">
            {creationActions.map((action) => (
              <button className="primary" onClick={() => onCreateNode(action.type)} key={action.type}>
                <Plus /> {action.label}
              </button>
            ))}
          </div>
        </div>
        <div className="data-summary">
          <div><span>Resultados</span><strong>{count}</strong></div>
          <div><span>Propios</span><strong>{nodes.filter((node) => node.owner_id === user.id).length}</strong></div>
          <div><span>Reutilizables</span><strong>{nodes.filter((node) => node.owner_id !== user.id).length}</strong></div>
        </div>
        <div className="data-card">
          <div className="data-toolbar">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nombre, descripción o autor…" />
            <div className="segmented">
              <button className={ownership === "all" ? "active" : ""} onClick={() => setOwnership("all")}>Todos</button>
              <button className={ownership === "mine" ? "active" : ""} onClick={() => setOwnership("mine")}>Mis datos</button>
              <button className={ownership === "others" ? "active" : ""} onClick={() => setOwnership("others")}>Otros usuarios</button>
            </div>
          </div>
          <div className="data-table-wrap">
            {section === "ValueChain" ? (
              <table><thead><tr><th>Nombre</th><th>Descripción</th><th>Eslabones</th><th>Autor</th><th>Acciones</th></tr></thead>
                <tbody>{nodes.map((node) => <tr key={node.id} className={node.editable ? "mine-row" : ""}>
                  <td><strong>{node.name}</strong></td>
                  <td>{node.description || "—"}</td>
                  <td>{renderNamePills(valueChainLinkNames(node.id))}</td>
                  <td>{node.owner_name}{node.editable && <b className="mine-tag">Tuyo</b>}</td>
                  <td><div className="table-actions">
                    <button className="table-action" onClick={() => onSelect(node.id)}>Ver grafo</button>
                    {node.editable && <>
                      <button className="table-action" onClick={() => onEditNode(node)}><Pencil /> Editar</button>
                      <button className="table-action danger-action" onClick={() => onDeleteNode(node)}><Trash2 /> Borrar</button>
                    </>}
                  </div></td>
                </tr>)}</tbody>
              </table>
            ) : section === "ValueChainLink" ? (
              <table className="value-chain-link-table">
                <thead><tr><th>Nombre</th><th>Descripción</th><th>Cadena</th><th>Eslabones anteriores</th><th>Eslabones posteriores</th><th>KPI</th><th>Autor</th><th>Acciones</th></tr></thead>
                <tbody>{nodes.map((node) => <tr key={node.id} className={node.editable ? "mine-row" : ""}>
                  <td><strong>{node.name}</strong></td>
                  <td>{node.description || "—"}</td>
                  <td>{renderNamePill(valueChainName(node.id))}</td>
                  <td>{renderNamePills(previousLinkNames(node.id))}</td>
                  <td>{renderNamePills(nextLinkNames(node.id))}</td>
                  <td>{renderNamePills(linkKpiNames(node.id))}</td>
                  <td>{node.owner_name}{node.editable && <b className="mine-tag">Tuyo</b>}</td>
                  <td><div className="table-actions">
                    <button className="table-action" onClick={() => onSelect(node.id)}>Ver grafo</button>
                    {node.editable && <>
                      <button className="table-action" onClick={() => onEditNode(node)}><Pencil /> Editar</button>
                      <button className="table-action danger-action" onClick={() => onDeleteNode(node)}><Trash2 /> Borrar</button>
                    </>}
                  </div></td>
                </tr>)}</tbody>
              </table>
            ) : section === "Scope" ? (
              <table><thead><tr><th>Nombre</th><th>Descripción</th><th>Componentes</th><th>Autor</th><th>Acciones</th></tr></thead>
                <tbody>{nodes.map((node) => <tr key={node.id} className={node.editable ? "mine-row" : ""}>
                  <td><strong>{node.name}</strong></td>
                  <td>{node.description || "—"}</td>
                  <td>{renderNamePills(scopeComponentNames(node.id))}</td>
                  <td>{node.owner_name}{node.editable && <b className="mine-tag">Tuyo</b>}</td>
                  <td><div className="table-actions">
                    <button className="table-action" onClick={() => onSelect(node.id)}>Ver grafo</button>
                    {node.editable && <>
                      <button className="table-action" onClick={() => onEditNode(node)}><Pencil /> Editar</button>
                      <button className="table-action danger-action" onClick={() => onDeleteNode(node)}><Trash2 /> Borrar</button>
                    </>}
                  </div></td>
                </tr>)}</tbody>
              </table>
            ) : section === "Component" ? (
              <table className="component-table">
                <thead><tr><th>Nombre</th><th>Descripción</th><th>Ámbitos</th><th>Supercomponentes</th><th>Subcomponentes</th><th>KPI</th><th>Autor</th><th>Acciones</th></tr></thead>
                <tbody>{nodes.map((node) => <tr key={node.id} className={node.editable ? "mine-row" : ""}>
                  <td><strong>{node.name}</strong></td>
                  <td>{node.description || "—"}</td>
                  <td>{renderNamePills(componentScopeNames(node.id))}</td>
                  <td>{renderNamePills(supercomponentNames(node.id))}</td>
                  <td>{renderNamePills(subcomponentNames(node.id))}</td>
                  <td>{renderNamePills(componentKpiNames(node.id))}</td>
                  <td>{node.owner_name}{node.editable && <b className="mine-tag">Tuyo</b>}</td>
                  <td><div className="table-actions">
                    <button className="table-action" onClick={() => onSelect(node.id)}>Ver grafo</button>
                    {node.editable && <>
                      <button className="table-action" onClick={() => onEditNode(node)}><Pencil /> Editar</button>
                      <button className="table-action danger-action" onClick={() => onDeleteNode(node)}><Trash2 /> Borrar</button>
                    </>}
                  </div></td>
                </tr>)}</tbody>
              </table>
            ) : section === "Agent" ? (
              <table className="agent-table">
                <thead><tr><th>Nombre</th><th>Descripción</th><th>Eslabones</th><th>KPI</th><th>Autor</th><th>Acciones</th></tr></thead>
                <tbody>{nodes.map((node) => <tr key={node.id} className={node.editable ? "mine-row" : ""}>
                  <td><strong>{node.name}</strong></td>
                  <td>{node.description || "—"}</td>
                  <td>{renderNamePills(agentLinkNames(node.id))}</td>
                  <td>{renderNamePills(agentKpiNames(node.id))}</td>
                  <td>{node.owner_name}{node.editable && <b className="mine-tag">Tuyo</b>}</td>
                  <td><div className="table-actions">
                    <button className="table-action" onClick={() => onSelect(node.id)}>Ver grafo</button>
                    {node.editable && <>
                      <button className="table-action" onClick={() => onEditNode(node)}><Pencil /> Editar</button>
                      <button className="table-action danger-action" onClick={() => onDeleteNode(node)}><Trash2 /> Borrar</button>
                    </>}
                  </div></td>
                </tr>)}</tbody>
              </table>
            ) : section === "KPI" ? (
              <table className="kpi-table">
                <thead><tr><th>Nombre</th><th>Definición</th><th>Componentes</th><th>Agentes</th><th>Eslabones</th><th>Autor</th><th>Acciones</th></tr></thead>
                <tbody>{nodes.map((node) => <tr key={node.id} className={node.editable ? "mine-row" : ""}>
                  <td><strong>{node.name}</strong></td>
                  <td>{node.definition || "—"}</td>
                  <td>{renderNamePills(kpiComponentNames(node.id))}</td>
                  <td>{renderNamePills(kpiAgentNames(node.id))}</td>
                  <td>{renderNamePills(kpiLinkNames(node.id))}</td>
                  <td>{node.owner_name}{node.editable && <b className="mine-tag">Tuyo</b>}</td>
                  <td><div className="table-actions">
                    <button className="table-action" onClick={() => onSelect(node.id)}>Ver grafo</button>
                    {node.editable && <>
                      <button className="table-action" onClick={() => onEditNode(node)}><Pencil /> Editar</button>
                      <button className="table-action danger-action" onClick={() => onDeleteNode(node)}><Trash2 /> Borrar</button>
                    </>}
                  </div></td>
                </tr>)}</tbody>
              </table>
            ) : (
              <table><thead><tr><th>Nombre</th><th>Descripción / definición</th><th>Relaciones</th><th>Autor</th><th>Acciones</th></tr></thead>
                <tbody>{nodes.map((node) => <tr key={node.id} className={node.editable ? "mine-row" : ""}>
                  <td><strong>{node.name}</strong></td><td>{node.definition || node.description || "—"}</td>
                  <td>{snapshot.relations.filter((edge) => edge.source === node.id || edge.target === node.id).length}</td>
                  <td>{node.owner_name}{node.editable && <b className="mine-tag">Tuyo</b>}</td>
                  <td><div className="table-actions">
                    <button className="table-action" onClick={() => onSelect(node.id)}>Ver grafo</button>
                    {node.editable && <>
                      <button className="table-action" onClick={() => onEditNode(node)}><Pencil /> Editar</button>
                      <button className="table-action danger-action" onClick={() => onDeleteNode(node)}><Trash2 /> Borrar</button>
                    </>}
                  </div></td>
                </tr>)}</tbody>
              </table>
            )}
            {!count && <div className="data-empty">No hay registros que coincidan con los filtros.</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function Workspace({
  user,
  onLogout,
  onPasswordChanged
}: {
  user: User;
  onLogout: () => void;
  onPasswordChanged: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [users, setUsers] = useState<User[]>([]);
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"node" | "relation" | "password" | "users" | null>(null);
  const [editingNode, setEditingNode] = useState<GraphNode | null>(null);
  const [createType, setCreateType] = useState<NodeType>("Scope");
  const [connected, setConnected] = useState(1);
  const [filters, setFilters] = useState<Filters>({ scope: "", user: "", type: "", node: "" });
  const [error, setError] = useState("");
  const [view, setView] = useState<"data" | "graph">("data");

  const load = useCallback(async () => {
    try {
      const [graph, people, unitOptions] = await Promise.all([api.graph(), api.users(), api.units()]);
      setSnapshot(graph);
      setUsers(people);
      setUnits(unitOptions);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo cargar el grafo");
    }
  }, []);

  useEffect(() => {
    load();
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/api/ws`);
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "graph.changed") load();
      if (message.type === "presence.changed") setConnected(message.connected);
    };
    return () => socket.close();
  }, [load]);

  const filtered = useMemo(() => filterGraph(snapshot, filters), [snapshot, filters]);
  const scopes = snapshot.nodes.filter((node) => node.type === "Scope");
  const selectedNode = snapshot.nodes.find((node) => node.id === selected);
  const selectedRelations = snapshot.relations.filter((edge) => edge.source === selected || edge.target === selected);
  const selectedDegree = selectedNode
    ? new Set(
        selectedRelations.map((edge) =>
          edge.source === selectedNode.id ? edge.target : edge.source
        )
      ).size
    : 0;
  const setFilter = (key: keyof Filters, value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const openCreate = (type: NodeType) => {
    setEditingNode(null);
    setCreateType(type);
    setDialog("node");
  };
  const openEdit = (node: GraphNode) => {
    setEditingNode(node);
    setCreateType(node.type);
    setDialog("node");
  };

  async function removeNode(node: GraphNode) {
    if (!window.confirm(`¿Borrar el nodo «${node.name}» y todas tus relaciones conectadas?`)) return;
    try {
      await api.deleteNode(node.id);
      setSelected(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo borrar el nodo");
    }
  }

  async function removeRelation(edge: GraphRelation) {
    const source = snapshot.nodes.find((node) => node.id === edge.source)?.name ?? edge.source;
    const target = snapshot.nodes.find((node) => node.id === edge.target)?.name ?? edge.target;
    if (!window.confirm(`¿Borrar la relación «${source} — ${relationLabels[edge.type]} → ${target}»?`)) return;
    try {
      await api.deleteRelation({ source: edge.source, target: edge.target, type: edge.type });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo borrar la relación");
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <RdfMark />
          <div><strong><em>ORCA</em> Graph</strong><span>Ontology-Restricted Collaborative Authoring of Graphs</span></div>
        </div>
        <nav className="view-tabs" aria-label="Cambiar de vista">
          <button className={view === "data" ? "active" : ""} onClick={() => setView("data")}>▤ Vista de datos</button>
          <button className={view === "graph" ? "active" : ""} onClick={() => setView("graph")}>⌘ Vista de grafo</button>
        </nav>
        <div className="presence"><i /> {connected} colaboradores conectados</div>
        <div className="top-actions">
          <div className="user-area">
            <b>{user.initials}</b>
            <span className="user-identity"><strong>{user.display_name}</strong><small>{roleLabels[user.role]}</small></span>
            <button className="header-action" onClick={() => setDialog("password")} title="Cambiar contraseña"><KeyRound /> Contraseña</button>
            <button className="header-action" onClick={onLogout}><LogOut /> Salir</button>
          </div>
          {isAdmin(user) && (
            <button className="header-action header-action-primary" onClick={() => setDialog("users")}><UserCog /> Usuarios</button>
          )}
        </div>
      </header>

      {view === "data" ? (
        <DataWorkspace
          snapshot={snapshot}
          user={user}
          onSelect={(id) => { setSelected(id); setView("graph"); }}
          onCreateNode={openCreate}
          onEditNode={openEdit}
          onDeleteNode={removeNode}
        />
      ) : <section className="workspace">
        <aside className="sidebar">
          <div className="panel-title"><span>Modelo v7</span><ShieldCheck /></div>
          <div className="type-list">
            {(Object.keys(typeInfo) as NodeType[]).map((type) => (
              <div className={`type-row type-${type.toLowerCase()}`} key={type}>
                <i /><span>{typeInfo[type].label}</span>
                <b>{snapshot.nodes.filter((node) => node.type === type).length}</b>
              </div>
            ))}
          </div>
          <div className="filter-panel">
            <span className="section-label">Filtrar grafo</span>
            <label>Ámbito
              <select value={filters.scope} onChange={(e) => setFilter("scope", e.target.value)}>
                <option value="">Todos los ámbitos</option>
                {scopes.map((scope) => <option value={scope.id} key={scope.id}>{scope.name}</option>)}
              </select>
            </label>
            <label>Usuario
              <select value={filters.user} onChange={(e) => setFilter("user", e.target.value)}>
                <option value="">Todos los usuarios</option>
                {users.map((person) => <option value={person.id} key={person.id}>{person.display_name}</option>)}
              </select>
            </label>
            <label>Tipo de nodo
              <select value={filters.type} onChange={(e) => setFilter("type", e.target.value)}>
                <option value="">Todos los tipos</option>
                {(Object.keys(typeInfo) as NodeType[]).map((type) => <option value={type} key={type}>{typeInfo[type].label}</option>)}
              </select>
            </label>
            <label>Nodo y vecindario
              <select value={filters.node} onChange={(e) => setFilter("node", e.target.value)}>
                <option value="">Todos los nodos</option>
                {snapshot.nodes.map((node) => <option value={node.id} key={node.id}>{node.name}</option>)}
              </select>
            </label>
            <button className="secondary wide" onClick={() => setFilters({ scope: "", user: "", type: "", node: "" })}>
              <FilterX /> Limpiar filtros
            </button>
          </div>
          <div className="rules">
            <span className="section-label">Reglas principales</span>
            <p><b>Ámbito</b><span>→</span>Ámbito</p>
            <p><b>Cadena</b><span>→</span>Eslabón</p>
            <p><b>Principal</b><span>→</span>Eslabón</p>
            <p><b>KPI</b><span>→</span>Eslabón o agente</p>
          </div>
        </aside>

        <section className="canvas">
          <div className="canvas-toolbar">
            <div>
              <span><CircleDot /> {filtered.nodes.length} nodos</span>
              <span><GitBranch /> {filtered.relations.length} relaciones</span>
              <span><Users /> {users.length} autores</span>
            </div>
            <button className="ghost" onClick={load}><Maximize2 /> Actualizar</button>
          </div>
          <GraphCanvas snapshot={filtered} selected={selected} onSelect={setSelected} />
          {error && <div className="toast error">{error}</div>}
        </section>

        <aside className="inspector">
          <div className="panel-title"><span>Inspector</span></div>
          {selectedNode ? (
            <>
              <div className="inspector-head">
                <div className={`inspector-mark type-${selectedNode.type.toLowerCase()}`}><i /></div>
                <span>{typeInfo[selectedNode.type].label}</span>
                <h2>{selectedNode.name}</h2>
                <p>{selectedNode.definition || selectedNode.description || "Sin descripción"}</p>
              </div>
              <div className="metadata">
                <label>Autor</label>
                <div className="author"><b>{selectedNode.owner_initials}</b><span>{selectedNode.owner_name}</span></div>
                <label>Permisos</label>
                <p>{selectedNode.editable ? "Editable por ti" : "Visible en modo lectura"}</p>
                <label>Conectividad</label>
                <p>{selectedDegree} {selectedDegree === 1 ? "nodo vecino" : "nodos vecinos"}</p>
                {selectedNode.unit_label && <><label>Unidad OM</label><p>{selectedNode.unit_label}</p></>}
                {selectedNode.support_agent_subtype && (
                  <><label>Tipo de agente de apoyo</label><p>{supportAgentSubtypeLabels[selectedNode.support_agent_subtype]}</p></>
                )}
                <label>Relaciones</label>
                <div className="relation-list">
                  {selectedRelations.map((edge, index) => {
                    const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
                    const other = snapshot.nodes.find((node) => node.id === otherId);
                    return (
                      <div className="relation-item" key={`${edge.source}-${edge.type}-${edge.target}-${index}`}>
                        <span>{relationLabels[edge.type]} · {other?.name}</span>
                        {edge.editable && (
                          <button
                            type="button"
                            className="icon-danger"
                            title="Borrar relación"
                            aria-label={`Borrar relación con ${other?.name ?? "el nodo"}`}
                            onClick={() => removeRelation(edge)}
                          >
                            <Trash2 />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <label>IRI</label><code>{selectedNode.id}</code>
                <button className="secondary wide" onClick={() => setDialog("relation")}><GitBranch /> Crear relación</button>
                {selectedNode.editable && (
                  <button className="danger wide" onClick={() => removeNode(selectedNode)}>
                    <Trash2 /> Borrar nodo
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="empty-inspector"><CircleDot /><span>Selecciona un nodo para consultar sus propiedades, autoría y relaciones permitidas.</span></div>
          )}
        </aside>
      </section>}

      <footer>
        <a
          className="skai-credit"
          href="https://skai.etsisi.upm.es/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Powered by SKAI Research Group
        </a>
        <div>
          <span className="app-version">ORCA Graph v{APP_VERSION}</span>
          <span><i className="line" /> Relación estructural</span>
          <span><i className="line related" /> Similitud o aplicación</span>
          <span><i className="ownership mine" /> Creado por ti</span>
          <span><i className="ownership foreign" /> Otros autores</span>
          <span>Tamaño = nº de vecinos</span>
        </div>
      </footer>

      {dialog === "node" && <NodeDialog initialType={createType} initialNode={editingNode} nodes={snapshot.nodes} relations={snapshot.relations} units={units} canManageValueChain={canManageValueChains(user)} onClose={() => { setDialog(null); setEditingNode(null); }} onCreated={load} />}
      {dialog === "relation" && <RelationDialog nodes={snapshot.nodes} relations={snapshot.relations} canManageValueChain={canManageValueChains(user)} initialSource={selected} onClose={() => setDialog(null)} onCreated={load} />}
      {dialog === "password" && <PasswordDialog onClose={() => setDialog(null)} onChanged={onPasswordChanged} />}
      {dialog === "users" && <UserAdminDialog currentUser={user} users={users} onClose={() => setDialog(null)} onChanged={load} />}
    </main>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setReady(true));
  }, []);

  async function logout() {
    await api.logout();
    setUser(null);
  }

  if (!ready) return <div className="boot">Cargando ORCA Graph…</div>;
  if (!user) return <Login onLogin={setUser} />;
  return <Workspace user={user} onLogout={logout} onPasswordChanged={() => setUser(null)} />;
}
