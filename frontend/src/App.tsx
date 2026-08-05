import cytoscape, { Core } from "cytoscape";
import {
  CircleDot,
  Copy,
  FilterX,
  GitBranch,
  KeyRound,
  LogOut,
  Maximize2,
  FileSpreadsheet,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserCog,
  UserPlus,
  Users,
  X
} from "lucide-react";
import { FormEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as XLSX from "xlsx";

import {
  api,
  GraphNode,
  GraphRelation,
  NodePayload,
  NodeType,
  OntologyConcept,
  RelationType,
  Snapshot,
  SupportAgentSubtype,
  User,
  UserRole
} from "./api";

const emptySnapshot: Snapshot = { nodes: [], relations: [], current_user_id: "" };
const APP_VERSION = "7.33.0";

function snapshotForChain(snapshot: Snapshot, chainId: string | null): Snapshot {
  if (!chainId) return { ...snapshot, nodes: [], relations: [] };
  const chainIds = new Set(snapshot.nodes.filter((node) => node.type === "ValueChain").map((node) => node.id));
  const explicitlyScoped = snapshot.nodes.filter((node) => node.chain_id === chainId).map((node) => node.id);
  const membershipLinks = snapshot.relations.flatMap((edge) => {
    if (edge.type === "hasValueChainLink" && edge.source === chainId) return [edge.target];
    if (edge.type === "isValueChainLinkOf" && edge.target === chainId) return [edge.source];
    return [];
  });
  const foreignLinks = new Set(snapshot.relations.flatMap((edge) => {
    if (edge.type === "hasValueChainLink" && edge.source !== chainId && chainIds.has(edge.source)) return [edge.target];
    if (edge.type === "isValueChainLinkOf" && edge.target !== chainId && chainIds.has(edge.target)) return [edge.source];
    return [];
  }));
  const visible = new Set<string>([chainId, ...explicitlyScoped, ...membershipLinks]);
  // Compatibility for data created before v7.26: include the connected model of
  // the active chain, but never cross into another chain repository.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of snapshot.relations) {
      const sourceVisible = visible.has(edge.source);
      const targetVisible = visible.has(edge.target);
      const candidate = sourceVisible ? edge.target : targetVisible ? edge.source : null;
      if (candidate && !chainIds.has(candidate) && !foreignLinks.has(candidate) && !visible.has(candidate)) {
        visible.add(candidate);
        changed = true;
      }
    }
  }
  visible.delete(chainId); // The active chain is context, not a graph node.
  const nodes = snapshot.nodes.filter((node) => visible.has(node.id) && node.type !== "ValueChain");
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...snapshot,
    nodes,
    relations: snapshot.relations.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
  };
}

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

function hasSpecialPermissions(user: User) {
  return user.role === "admin" || user.role === "special";
}

const supportAgentSubtypeLabels: Record<SupportAgentSubtype, string> = {
  SupportAgent: "Agente de apoyo (general)",
  ResearchSupportAgent: "Agente de apoyo a la investigación",
  TrainingSupportAgent: "Agente de apoyo formativo",
  GovernmentSupportAgent: "Agente de apoyo gubernamental",
  NationalGovernmentSupportAgent: "Agente gubernamental nacional",
  RegionalGovernmentSupportAgent: "Agente gubernamental regional",
  LocalGovernmentSupportAgent: "Agente gubernamental local"
};

const typeInfo: Record<NodeType, { label: string; description: string }> = {
  Scope: { label: "Ámbito", description: "Área temática que agrupa componentes." },
  Component: { label: "Componente", description: "Elemento jerárquico que agrupa KPI." },
  KPI: { label: "KPI", description: "Indicador aplicado a un agente o componente." },
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
  appliesToAgent: "se aplica al agente",
  appliesToComponent: "se aplica al componente",
  hasKPI: "tiene KPI",
  hasAssociatedKPI: "tiene KPI asociado",
  isRelated: "está relacionado con",
  muevePescadoFresco: "Pescado fresco",
  muevePescadoSeco: "Pescado seco",
  mueveHarinaDePescado: "Harina de pescado",
  financiación: "Financiación"
};

const linkRelationTypes: RelationType[] = [
  "muevePescadoFresco",
  "muevePescadoSeco",
  "mueveHarinaDePescado",
  "financiación"
];

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
    PrincipalAgent: ["appliesToAgent"],
    AuxiliaryAgent: ["appliesToAgent"],
    SupportAgent: ["appliesToAgent"]
  },
  ValueChain: { ValueChainLink: ["hasValueChainLink"] },
  ValueChainLink: {
    ValueChainLink: ["isRelated", "muevePescadoFresco", "muevePescadoSeco", "mueveHarinaDePescado", "financiación"],
    ValueChain: ["isValueChainLinkOf"],
    PrincipalAgent: ["hasPrincipalAgent"],
    AuxiliaryAgent: ["hasParticipatingAgent"],
    SupportAgent: ["hasParticipatingAgent"]
  },
  PrincipalAgent: { ValueChainLink: ["participatesInValueChainLink"], KPI: ["hasAssociatedKPI"] },
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
  scope: string[];
  user: string[];
  type: NodeType[];
  node: string[];
}

const emptyFilters: Filters = { scope: [], user: [], type: [], node: [] };

const agentTypes = new Set<NodeType>(["PrincipalAgent", "AuxiliaryAgent", "SupportAgent"]);

function nodesForScopes(snapshot: Snapshot, scopeIds: string[]) {
  if (!scopeIds.length) return null;

  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const selectedScopes = new Set(scopeIds);
  const components = new Set<string>();
  const kpis = new Set<string>();
  const agents = new Set<string>();
  const links = new Set<string>();

  const connectsTypes = (edge: GraphRelation, left: Set<string>, rightType: NodeType) => {
    if (left.has(edge.source) && nodesById.get(edge.target)?.type === rightType) return edge.target;
    if (left.has(edge.target) && nodesById.get(edge.source)?.type === rightType) return edge.source;
    return null;
  };

  snapshot.relations
    .filter((edge) => edge.type === "hasComponent" || edge.type === "isComponentOf")
    .forEach((edge) => {
      const componentId = connectsTypes(edge, selectedScopes, "Component");
      if (componentId) components.add(componentId);
    });

  // Components nested below a component of the scope belong to the same view.
  let addedComponent = true;
  while (addedComponent) {
    addedComponent = false;
    snapshot.relations
      .filter((edge) => edge.type === "hasSubcomponent" || edge.type === "hasSupercomponent")
      .forEach((edge) => {
        const source = nodesById.get(edge.source);
        const target = nodesById.get(edge.target);
        if (source?.type !== "Component" || target?.type !== "Component") return;
        const parentId = edge.type === "hasSubcomponent" ? edge.source : edge.target;
        const childId = edge.type === "hasSubcomponent" ? edge.target : edge.source;
        if (components.has(parentId) && !components.has(childId)) {
          components.add(childId);
          addedComponent = true;
        }
      });
  }

  snapshot.relations
    .filter((edge) => edge.type === "hasKPI" || edge.type === "appliesToComponent")
    .forEach((edge) => {
      const kpiId = connectsTypes(edge, components, "KPI");
      if (kpiId) kpis.add(kpiId);
    });

  snapshot.relations
    .filter((edge) => edge.type === "appliesToAgent" || edge.type === "hasAssociatedKPI")
    .forEach((edge) => {
      if (kpis.has(edge.source) && agentTypes.has(nodesById.get(edge.target)?.type as NodeType)) agents.add(edge.target);
      if (kpis.has(edge.target) && agentTypes.has(nodesById.get(edge.source)?.type as NodeType)) agents.add(edge.source);
    });

  snapshot.relations
    .filter((edge) => ["belongsTo", "participatesInValueChainLink", "hasPrincipalAgent", "hasParticipatingAgent"].includes(edge.type))
    .forEach((edge) => {
      const linkId = connectsTypes(edge, agents, "ValueChainLink");
      if (linkId) links.add(linkId);
    });

  return new Set([...selectedScopes, ...components, ...kpis, ...agents, ...links]);
}

