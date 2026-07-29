import cytoscape, { Core } from "cytoscape";
import {
  CircleDot,
  FilterX,
  GitBranch,
  KeyRound,
  LogOut,
  Maximize2,
  Plus,
  ShieldCheck,
  Trash2,
  UserCog,
  UserPlus,
  Users,
  X
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  ApplicationLevel,
  GraphNode,
  GraphRelation,
  NodePayload,
  NodeType,
  RelationType,
  Snapshot,
  SupportAgentSubtype,
  UnitOption,
  User
} from "./api";

const emptySnapshot: Snapshot = { nodes: [], relations: [], current_user_id: "" };
const APP_VERSION = "6.2.0";

const supportAgentSubtypeLabels: Record<SupportAgentSubtype, string> = {
  SupportAgent: "Agente de apoyo (general)",
  ResearchSupportAgent: "Agente de apoyo a la investigación",
  TrainingSupportAgent: "Agente de apoyo formativo",
  GovernmentSupportAgent: "Agente de apoyo gubernamental",
  NationalGovernmentSupportAgent: "Agente gubernamental nacional",
  RegionalGovernmentSupportAgent: "Agente gubernamental regional"
};

const typeInfo: Record<NodeType, { label: string; description: string }> = {
  Scope: { label: "Ámbito", description: "Ámbito raíz o subámbito jerárquico." },
  KPI: { label: "KPI", description: "Indicador aplicado a un eslabón o agente." },
  ValueChain: { label: "Cadena de valor", description: "Agrupación de eslabones." },
  ValueChainLink: { label: "Eslabón", description: "Etapa de una cadena de valor." },
  PrincipalAgent: { label: "Agente principal", description: "Pertenece a un eslabón." },
  AuxiliaryAgent: { label: "Agente auxiliar", description: "Participa de forma auxiliar." },
  SupportAgent: { label: "Agente de apoyo", description: "Presta apoyo a un eslabón." }
};

const applicationLabels: Record<ApplicationLevel, string> = {
  General: "General",
  Regional: "Regional",
  Provincial: "Provincial",
  Locality: "Localidad"
};

const relationLabels: Record<RelationType, string> = {
  hasSubscope: "tiene subámbito",
  hasSuperscope: "tiene superámbito",
  similarTo: "similar a",
  hasValueChainLink: "tiene eslabón",
  isValueChainLinkOf: "es eslabón de",
  belongsTo: "pertenece",
  hasPrincipalAgent: "tiene agente principal",
  participatesInValueChainLink: "participa en",
  hasParticipatingAgent: "tiene agente participante",
  appliesToValueChainLink: "se aplica al eslabón",
  appliesToAgent: "se aplica al agente",
  appliesToScope: "se aplica al ámbito",
  hasKPI: "tiene KPI",
  precedes: "precede a"
};

const allowedMatrix: Partial<Record<NodeType, Partial<Record<NodeType, RelationType[]>>>> = {
  Scope: {
    Scope: ["hasSubscope", "hasSuperscope", "similarTo"],
    KPI: ["hasKPI"]
  },
  KPI: {
    KPI: ["similarTo"],
    Scope: ["appliesToScope"],
    ValueChainLink: ["appliesToValueChainLink"],
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
  PrincipalAgent: { ValueChainLink: ["belongsTo"] },
  AuxiliaryAgent: { ValueChainLink: ["participatesInValueChainLink"] },
  SupportAgent: { ValueChainLink: ["participatesInValueChainLink"] }
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
    .filter((edge) => edge.type === "hasSubscope")
    .forEach((edge) => children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target]));
  const memberships = new Map<string, Set<string>>();
  snapshot.nodes.filter((node) => node.type === "Scope").forEach((scope) => {
    const queue = [scope.id];
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
            semantic: ["similarTo", "appliesToAgent", "appliesToValueChainLink", "appliesToScope", "hasKPI"].includes(edge.type)
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
        { selector: 'node[type = "KPI"]', style: { shape: "diamond", "background-color": "#cff2e3", "border-color": "#2f9d79", color: "#16324a", "text-max-width": "88px" } },
        { selector: 'node[type = "ValueChain"]', style: { shape: "ellipse", "background-color": "#9fdadd", "border-color": "#315a78", color: "#16324a", "text-max-width": "96px" } },
        { selector: 'node[type = "ValueChainLink"]', style: { shape: "ellipse", "background-color": "#d7eaf5", "border-color": "#4e7fa0", color: "#16324a", "text-max-width": "116px" } },
        { selector: 'node[type = "PrincipalAgent"]', style: { shape: "pentagon", "background-color": "#afcbe0", "border-color": "#3e6f91", color: "#16324a" } },
        { selector: 'node[type = "AuxiliaryAgent"]', style: { shape: "round-pentagon", "background-color": "#c4e6e8", "border-color": "#5792a5", color: "#16324a" } },
        { selector: 'node[type = "SupportAgent"]', style: { shape: "heptagon", "background-color": "#bde8d7", "border-color": "#2f9d79", color: "#16324a" } },
        { selector: "node[?editable]", style: { "border-width": 5 } },
        { selector: 'node[type = "Scope"][!editable]', style: { "background-color": "#e3f3f4", "border-color": "#b7d5dc" } },
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
    return nodes.filter((node) => node.type === "Scope")
      .map((node) => ({ node, relation: "hasSubscope" as RelationType }));
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
      .filter((node) => ["Scope", "ValueChainLink", "AuxiliaryAgent", "SupportAgent"].includes(node.type))
      .map((node) => ({
        node,
        relation: node.type === "Scope"
          ? "appliesToScope" as RelationType
          : node.type === "ValueChainLink"
            ? "appliesToValueChainLink" as RelationType
            : "appliesToAgent" as RelationType
      }));
  }
  return [];
}