function filterGraph(snapshot: Snapshot, filters: Filters): Snapshot {
  const scopeView = nodesForScopes(snapshot, filters.scope);
  const focus = new Set<string>();
  filters.node.forEach((nodeId) => {
    focus.add(nodeId);
    snapshot.relations.forEach((edge) => {
      if (edge.source === nodeId) focus.add(edge.target);
      if (edge.target === nodeId) focus.add(edge.source);
    });
  });
  const nodes = snapshot.nodes.filter((node) =>
    (!scopeView || scopeView.has(node.id)) &&
    (!filters.user.length || filters.user.includes(node.owner_id ?? "global")) &&
    (!filters.type.length || filters.type.includes(node.type)) &&
    (!filters.node.length || focus.has(node.id))
  );
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...snapshot,
    nodes,
    relations: snapshot.relations.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  };
}

interface MultiFilterOption<T extends string> {
  value: T;
  label: string;
  detail?: string;
}

function MultiFilterSelect<T extends string>({
  label,
  options,
  selected,
  onChange,
  placeholder
}: {
  label: string;
  options: MultiFilterOption<T>[];
  selected: T[];
  onChange: (values: T[]) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      if (fieldRef.current && !fieldRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);
  const normalizedQuery = normalizedSearchText(query);
  const selectedOptions = selected
    .map((value) => options.find((option) => option.value === value))
    .filter((option): option is MultiFilterOption<T> => Boolean(option));
  const available = options.filter((option) =>
    !selected.includes(option.value) &&
    (!normalizedQuery || normalizedSearchText(`${option.label} ${option.detail ?? ""}`).includes(normalizedQuery))
  );
  return <div className="graph-multi-filter" ref={fieldRef}>
    <label>{label}</label>
    {selectedOptions.length > 0 && <div className="graph-filter-chips">
      {selectedOptions.map((option) => <span className="graph-filter-chip" key={option.value}>
        {option.label}
        <button type="button" aria-label={`Eliminar ${option.label}`} onClick={() => onChange(selected.filter((value) => value !== option.value))}><X /></button>
      </span>)}
    </div>}
    <div className="graph-filter-combobox">
      <input
        value={query}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
      />
      <button type="button" className="graph-filter-toggle" aria-label={`Mostrar opciones de ${label}`} onClick={() => setOpen((current) => !current)}>⌄</button>
      {open && <div className="graph-filter-options">
        {available.length ? available.map((option) => <button type="button" key={option.value} onClick={() => {
          onChange([...selected, option.value]);
          setQuery("");
          setOpen(false);
        }}><strong>{option.label}</strong>{option.detail && <span>{option.detail}</span>}</button>) : <p>No hay más coincidencias</p>}
      </div>}
    </div>
  </div>;
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
          <img src="/assets/orca-graph-logo.webp" alt="ORCA Graph" />
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
  const positionMemory = useRef<Map<string, { x: number; y: number }>>(new Map());
  const viewportMemory = useRef<{ zoom: number; pan: { x: number; y: number } } | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const previousPositions = new Map(positionMemory.current);
    instance.current?.destroy();
    const agentKpiRelationTypes = new Set<RelationType>(["hasAssociatedKPI", "appliesToAgent"]);
    const renderedAgentKpiPairs = new Set<string>();
    const visualRelations = snapshot.relations.filter((edge) => {
      if (!agentKpiRelationTypes.has(edge.type)) return true;
      const pairKey = [edge.source, edge.target].sort().join("|");
      if (renderedAgentKpiPairs.has(pairKey)) return false;
      renderedAgentKpiPairs.add(pairKey);
      return true;
    });
    const neighbours = new Map<string, Set<string>>();
    snapshot.nodes.forEach((node) => neighbours.set(node.id, new Set()));
    visualRelations.forEach((edge) => {
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
    const layerByType: Record<NodeType, number> = {
      ValueChain: 0,
      ValueChainLink: 1,
      PrincipalAgent: 2,
      AuxiliaryAgent: 2,
      SupportAgent: 2,
      KPI: 3,
      Component: 4,
      Scope: 5
    };
    const layerCounts = new Map<number, number>();
    snapshot.nodes.forEach((node) => {
      const layer = layerByType[node.type];
      layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
    });
    const layerIndexes = new Map<number, number>();
    const positions = new Map<string, { x: number; y: number }>();
    snapshot.nodes.forEach((node) => {
      const previous = previousPositions.get(node.id);
      if (previous) {
        positions.set(node.id, previous);
        return;
      }
      const layer = layerByType[node.type];
      const index = layerIndexes.get(layer) ?? 0;
      const count = layerCounts.get(layer) ?? 1;
      positions.set(node.id, {
        x: 180 + (index - (count - 1) / 2) * 240,
        y: 150 + layer * 270
      });
      layerIndexes.set(layer, index + 1);
    });
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
        ...visualRelations.map((edge, index) => {
          const sourceType = snapshot.nodes.find((node) => node.id === edge.source)?.type;
          const targetType = snapshot.nodes.find((node) => node.id === edge.target)?.type;
          const structural =
            (sourceType === "ValueChainLink" && targetType === "ValueChainLink") ||
            (sourceType === "Component" && targetType === "Component");
          return {
            data: {
              id: `${edge.source}-${edge.type}-${edge.target}-${index}`,
              source: edge.source,
              target: edge.target,
              label: structural ? relationLabels[edge.type] : "",
              editable: edge.editable,
              structural
            }
          };
        })
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
            "target-arrow-shape": "none",
            "curve-style": "bezier",
            label: "",
            "line-style": "dashed",
            color: "#657789",
            "font-size": 12,
            "font-weight": 600,
            "text-background-color": "#f7fbfc",
            "text-background-opacity": 0.94,
            "text-background-padding": "3px"
          }
        },
        { selector: "edge[?structural]", style: { label: "data(label)", "line-style": "solid", "target-arrow-shape": "triangle" } },
        { selector: "edge[!editable]", style: { opacity: 0.92, "text-opacity": 0.96, "line-color": "#a8c5d7", "target-arrow-color": "#a8c5d7" } },
        { selector: ":selected", style: { "border-color": "#9ed8db", "border-width": 6, opacity: 1, "text-opacity": 1 } },
        { selector: "node[!editable]:selected", style: { opacity: 0.98, "text-opacity": 1 } }
      ],
      layout: {
        name: "preset",
        positions: Object.fromEntries(positions),
        padding: 80,
        fit: previousPositions.size === 0
      }
    });
    if (viewportMemory.current && previousPositions.size > 0) {
      instance.current.zoom(viewportMemory.current.zoom);
      instance.current.pan(viewportMemory.current.pan);
    }
    instance.current.on("tap", "node", (event) => onSelect(event.target.id()));
    instance.current.on("dragfree", "node", (event) => {
      positionMemory.current.set(event.target.id(), { ...event.target.position() });
    });
    instance.current.on("tap", (event) => {
      if (event.target === instance.current) onSelect(null);
    });
    return () => {
      if (instance.current) {
        viewportMemory.current = {
          zoom: instance.current.zoom(),
          pan: { ...instance.current.pan() }
        };
      }
      instance.current?.nodes().forEach((node) => {
        positionMemory.current.set(node.id(), { ...node.position() });
      });
      instance.current?.destroy();
    };
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
      .map((node) => ({ node, relation: "participatesInValueChainLink" as RelationType }));
  }
  if (type === "AuxiliaryAgent" || type === "SupportAgent") {
    return nodes.filter((node) => node.type === "ValueChainLink")
      .map((node) => ({ node, relation: "participatesInValueChainLink" as RelationType }));
  }
  if (type === "KPI") {
    return nodes
      .filter((node) => ["Component", "PrincipalAgent", "AuxiliaryAgent", "SupportAgent"].includes(node.type))
      .map((node) => ({
        node,
        relation: node.type === "Component"
          ? "appliesToComponent" as RelationType
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
  const fieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      if (fieldRef.current && !fieldRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);
  const selectedNodes = selected
    .map((id) => options.find((node) => node.id === id))
    .filter((node): node is GraphNode => Boolean(node));
  const available = options.filter((node) =>
    !selected.includes(node.id) &&
    `${node.name} ${typeInfo[node.type].label}`.toLowerCase().includes(query.toLowerCase())
  );
  return (
    <div className="multi-field" ref={fieldRef}>
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

function NodeDialog({
  initialType,
  initialNode,
  nodes,
  relations,
  canManageValueChain,
  canManageRestrictedAgents,
  activeChainId,
  onClose,
  onCreated
}: {
  initialType: NodeType;
  initialNode?: GraphNode | null;
  nodes: GraphNode[];
  relations: GraphRelation[];
  canManageValueChain: boolean;
  canManageRestrictedAgents: boolean;
  activeChainId: string | null;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [type, setType] = useState<NodeType>(initialType);
  const [targetId, setTargetId] = useState("");
  const editing = Boolean(initialNode);
  const [name, setName] = useState(initialNode?.name ?? "");
  const [description, setDescription] = useState(initialNode?.description ?? "");
  const [identification, setIdentification] = useState(initialNode?.identification ?? "");
  const [evaluation, setEvaluation] = useState(initialNode?.evaluation ?? "");
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
  const [chainId, setChainId] = useState(initialLinkChainId || activeChainId || "");
  const [linkRelations, setLinkRelations] = useState<{ targetId: string; type: RelationType }[]>(
    initialNode?.type === "ValueChainLink"
      ? relations
          .filter((edge) => linkRelationTypes.includes(edge.type) && (edge.source === initialNode.id || edge.target === initialNode.id))
          .map((edge) => ({ targetId: edge.source === initialNode.id ? edge.target : edge.source, type: edge.type }))
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
  const relatedLinkOptions = links.filter((link) => !chainId || chainForLink.get(link.id) === chainId);
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
    if (type !== "ValueChain" && activeChainId) payload.chain_id = activeChainId;
    if (type === "KPI") {
      payload.identification = identification;
      payload.evaluation = evaluation;
    }
    if (type === "SupportAgent") {
      payload.support_agent_subtype = supportAgentSubtype;
    }
    if (!editing && isAgent && relatedLinkIds.length) {
      payload.parent = {
        parent_id: relatedLinkIds[0],
        relation: "participatesInValueChainLink"
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
        const { type: _type, parent: _parent, chain_id: _chainId, ...changes } = payload;
        await api.updateNode(initialNode.id, changes);
        const desired: { source: string; target: string; type: RelationType }[] = [];
        if (type === "ValueChain") {
          chainLinkIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "hasValueChainLink" }));
        }
        if (type === "ValueChainLink") {
          desired.push({ source: chainId, target: initialNode.id, type: "hasValueChainLink" });
          linkRelations.filter((item) => item.targetId).forEach((item) => desired.push({ source: initialNode.id, target: item.targetId, type: item.type }));
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
            type: "participatesInValueChainLink"
          }));
          agentKpiIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "hasAssociatedKPI" }));
        }
        if (type === "KPI") {
          kpiComponentIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "appliesToComponent" }));
          kpiAgentIds.forEach((id) => desired.push({ source: initialNode.id, target: id, type: "appliesToAgent" }));
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
                (linkRelationTypes.includes(edge.type) && (edge.source === initialNode.id || edge.target === initialNode.id)))) ||
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
                canonicalAgentKpi(edge)?.kpiId === initialNode.id
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
            if (item) return `${item.chainId}|${item.linkId}|membership`;
            if (scopeComponent) return `${scopeComponent.scopeId}|${scopeComponent.componentId}|scope-component`;
            if (hierarchy) return `${hierarchy.superId}|${hierarchy.subId}|component-hierarchy`;
            if (componentKpi) return `${componentKpi.componentId}|${componentKpi.kpiId}|component-kpi`;
            if (agentLink) return `${agentLink.agentId}|${agentLink.linkId}|agent-link`;
            if (agentKpi) return `${agentKpi.agentId}|${agentKpi.kpiId}|agent-kpi`;
            if (linkRelationTypes.includes(edge.type)) {
              const [left, right] = [edge.source, edge.target].sort();
              return `${left}|${right}|${edge.type}`;
            }
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
        linkRelations.filter((item) => item.targetId).forEach((item) => relations.push({ source: created.id, target: item.targetId, type: item.type }));
        relatedLinkIds.slice(payload.parent ? 1 : 0).forEach((id) => relations.push({
          source: created.id,
          target: id,
          type: type === "PrincipalAgent" ? "belongsTo" : "participatesInValueChainLink"
        }));
        agentKpiIds.forEach((id) => relations.push({ source: created.id, target: id, type: "hasAssociatedKPI" }));
        if (type === "KPI") {
          kpiComponentIds.forEach((id) => relations.push({ source: created.id, target: id, type: "appliesToComponent" }));
          kpiAgentIds.forEach((id) => relations.push({ source: created.id, target: id, type: "appliesToAgent" }));
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
    <div className="overlay" onMouseDown={(event: MouseEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) onClose(); }}>
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
            <label htmlFor="new-identification">Identificación</label>
            <textarea id="new-identification" required maxLength={2000} value={identification} onChange={(e) => setIdentification(e.target.value)} />
            <label htmlFor="new-description">Descripción</label>
            <textarea id="new-description" required maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
            <label htmlFor="new-evaluation">Evaluación</label>
            <textarea id="new-evaluation" required maxLength={2000} value={evaluation} onChange={(e) => setEvaluation(e.target.value)} />
          </>
        ) : (
          <>
            <label htmlFor="new-description">Descripción</label>
            <textarea id="new-description" required value={description} onChange={(e) => setDescription(e.target.value)} />
            {isAgent && !editing && (
              <label>Tipo de agente
                <select value={type} onChange={(e) => setType(e.target.value as NodeType)}>
                  <option value="PrincipalAgent">Principal</option>
                  {canManageRestrictedAgents && <option value="AuxiliaryAgent">Auxiliar</option>}
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
                  {(Object.keys(supportAgentSubtypeLabels) as SupportAgentSubtype[])
                    .filter((subtype) => subtype !== "GovernmentSupportAgent")
                    .filter((subtype) => subtype !== "LocalGovernmentSupportAgent" || canManageRestrictedAgents)
                    .map((subtype) => (
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
          <div className="active-chain-form-note"><strong>Cadena activa</strong><span>{chains.find((chain) => chain.id === chainId)?.name ?? "Sin cadena activa"}</span></div>
          <label>Relaciones con otros eslabones</label>
          <div className="relation-list">
            {linkRelations.map((item, index) => (
              <div className="relation-item" key={`${index}-${item.targetId}`}>
                <select value={item.targetId} onChange={(e) => setLinkRelations((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, targetId: e.target.value } : row))}>
                  <option value="">Selecciona otro eslabón</option>
                  {relatedLinkOptions.map((link) => <option value={link.id} key={link.id}>{link.name}</option>)}
                </select>
                <select value={item.type} onChange={(e) => setLinkRelations((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, type: e.target.value as RelationType } : row))}>
                  {linkRelationTypes.map((relationType) => <option value={relationType} key={relationType}>{relationLabels[relationType]}</option>)}
                </select>
                <button type="button" className="icon" aria-label="Eliminar relación" onClick={() => setLinkRelations((current) => current.filter((_, rowIndex) => rowIndex !== index))}><Trash2 /></button>
              </div>
            ))}
            <button type="button" className="secondary" onClick={() => setLinkRelations((current) => [...current, { targetId: "", type: "muevePescadoFresco" }])}>Añadir relación</button>
          </div>
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
      !["hasValueChainLink", "isValueChainLinkOf", "isRelated", ...linkRelationTypes].includes(item)
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
    <div className="overlay" onMouseDown={(event: MouseEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) onClose(); }}>
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
    <div className="overlay" onMouseDown={(event: MouseEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) onClose(); }}>
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
    <div className="overlay" onMouseDown={(event: MouseEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) onClose(); }}>
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

type DataSection = "Definitions" | "ValueChain" | "ValueChainLink" | "Scope" | "Component" | "Agent" | "KPI";

const dataSections: { id: DataSection; label: string }[] = [
  { id: "Definitions", label: "Definiciones" },
  { id: "ValueChain", label: "Cadena de valor" },
  { id: "ValueChainLink", label: "Eslabón" },
  { id: "Agent", label: "Agente" },
  { id: "Scope", label: "Ámbito" },
  { id: "Component", label: "Componente" },
  { id: "KPI", label: "KPI" }
];

function DataWorkspace({
  snapshot,
  globalSnapshot,
  activeChainId,
  user,
  onSelect,
  onActivateChain,
  onCreated,
  onCreateNode,
  onEditNode,
  onDeleteNode
}: {
  snapshot: Snapshot;
  globalSnapshot: Snapshot;
  activeChainId: string | null;
  user: User;
  onSelect: (id: string) => void;
  onActivateChain: (id: string) => void;
  onCreated: () => Promise<void>;
  onCreateNode: (type: NodeType) => void;
  onEditNode: (node: GraphNode) => void;
  onDeleteNode: (node: GraphNode) => void;
}) {
  const [section, setSection] = useState<DataSection>("Definitions");
  const [query, setQuery] = useState("");
  const [ownership, setOwnership] = useState<"all" | "mine" | "others">("all");
  const [concepts, setConcepts] = useState<OntologyConcept[]>([]);
  const [conceptError, setConceptError] = useState("");
  const [editingConcept, setEditingConcept] = useState<OntologyConcept | null | undefined>(undefined);
  const [conceptLabel, setConceptLabel] = useState("");
  const [conceptDefinition, setConceptDefinition] = useState("");
  const [savingConcept, setSavingConcept] = useState(false);
  const [duplicatingChain, setDuplicatingChain] = useState<GraphNode | null>(null);
  const [duplicateName, setDuplicateName] = useState("");
  const [duplicateError, setDuplicateError] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  const agents: NodeType[] = ["PrincipalAgent", "AuxiliaryAgent", "SupportAgent"];
  const visibleDataSections = canManageValueChains(user)
    ? dataSections
    : dataSections.filter((item) => item.id !== "ValueChain");
  const sectionSnapshot = section === "ValueChain" ? globalSnapshot : snapshot;
  const nodes = sectionSnapshot.nodes.filter((node) => {
    const inSection =
      section === "Agent" ? agents.includes(node.type) : node.type === section;
    const ownerMatch =
      ownership === "all" ||
      (ownership === "mine" ? node.owner_id === user.id : node.owner_id !== user.id);
    return inSection && ownerMatch &&
      `${node.name} ${node.identification ?? ""} ${node.description} ${node.evaluation ?? ""} ${node.owner_name}`
        .toLowerCase().includes(query.toLowerCase());
  });
  const visibleConcepts = concepts
    .filter((concept) =>
      `${concept.label} ${concept.definition}`.toLowerCase().includes(query.toLowerCase())
    )
    .sort((left, right) => left.label.localeCompare(right.label, "es", { sensitivity: "base" }));
  const count = section === "Definitions" ? visibleConcepts.length : nodes.length;

  const loadConcepts = useCallback(async () => {
    try {
      setConcepts(await api.concepts());
      setConceptError("");
    } catch (error) {
      setConceptError(error instanceof Error ? error.message : "No se pudieron cargar las definiciones");
    }
  }, []);

  useEffect(() => { void loadConcepts(); }, [loadConcepts]);

  function openConcept(concept: OntologyConcept | null) {
    setEditingConcept(concept);
    setConceptLabel(concept?.label ?? "");
    setConceptDefinition(concept?.definition ?? "");
    setConceptError("");
  }

  async function saveConcept(event: FormEvent) {
    event.preventDefault();
    setSavingConcept(true);
    setConceptError("");
    try {
      const body = { label: conceptLabel.trim(), definition: conceptDefinition.trim() };
      if (editingConcept) await api.updateConcept(editingConcept.iri, body);
      else await api.createConcept(body);
      setEditingConcept(undefined);
      await loadConcepts();
    } catch (error) {
      setConceptError(error instanceof Error ? error.message : "No se pudo guardar el concepto");
    } finally {
      setSavingConcept(false);
    }
  }

  async function toggleConceptVisibility(concept: OntologyConcept) {
    setConceptError("");
    try {
      await api.updateConceptVisibility(concept.iri, !concept.visible);
      await loadConcepts();
    } catch (error) {
      setConceptError(error instanceof Error ? error.message : "No se pudo cambiar la visibilidad");
    }
  }

  async function deleteConcept(concept: OntologyConcept) {
    if (!window.confirm(`¿Quieres borrar el concepto «${concept.label}»? Esta acción también eliminará sus relaciones en la ontología.`)) return;
    setConceptError("");
    try {
      await api.deleteConcept(concept.iri);
      await loadConcepts();
    } catch (error) {
      setConceptError(error instanceof Error ? error.message : "No se pudo borrar el concepto");
    }
  }

  function openDuplicateChain(chain: GraphNode) {
    setDuplicatingChain(chain);
    setDuplicateName(`${chain.name} (copia)`);
    setDuplicateError("");
  }

  async function duplicateChain(event: FormEvent) {
    event.preventDefault();
    if (!duplicatingChain) return;
    const name = duplicateName.trim();
    if (globalSnapshot.nodes.some((node) => node.type === "ValueChain" && node.name.trim().toLocaleLowerCase("es") === name.toLocaleLowerCase("es"))) {
      setDuplicateError("Ya existe una cadena de valor con ese nombre.");
      return;
    }
    setDuplicating(true);
    setDuplicateError("");
    try {
      await api.duplicateValueChain(duplicatingChain.id, name);
      setDuplicatingChain(null);
      await onCreated();
    } catch (error) {
      setDuplicateError(error instanceof Error ? error.message : "No se pudo duplicar la cadena");
    } finally {
      setDuplicating(false);
    }
  }
  const namesForIds = (ids: string[]) => [...new Set(ids)]
    .map((id) => snapshot.nodes.find((node) => node.id === id)?.name)
    .filter((name): name is string => Boolean(name))
    .sort((left, right) => left.localeCompare(right, "es"));
  const valueChainLinkNames = (chainId: string) => {
    const linkIds = globalSnapshot.relations.flatMap((edge) => {
      if (edge.type === "hasValueChainLink" && edge.source === chainId) return [edge.target];
      if (edge.type === "isValueChainLinkOf" && edge.target === chainId) return [edge.source];
      return [];
    });
    return [...new Set(linkIds)]
      .map((id) => globalSnapshot.nodes.find((node) => node.id === id)?.name)
      .filter((name): name is string => Boolean(name))
      .sort((left, right) => left.localeCompare(right, "es"));
  };
  const valueChainName = (linkId: string) => {
    const chainIds = snapshot.relations.flatMap((edge) => {
      if (edge.type === "hasValueChainLink" && edge.target === linkId) return [edge.source];
      if (edge.type === "isValueChainLinkOf" && edge.source === linkId) return [edge.target];
      return [];
    });
    return namesForIds(chainIds)[0];
  };
  const linkRelationDescriptions = (linkId: string) => snapshot.relations
    .filter((edge) => linkRelationTypes.includes(edge.type) && (edge.source === linkId || edge.target === linkId))
    .map((edge) => {
      const otherId = edge.source === linkId ? edge.target : edge.source;
      const otherName = snapshot.nodes.find((node) => node.id === otherId)?.name ?? otherId;
      return `${otherName} (${relationLabels[edge.type]})`;
    })
    .sort((left, right) => left.localeCompare(right, "es"));
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
  const linkAgentNames = (linkId: string) => namesForIds(
    snapshot.relations.flatMap((edge) => {
      if ((edge.type === "belongsTo" || edge.type === "participatesInValueChainLink") && edge.target === linkId) return [edge.source];
      if ((edge.type === "hasPrincipalAgent" || edge.type === "hasParticipatingAgent") && edge.source === linkId) return [edge.target];
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
    section === "Agent" && hasSpecialPermissions(user) ? [{ type: "PrincipalAgent", label: "Crear agente" }] :
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
          "Relación con otros eslabones": join(linkRelationDescriptions(node.id)),
          Agentes: join(linkAgentNames(node.id)),
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
          Identificación: node.identification ?? "",
          Descripción: node.description,
          Evaluación: node.evaluation ?? "",
          Componentes: join(kpiComponentNames(node.id)),
          Agentes: join(kpiAgentNames(node.id)),
          Autor: node.owner_name
        }))
      }
    ];
    const headers: Record<string, string[]> = {
      Cadenas: ["Nombre", "Descripción", "Eslabones", "Autor"],
      Eslabones: ["Nombre", "Descripción", "Cadena", "Relación con otros eslabones", "Agentes", "Autor"],
      Ámbitos: ["Nombre", "Descripción", "Componentes", "Autor"],
      Componentes: ["Nombre", "Descripción", "Ámbitos", "Supercomponentes", "Subcomponentes", "KPI", "Autor"],
      Agentes: ["Nombre", "Descripción", "Eslabones", "KPI", "Autor"],
      KPI: ["Nombre", "Identificación", "Descripción", "Evaluación", "Componentes", "Agentes", "Autor"]
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
        {visibleDataSections.slice(0, 1).map((item) => (
          <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}>
            {item.label}
          </button>
        ))}
        <span className="data-nav-separator" aria-hidden="true" />
        {visibleDataSections.slice(1).map((item) => (
          <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}>
            {item.label}
          </button>
        ))}
        {hasSpecialPermissions(user) && (
          <>
            <span className="data-nav-divider">Exportación</span>
            <button className="export-tables" onClick={exportExcel}>
              <FileSpreadsheet /> Exportar tablas a Excel
            </button>
          </>
        )}
      </aside>
      <div className="data-content">
        <div className="data-heading">
          <div><span>VISTA DE DATOS</span><h1>{dataSections.find((item) => item.id === section)?.label}</h1>
            <p>{section === "Definitions" ? "Consulta las clases y definiciones vigentes de la ontología." : "Consulta datos propios y ajenos sobre el mismo RDF colaborativo."}</p></div>
          <div className="creation-actions">
            {section === "Definitions" && hasSpecialPermissions(user) && (
              <button className="primary" onClick={() => openConcept(null)}><Plus /> Crear concepto</button>
            )}
            {creationActions.map((action) => (
              <button className="primary" onClick={() => onCreateNode(action.type)} key={action.type}>
                <Plus /> {action.label}
              </button>
            ))}
          </div>
        </div>
        {section !== "Definitions" && <div className="data-summary">
          <div><span>Resultados</span><strong>{count}</strong></div>
          <div><span>Propios</span><strong>{nodes.filter((node) => node.owner_id === user.id).length}</strong></div>
          <div><span>Reutilizables</span><strong>{nodes.filter((node) => node.owner_id !== user.id).length}</strong></div>
        </div>}
        <div className="data-card">
          <div className="data-toolbar">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={section === "Definitions" ? "Buscar concepto o definición…" : "Buscar por nombre, descripción o autor…"} />
            {section !== "Definitions" && <div className="segmented">
              <button className={ownership === "all" ? "active" : ""} onClick={() => setOwnership("all")}>Todos</button>
              <button className={ownership === "mine" ? "active" : ""} onClick={() => setOwnership("mine")}>Mis datos</button>
              <button className={ownership === "others" ? "active" : ""} onClick={() => setOwnership("others")}>Otros usuarios</button>
            </div>}
          </div>
          <div className="data-table-wrap">
            {section === "Definitions" ? (
              <table className="definitions-table">
                <thead><tr><th>Concepto</th><th>Definición</th>{hasSpecialPermissions(user) && <th>Acciones</th>}</tr></thead>
                <tbody>{visibleConcepts.map((concept) => <tr key={concept.iri}>
                  <td><strong>{concept.label}</strong></td>
                  <td>{concept.definition || "—"}</td>
                  {hasSpecialPermissions(user) && <td><div className="table-actions">
                    <button className="table-action" onClick={() => openConcept(concept)}><Pencil /> Editar</button>
                    {isAdmin(user) && <button className="table-action" onClick={() => void toggleConceptVisibility(concept)}>{concept.visible ? "Ocultar a usuarios" : "Hacer visible"}</button>}
                    {concept.deletable && <button className="table-action danger" onClick={() => void deleteConcept(concept)}>Borrar</button>}
                  </div></td>}
                </tr>)}</tbody>
              </table>
            ) : section === "ValueChain" ? (
              <table><thead><tr><th>Nombre</th><th>Descripción</th><th>Eslabones</th><th>Autor</th><th>Acciones</th></tr></thead>
                <tbody>{nodes.map((node) => <tr key={node.id} className={node.editable ? "mine-row" : ""}>
                  <td><strong>{node.name}</strong></td>
                  <td>{node.description || "—"}</td>
                  <td>{renderNamePills(valueChainLinkNames(node.id))}</td>
                  <td>{node.owner_name}{node.editable && <b className="mine-tag">Tuyo</b>}</td>
                  <td><div className="table-actions">
                    <button
                      className={`table-action activate-chain-action ${activeChainId === node.id ? "active" : ""}`}
                      disabled={activeChainId === node.id}
                      onClick={() => onActivateChain(node.id)}
                    >
                      {activeChainId === node.id ? "Cadena activa" : "Activar cadena"}
                    </button>
                    <button className="table-action" onClick={() => openDuplicateChain(node)}>
                      <Copy /> Duplicar
                    </button>
                    {node.editable && <>
                      <button className="table-action" onClick={() => onEditNode(node)}><Pencil /> Editar</button>
                      <button className="table-action danger-action" onClick={() => onDeleteNode(node)}><Trash2 /> Borrar</button>
                    </>}
                  </div></td>
                </tr>)}</tbody>
              </table>
            ) : section === "ValueChainLink" ? (
              <table className="value-chain-link-table">
                <thead><tr><th>Nombre</th><th>Descripción</th><th>Relación con otros eslabones</th><th>Agentes</th><th>Autor</th><th>Acciones</th></tr></thead>
                <tbody>{nodes.map((node) => <tr key={node.id} className={node.editable ? "mine-row" : ""}>
                  <td><strong>{node.name}</strong></td>
                  <td>{node.description || "—"}</td>
                  <td>{renderNamePills(linkRelationDescriptions(node.id))}</td>
                  <td>{renderNamePills(linkAgentNames(node.id))}</td>
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
                      {(node.type !== "AuxiliaryAgent" || hasSpecialPermissions(user)) && (
                        <button className="table-action" onClick={() => onEditNode(node)}><Pencil /> Editar</button>
                      )}
                      <button className="table-action danger-action" onClick={() => onDeleteNode(node)}><Trash2 /> Borrar</button>
                    </>}
                  </div></td>
                </tr>)}</tbody>
              </table>
            ) : section === "KPI" ? (
              <table className="kpi-table">
                <thead><tr><th>Nombre</th><th>Identificación</th><th>Descripción</th><th>Evaluación</th><th>Componentes</th><th>Agentes</th><th>Autor</th><th>Acciones</th></tr></thead>
                <tbody>{nodes.map((node) => <tr key={node.id} className={node.editable ? "mine-row" : ""}>
                  <td><strong>{node.name}</strong></td>
                  <td>{node.identification || "—"}</td>
                  <td>{node.description || "—"}</td>
                  <td>{node.evaluation || "—"}</td>
                  <td>{renderNamePills(kpiComponentNames(node.id))}</td>
                  <td>{renderNamePills(kpiAgentNames(node.id))}</td>
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
                  <td><strong>{node.name}</strong></td><td>{node.description || "—"}</td>
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
        {duplicatingChain && createPortal(
          <div className="overlay" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !duplicating) setDuplicatingChain(null);
          }}>
            <form className="dialog" onSubmit={duplicateChain} role="dialog" aria-modal="true" aria-labelledby="duplicate-chain-title">
              <div className="dialog-title">
                <div>
                  <strong id="duplicate-chain-title">Duplicar cadena de valor</strong>
                  <span>Se crearán nuevas instancias RDF para todo el contenido de «{duplicatingChain.name}».</span>
                </div>
                <button type="button" className="icon" disabled={duplicating} aria-label="Cerrar" onClick={() => setDuplicatingChain(null)}><X /></button>
              </div>
              <label>Nuevo nombre<input autoFocus value={duplicateName} onChange={(event) => setDuplicateName(event.target.value)} maxLength={200} required /></label>
              <p className="form-help">El nombre debe ser distinto al de cualquier cadena existente.</p>
              {duplicateError && <div className="toast error">{duplicateError}</div>}
              <div className="dialog-actions">
                <button type="button" className="secondary" disabled={duplicating} onClick={() => setDuplicatingChain(null)}>Cancelar</button>
                <button type="submit" className="primary" disabled={duplicating || !duplicateName.trim()}><Copy /> {duplicating ? "Duplicando…" : "Duplicar cadena"}</button>
              </div>
            </form>
          </div>,
          document.body
        )}
        {conceptError && <div className="error concept-error">{conceptError}</div>}
      </div>
      {editingConcept !== undefined && createPortal(
        <div className="overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setEditingConcept(undefined);
        }}>
          <form className="dialog concept-dialog" onSubmit={saveConcept} role="dialog" aria-modal="true" aria-labelledby="concept-dialog-title">
            <div className="dialog-title">
              <div>
                <strong id="concept-dialog-title">{editingConcept ? "Editar concepto" : "Crear concepto"}</strong>
                <span>Clase de la ontología. La etiqueta y la definición se guardarán en español.</span>
              </div>
              <button type="button" className="icon" aria-label="Cerrar" onClick={() => setEditingConcept(undefined)}><X /></button>
            </div>
            <label htmlFor="concept-label">Concepto</label>
            <input id="concept-label" autoFocus required maxLength={200} value={conceptLabel} onChange={(event) => setConceptLabel(event.target.value)} />
            <label htmlFor="concept-definition">Definición</label>
            <textarea id="concept-definition" required maxLength={4000} rows={7} value={conceptDefinition} onChange={(event) => setConceptDefinition(event.target.value)} />
            {conceptError && <div className="error">{conceptError}</div>}
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={() => setEditingConcept(undefined)}>Cancelar</button>
              <button className="primary" disabled={savingConcept}>{savingConcept ? "Guardando…" : editingConcept ? "Guardar cambios" : "Crear concepto"}</button>
            </div>
          </form>
        </div>,
        document.body
      )}
    </section>
  );
}