function NodeDialog({
  nodes,
  units,
  canManageValueChain,
  onClose,
  onCreated
}: {
  nodes: GraphNode[];
  units: UnitOption[];
  canManageValueChain: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [type, setType] = useState<NodeType>("Scope");
  const [targetId, setTargetId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [definition, setDefinition] = useState("");
  const [applicationLevel, setApplicationLevel] = useState<ApplicationLevel>("General");
  const [applicationScope, setApplicationScope] = useState("");
  const [unitIri, setUnitIri] = useState(units[0]?.iri ?? "");
  const [supportAgentSubtype, setSupportAgentSubtype] =
    useState<SupportAgentSubtype>("SupportAgent");
  const [error, setError] = useState("");
  const targets = creationTargets(type, nodes);
  const selectedTarget = targets.find((item) => item.node.id === targetId);
  const requiresTarget = ["KPI", "ValueChainLink", "PrincipalAgent", "AuxiliaryAgent", "SupportAgent"].includes(type);

  useEffect(() => setTargetId(""), [type]);
  useEffect(() => {
    if (!unitIri && units.length) setUnitIri(units[0].iri);
  }, [units, unitIri]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const payload: NodePayload = { type, name, description };
    if (type === "KPI") {
      payload.definition = definition;
      payload.application_level = applicationLevel;
      payload.application_scope = applicationScope;
      payload.unit_iri = unitIri;
    }
    if (type === "SupportAgent") {
      payload.support_agent_subtype = supportAgentSubtype;
    }
    if (selectedTarget) {
      payload.parent = {
        parent_id: selectedTarget.node.id,
        relation: selectedTarget.relation
      };
    }
    try {
      await api.createNode(payload);
      await onCreated();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo crear el nodo");
    }
  }

  return (
    <div className="overlay">
      <form className="dialog" onSubmit={submit}>
        <div className="dialog-title">
          <div><strong>Nuevo nodo</strong><span>Las combinaciones incompatibles no se ofrecen.</span></div>
          <button type="button" className="icon" onClick={onClose}><X /></button>
        </div>
        <label>Tipo</label>
        <div className="type-grid expanded">
          {(Object.keys(typeInfo) as NodeType[])
            .filter((item) => canManageValueChain || !["ValueChain", "ValueChainLink"].includes(item))
            .map((item) => (
            <button
              type="button"
              className={`type-card ${item === type ? "active" : ""} type-${item.toLowerCase()}`}
              onClick={() => setType(item)}
              key={item}
            >
              <i /><strong>{typeInfo[item].label}</strong><span>{typeInfo[item].description}</span>
            </button>
          ))}
        </div>
        <label htmlFor="new-name">Nombre</label>
        <input id="new-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        {type === "Scope" ? (
          <>
            <label htmlFor="new-description">Descripción</label>
            <textarea id="new-description" required value={description} onChange={(e) => setDescription(e.target.value)} />
          </>
        ) : type === "KPI" ? (
          <>
            <label htmlFor="new-definition">Definición</label>
            <textarea id="new-definition" required value={definition} onChange={(e) => setDefinition(e.target.value)} />
            <div className="form-row">
              <label>Nivel de aplicación
                <select value={applicationLevel} onChange={(e) => setApplicationLevel(e.target.value as ApplicationLevel)}>
                  {(Object.keys(applicationLabels) as ApplicationLevel[]).map((level) => (
                    <option value={level} key={level}>{applicationLabels[level]}</option>
                  ))}
                </select>
              </label>
              <label>Unidad OM
                <select required value={unitIri} onChange={(e) => setUnitIri(e.target.value)}>
                  {units.map((unit) => <option value={unit.iri} key={unit.iri}>{unit.label} ({unit.symbol})</option>)}
                </select>
              </label>
            </div>
            <label>Ámbito de aplicación
              <input required placeholder="Texto libre: territorio, organización o contexto" value={applicationScope} onChange={(e) => setApplicationScope(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <label htmlFor="new-description">Descripción opcional</label>
            <textarea id="new-description" value={description} onChange={(e) => setDescription(e.target.value)} />
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
        {(targets.length > 0 || requiresTarget) && (
          <label>{type === "KPI" ? "Aplicar a" : type === "Scope" ? "Superámbito opcional" : "Nodo relacionado"}
            <select required={requiresTarget} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">{requiresTarget ? "Selecciona un nodo compatible" : "Ninguno: crear como ámbito raíz"}</option>
              {targets.map(({ node, relation }) => (
                <option value={node.id} key={`${node.id}-${relation}`}>
                  {node.name} · {typeInfo[node.type].label} · {relationLabels[relation]}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={requiresTarget && !targetId}>Crear nodo</button>
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
  if (source?.type === "KPI") {
    const current = relations.flatMap((edge) => {
      if (edge.source === source.id) return [edge.type];
      if (edge.target === source.id && edge.type === "hasKPI") return ["appliesToScope" as RelationType];
      return [];
    });
    if (current.includes("appliesToAgent")) {
      allowed = allowed.filter((item) => item !== "appliesToValueChainLink");
    }
    if (current.includes("appliesToValueChainLink")) {
      allowed = allowed.filter((item) => item !== "appliesToAgent");
    }
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
        password
      });
      setUsername("");
      setDisplayName("");
      setPassword("");
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
          <button className="primary" disabled={saving || password.length < 8}>
            <UserPlus /> {saving ? "Creando…" : "Crear usuario"}
          </button>
        </form>
        {error && <div className="error">{error}</div>}
        <div className="user-admin-list">
          {users.map((person) => (
            <div className="user-admin-row" key={person.id}>
              <b>{person.initials}</b>
              <span><strong>{person.display_name}</strong><small>@{person.username} · {person.role}</small></span>
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
  const [connected, setConnected] = useState(1);
  const [filters, setFilters] = useState<Filters>({ scope: "", user: "", type: "", node: "" });
  const [error, setError] = useState("");

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
        <div className="presence"><i /> {connected} colaboradores conectados</div>
        <div className="top-actions">
          <div className="user-area">
            <b>{user.initials}</b>
            <span><strong>{user.display_name}</strong><small>{user.role}</small></span>
            <button className="ghost" onClick={() => setDialog("password")}><KeyRound /> Contraseña</button>
            <button className="ghost" onClick={onLogout}><LogOut /> Salir</button>
          </div>
          {user.role === "orca" && (
            <button className="secondary" onClick={() => setDialog("users")}><UserCog /> Usuarios</button>
          )}
          <button className="secondary" onClick={() => setDialog("relation")}><GitBranch /> Relacionar</button>
          <button className="primary" onClick={() => setDialog("node")}><Plus /> Nuevo nodo</button>
        </div>
      </header>

      <section className="workspace">
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
                <option value="global">Grafo global</option>
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
                {selectedNode.application_level && <><label>Nivel de aplicación</label><p>{applicationLabels[selectedNode.application_level]}</p></>}
                {selectedNode.application_scope && <><label>Ámbito de aplicación</label><p>{selectedNode.application_scope}</p></>}
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
      </section>

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

      {dialog === "node" && <NodeDialog nodes={snapshot.nodes} units={units} canManageValueChain={user.role === "orca"} onClose={() => setDialog(null)} onCreated={load} />}
      {dialog === "relation" && <RelationDialog nodes={snapshot.nodes} relations={snapshot.relations} canManageValueChain={user.role === "orca"} initialSource={selected} onClose={() => setDialog(null)} onCreated={load} />}
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