function normalizedSearchText(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es").trim();
}

function editDistance(left: string, right: string) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[right.length];
}

function searchScore(name: string, query: string) {
  const candidate = normalizedSearchText(name);
  const term = normalizedSearchText(query);
  if (!term) return 0;
  if (candidate === term) return 1000;
  if (candidate.startsWith(term)) return 800 - candidate.length;
  if (candidate.includes(term)) return 600 - candidate.indexOf(term);
  return 300 - editDistance(candidate, term) * 12;
}

function ExploreWorkspace({ snapshot }: { snapshot: Snapshot }) {
  const availableTypes = useMemo(() => (Object.keys(typeInfo) as NodeType[])
    .filter((type) => type !== "ValueChain" && snapshot.nodes.some((node) => node.type === type)), [snapshot.nodes]);
  const [nodeType, setNodeType] = useState<NodeType | "">("");
  const [query, setQuery] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeSuggestions = (event: PointerEvent) => {
      if (searchBox.current && !searchBox.current.contains(event.target as Node)) setSuggestionsOpen(false);
    };
    document.addEventListener("pointerdown", closeSuggestions);
    return () => document.removeEventListener("pointerdown", closeSuggestions);
  }, []);

  useEffect(() => {
    setNodeType("");
    setQuery("");
    setVisibleIds(new Set());
    setExpandedIds(new Set());
    setSelectedId(null);
  }, [snapshot]);

  const suggestions = useMemo(() => {
    if (!nodeType) return [];
    return snapshot.nodes
      .filter((node) => node.type === nodeType)
      .map((node) => ({ node, score: query ? searchScore(node.name, query) : 0 }))
      .filter(({ score }) => !query || score > 100)
      .sort((left, right) => right.score - left.score || left.node.name.localeCompare(right.node.name, "es"))
      .slice(0, 8)
      .map(({ node }) => node);
  }, [nodeType, query, snapshot.nodes]);

  const neighboursOf = useCallback((nodeId: string) => snapshot.relations.flatMap((edge) => {
    if (edge.source === nodeId) return [edge.target];
    if (edge.target === nodeId) return [edge.source];
    return [];
  }), [snapshot.relations]);

  const chooseStartNode = (node: GraphNode) => {
    setQuery(node.name);
    setSuggestionsOpen(false);
    setSelectedId(node.id);
    setExpandedIds(new Set([node.id]));
    setVisibleIds(new Set([node.id, ...neighboursOf(node.id)]));
  };

  const expandNode = useCallback((nodeId: string) => {
    setSelectedId(nodeId);
    setExpandedIds((current) => new Set(current).add(nodeId));
    setVisibleIds((current) => new Set([...current, nodeId, ...neighboursOf(nodeId)]));
  }, [neighboursOf]);

  const exploredSnapshot = useMemo(() => {
    const nodes = snapshot.nodes.filter((node) => visibleIds.has(node.id));
    const nodeIds = new Set(nodes.map((node) => node.id));
    return { ...snapshot, nodes, relations: snapshot.relations.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)) };
  }, [snapshot, visibleIds]);

  const selectedNode = snapshot.nodes.find((node) => node.id === selectedId) ?? null;
  const pendingNeighbours = selectedNode ? neighboursOf(selectedNode.id).filter((id) => !visibleIds.has(id)).length : 0;

  return <section className="explore-workspace">
    <aside className="explore-controls">
      <div className="panel-title"><span>Explorar el grafo</span><Search /></div>
      <p className="explore-help">Elige un tipo y busca el nodo desde el que quieres comenzar.</p>
      <label>Tipo de nodo
        <select value={nodeType} onChange={(event) => { setNodeType(event.target.value as NodeType); setQuery(""); setSuggestionsOpen(false); }}>
          <option value="">Selecciona un tipo…</option>
          {availableTypes.map((type) => <option key={type} value={type}>{typeInfo[type].label}</option>)}
        </select>
      </label>
      <label>Nodo</label>
      <div className="explore-search" ref={searchBox}>
        <Search />
        <input
          value={query}
          disabled={!nodeType}
          placeholder={nodeType ? `Buscar ${typeInfo[nodeType].label.toLocaleLowerCase("es")}…` : "Selecciona primero un tipo"}
          onFocus={() => setSuggestionsOpen(Boolean(nodeType))}
          onChange={(event) => { setQuery(event.target.value); setSuggestionsOpen(true); }}
          aria-autocomplete="list"
          aria-expanded={suggestionsOpen}
        />
        {suggestionsOpen && nodeType && <div className="explore-suggestions" role="listbox">
          {suggestions.map((node) => <button key={node.id} type="button" onClick={() => chooseStartNode(node)}>
            <i className={`type-${node.type.toLowerCase()}`} /><span><strong>{node.name}</strong><small>{typeInfo[node.type].label}</small></span>
          </button>)}
          {!suggestions.length && <p>No se encontraron nodos parecidos.</p>}
        </div>}
      </div>
      <div className="explore-instructions">
        <span className="section-label">Cómo explorar</span>
        <p>Selecciona un resultado para mostrar sus vecinos.</p>
        <p>Pulsa cualquier nodo del grafo para desplegar sus propias conexiones.</p>
      </div>
      {visibleIds.size > 0 && <button className="secondary wide" onClick={() => { setVisibleIds(new Set()); setExpandedIds(new Set()); setSelectedId(null); setQuery(""); }}><FilterX /> Reiniciar exploración</button>}
    </aside>
    <section className="canvas explore-canvas">
      <div className="canvas-toolbar">
        <div><span><CircleDot /> {exploredSnapshot.nodes.length} nodos</span><span><GitBranch /> {exploredSnapshot.relations.length} relaciones</span><span>{expandedIds.size} expandidos</span></div>
        {selectedNode && <span className="explore-toolbar-hint">Pulsa un nodo para expandirlo</span>}
      </div>
      {visibleIds.size ? <GraphCanvas snapshot={exploredSnapshot} selected={selectedId} onSelect={(id) => id ? expandNode(id) : setSelectedId(null)} /> : <div className="explore-empty"><Search /><strong>Busca un nodo para comenzar</strong><span>Aparecerá junto a todos sus vecinos directos.</span></div>}
    </section>
    <aside className="inspector explore-inspector">
      <div className="panel-title"><span>Nodo seleccionado</span></div>
      {selectedNode ? <>
        <div className="inspector-head">
          <div className={`inspector-mark type-${selectedNode.type.toLowerCase()}`}><i /></div>
          <span>{typeInfo[selectedNode.type].label}</span><h2>{selectedNode.name}</h2>
          <p>{selectedNode.description || "Sin descripción"}</p>
        </div>
        <div className="metadata">
          {selectedNode.type === "KPI" && <><label>Identificación</label><p>{selectedNode.identification || "—"}</p><label>Evaluación</label><p>{selectedNode.evaluation || "—"}</p></>}
          <label>Estado</label><p>{expandedIds.has(selectedNode.id) ? "Vecindario expandido" : "Pendiente de expandir"}</p><label>Conexiones aún ocultas</label><p>{pendingNeighbours}</p><label>Autor</label><div className="author"><b>{selectedNode.owner_initials}</b><span>{selectedNode.owner_name}</span></div>
        </div>
      </> : <div className="empty-inspector"><CircleDot /><span>Selecciona o expande un nodo para consultar sus detalles.</span></div>}
    </aside>
  </section>;
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
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"node" | "relation" | "password" | "users" | null>(null);
  const [editingNode, setEditingNode] = useState<GraphNode | null>(null);
  const [createType, setCreateType] = useState<NodeType>("Scope");
  const [connected, setConnected] = useState(1);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [error, setError] = useState("");
  const [view, setView] = useState<"data" | "graph" | "explore">("data");
  const [remoteChange, setRemoteChange] = useState<string | null>(null);
  const [activeChainId, setActiveChainId] = useState<string | null>(() => localStorage.getItem(`orca-active-chain-${user.id}`));
  const [chainPickerOpen, setChainPickerOpen] = useState(false);
  const [chainQuery, setChainQuery] = useState("");

  const load = useCallback(async (clearRemoteChange = false) => {
    try {
      const [graph, people] = await Promise.all([api.graph(), api.users()]);
      setSnapshot(graph);
      setUsers(people);
      if (clearRemoteChange) setRemoteChange(null);
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
      if (message.type === "graph.changed" && message.actor?.id !== user.id) {
        setRemoteChange(`${message.actor?.display_name ?? "Otro usuario"} ha modificado el grafo.`);
      }
      if (message.type === "presence.changed") setConnected(message.connected);
    };
    return () => socket.close();
  }, [load, user.id]);

  const refreshGraph = useCallback(() => load(true), [load]);

  const chains = snapshot.nodes
    .filter((node) => node.type === "ValueChain")
    .sort((left, right) => left.name.localeCompare(right.name, "es"));
  const activeChain = chains.find((chain) => chain.id === activeChainId) ?? null;
  const visibleChains = chains.filter((chain) =>
    `${chain.name} ${chain.description}`.toLocaleLowerCase("es")
      .includes(chainQuery.trim().toLocaleLowerCase("es"))
  );
  const chainSnapshot = useMemo(() => snapshotForChain(snapshot, activeChain?.id ?? null), [snapshot, activeChain?.id]);
  const workspaceSnapshot = useMemo(() => activeChain
    ? { ...chainSnapshot, nodes: [activeChain, ...chainSnapshot.nodes] }
    : chainSnapshot, [chainSnapshot, activeChain]);

  useEffect(() => {
    if (activeChainId && chains.length && !chains.some((chain) => chain.id === activeChainId)) {
      setActiveChainId(null);
      localStorage.removeItem(`orca-active-chain-${user.id}`);
    }
  }, [activeChainId, chains, user.id]);

  const activateChain = (chainId: string) => {
    setActiveChainId(chainId);
    localStorage.setItem(`orca-active-chain-${user.id}`, chainId);
    setSelected(null);
    setFilters(emptyFilters);
    setChainPickerOpen(false);
    setChainQuery("");
  };

  const openChainPicker = () => {
    setChainQuery("");
    setChainPickerOpen(true);
  };

  const filtered = useMemo(() => filterGraph(chainSnapshot, filters), [chainSnapshot, filters]);
  const scopes = chainSnapshot.nodes.filter((node) => node.type === "Scope");
  const selectedNode = chainSnapshot.nodes.find((node) => node.id === selected);
  const selectedRelations = chainSnapshot.relations.filter((edge) => edge.source === selected || edge.target === selected);
  const selectedDegree = selectedNode
    ? new Set(
        selectedRelations.map((edge) =>
          edge.source === selectedNode.id ? edge.target : edge.source
        )
      ).size
    : 0;
  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const openCreate = (type: NodeType) => {
    if (type !== "ValueChain" && !activeChain) return;
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
          <img src="/assets/orca-graph-logo.webp" alt="ORCA Graph" />
        </div>
        <nav className="view-tabs" aria-label="Cambiar de vista">
          <button className={view === "data" ? "active" : ""} onClick={() => setView("data")}>▤ Vista de datos</button>
          <button className={view === "graph" ? "active" : ""} onClick={() => setView("graph")}>⌘ Vista de grafo</button>
          <button className={view === "explore" ? "active" : ""} onClick={() => setView("explore")}><Search /> Explorar</button>
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

      <section className="active-chain-bar">
        <div className="active-chain-summary"><span>Cadena activa</span><strong>{activeChain?.name ?? "Selecciona una cadena para comenzar"}</strong></div>
        <button type="button" className="active-chain-switcher" onClick={openChainPicker}>
          <span>
            <strong>{activeChain?.name ?? "Seleccionar cadena"}</strong>
            <small>{activeChain?.description || "Consulta las cadenas disponibles y activa una"}</small>
          </span>
          <b>{activeChain ? "Cambiar" : "Seleccionar"}</b>
        </button>
      </section>

      {view === "data" ? (
        <DataWorkspace
          snapshot={workspaceSnapshot}
          globalSnapshot={snapshot}
          activeChainId={activeChainId}
          user={user}
          onSelect={(id) => { setSelected(id); setView("graph"); }}
          onActivateChain={activateChain}
          onCreated={load}
          onCreateNode={openCreate}
          onEditNode={openEdit}
          onDeleteNode={removeNode}
        />
      ) : view === "explore" ? (
        <ExploreWorkspace snapshot={chainSnapshot} />
      ) : <section className="workspace">
        <aside className="sidebar">
          <div className="panel-title"><span>Modelo v7</span><ShieldCheck /></div>
          <div className="type-list">
            {(Object.keys(typeInfo) as NodeType[]).map((type) => (
              <div className={`type-row type-${type.toLowerCase()}`} key={type}>
                <i /><span>{typeInfo[type].label}</span>
                <b>{chainSnapshot.nodes.filter((node) => node.type === type).length}</b>
              </div>
            ))}
          </div>
          <div className="filter-panel">
            <span className="section-label">Filtrar grafo</span>
            <MultiFilterSelect label="Ámbito" options={scopes.map((scope) => ({ value: scope.id, label: scope.name }))} selected={filters.scope} onChange={(value) => setFilter("scope", value)} placeholder="Todos los ámbitos" />
            <MultiFilterSelect label="Usuario" options={[
              { value: "global", label: "Modelo compartido", detail: "Conceptos sin autor" },
              ...users.map((person) => ({ value: person.id, label: person.display_name, detail: roleLabels[person.role] }))
            ]} selected={filters.user} onChange={(value) => setFilter("user", value)} placeholder="Todos los usuarios" />
            <MultiFilterSelect label="Tipo de nodo" options={(Object.keys(typeInfo) as NodeType[])
              .filter((type) => type !== "ValueChain")
              .map((type) => ({ value: type, label: typeInfo[type].label }))} selected={filters.type} onChange={(value) => setFilter("type", value)} placeholder="Todos los tipos" />
            <MultiFilterSelect label="Nodo y vecindario" options={[...chainSnapshot.nodes]
              .sort((left, right) => left.name.localeCompare(right.name, "es"))
              .map((node) => ({ value: node.id, label: node.name, detail: `${typeInfo[node.type].label} · ${node.owner_name}` }))} selected={filters.node} onChange={(value) => setFilter("node", value)} placeholder="Todos los nodos" />
            <button className="secondary wide" onClick={() => setFilters(emptyFilters)}>
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
            <button className={`ghost ${remoteChange ? "refresh-pending" : ""}`} onClick={refreshGraph}>
              <Maximize2 /> Actualizar grafo{remoteChange ? " •" : ""}
            </button>
          </div>
          <GraphCanvas snapshot={filtered} selected={selected} onSelect={setSelected} />
          {remoteChange && (
            <div className="graph-change-notice" role="status">
              <span>{remoteChange} Pulsa «Actualizar grafo» para incorporar los cambios.</span>
              <button type="button" onClick={refreshGraph}>Actualizar ahora</button>
            </div>
          )}
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
                <p>{selectedNode.description || "Sin descripción"}</p>
              </div>
              <div className="metadata">
                {selectedNode.type === "KPI" && <><label>Identificación</label><p>{selectedNode.identification || "—"}</p><label>Evaluación</label><p>{selectedNode.evaluation || "—"}</p></>}
                <label>Autor</label>
                <div className="author"><b>{selectedNode.owner_initials}</b><span>{selectedNode.owner_name}</span></div>
                <label>Permisos</label>
                <p>{selectedNode.editable ? "Editable por ti" : "Visible en modo lectura"}</p>
                <label>Conectividad</label>
                <p>{selectedDegree} {selectedDegree === 1 ? "nodo vecino" : "nodos vecinos"}</p>
                {selectedNode.support_agent_subtype && (
                  <><label>Tipo de agente de apoyo</label><p>{supportAgentSubtypeLabels[selectedNode.support_agent_subtype]}</p></>
                )}
                <label>Relaciones</label>
                <div className="relation-list">
                  {selectedRelations.map((edge, index) => {
                    const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
                    const other = chainSnapshot.nodes.find((node) => node.id === otherId);
                    return (
                      <div className="relation-item" key={`${edge.source}-${edge.type}-${edge.target}-${index}`}>
                        <span>{relationLabels[edge.type]} · {other?.name}</span>
                        {edge.editable && (selectedNode.type !== "AuxiliaryAgent" || hasSpecialPermissions(user)) && (
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
                {(selectedNode.type !== "AuxiliaryAgent" || hasSpecialPermissions(user)) && (
                  <button className="secondary wide" onClick={() => setDialog("relation")}><GitBranch /> Crear relación</button>
                )}
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
          <span><i className="line related" /> Relación entre conceptos</span>
          <span><i className="ownership mine" /> Creado por ti</span>
          <span><i className="ownership foreign" /> Otros autores</span>
          <span>Tamaño = nº de vecinos</span>
        </div>
      </footer>

      {(!activeChain || chainPickerOpen) && snapshot.nodes.length > 0 && (
        <div className="overlay chain-picker-overlay" onMouseDown={(event) => {
          if (event.target === event.currentTarget && activeChain) setChainPickerOpen(false);
        }}>
          <section className="dialog chain-picker" role="dialog" aria-modal="true" aria-labelledby="chain-picker-title">
            <div className="dialog-title">
              <div><strong id="chain-picker-title">Selecciona una cadena de valor</strong><span>Todo el contenido y el grafo se mostrarán dentro de la cadena activa.</span></div>
              {activeChain && <button type="button" className="icon" aria-label="Cerrar selector de cadena" onClick={() => setChainPickerOpen(false)}><X /></button>}
            </div>
            <div className="chain-picker-search">
              <Search />
              <input autoFocus value={chainQuery} onChange={(event) => setChainQuery(event.target.value)} placeholder="Filtrar cadenas por nombre o descripción…" />
            </div>
            <div className="chain-picker-list">
              {visibleChains.map((chain) => <button type="button" className={chain.id === activeChainId ? "active" : ""} key={chain.id} onClick={() => activateChain(chain.id)}><span><strong>{chain.name}</strong><small>{chain.description || "Sin descripción"}</small></span><b>{chain.id === activeChainId ? "Activa" : "Activar"}</b></button>)}
              {!visibleChains.length && <p>{chains.length ? "No hay cadenas que coincidan con la búsqueda." : "No hay cadenas disponibles."}</p>}
            </div>
            {canManageValueChains(user) && <div className="dialog-actions"><button className="primary" onClick={() => openCreate("ValueChain")}><Plus /> Crear cadena</button></div>}
          </section>
        </div>
      )}

      {dialog === "node" && <NodeDialog initialType={createType} initialNode={editingNode} nodes={workspaceSnapshot.nodes} relations={snapshot.relations} activeChainId={activeChainId} canManageValueChain={canManageValueChains(user)} canManageRestrictedAgents={hasSpecialPermissions(user)} onClose={() => { setDialog(null); setEditingNode(null); }} onCreated={load} />}
      {dialog === "relation" && <RelationDialog nodes={chainSnapshot.nodes} relations={chainSnapshot.relations} canManageValueChain={canManageValueChains(user)} initialSource={selected} onClose={() => setDialog(null)} onCreated={load} />}
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
