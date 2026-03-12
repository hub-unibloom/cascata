
import React, { useState, useEffect, useRef } from 'react';
import { 
  Zap, Plus, Trash2, Activity, Play, 
  CheckCircle2, AlertCircle, Loader2, 
  Settings, X, Filter, GitBranch, Terminal,
  History, ToggleLeft as Toggle, Layout, Workflow,
  ChevronRight, Save, Database, Globe, MousePointer2,
  ArrowRight, Maximize2, Minimize2, Code, ChevronDown,
  Link as LinkIcon, Unlink, Key, Shield, RefreshCcw,
  Layers, Copy, ArrowDownRight, Check
} from 'lucide-react';

interface Node {
  id: string;
  type: 'trigger' | 'query' | 'http' | 'logic' | 'response' | 'transform' | 'data' | 'rpc';
  x: number;
  y: number;
  label: string;
  config: any;
  next?: string[] | { true?: string, false?: string, out?: string };
}

interface Automation {
  id: string;
  name: string;
  description: string;
  is_active: boolean;
  nodes: Node[];
  trigger_type: string;
  trigger_config: any;
}

interface ExecutionRun {
  id: string;
  automation_id: string;
  status: 'success' | 'error' | 'failed';
  execution_time_ms: number;
  error_message?: string | null;
  trigger_payload?: any;
  final_output?: any;
  created_at: string;
}

interface AutomationStats {
  total_runs: number;
  success_count: number;
  failed_count: number;
  avg_ms: number;
  last_run_at: string | null;
}

const AutomationManager: React.FC<{ projectId: string }> = ({ projectId }: { projectId: string }) => {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [tables, setTables] = useState<any[]>([]);
  const [columns, setColumns] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'composer'>('list');
  const [activeTab, setActiveTab] = useState<'workflows' | 'runs'>('workflows');
  const [runs, setRuns] = useState<ExecutionRun[]>([]);
  const [stats, setStats] = useState<Record<string, AutomationStats>>({});
  const [runsFilter, setRunsFilter] = useState<string | null>(null);
  const [vaultSecrets, setVaultSecrets] = useState<any[]>([]);
  
  // COMPOSER STATE
  const [editingAutomation, setEditingAutomation] = useState<Partial<Automation> | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [draggedNode, setDraggedNode] = useState<string | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [connectingFrom, setConnectingFrom] = useState<{ id: string, port: 'out' | 'true' | 'false' } | null>(null);
  const [configNodeId, setConfigNodeId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchAutomations = async () => {
    try {
      const res = await fetch(`/api/data/${projectId}/automations`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      setAutomations(Array.isArray(data) ? data : []);
    } catch (e) { console.error("Automations fetch error"); }
  };

  const fetchRuns = async (automationId?: string | null) => {
    try {
      const url = automationId
        ? `/api/data/${projectId}/automations/runs?automation_id=${automationId}`
        : `/api/data/${projectId}/automations/runs`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      setRuns(Array.isArray(data) ? data : []);
    } catch (e) { console.error("Runs fetch error"); }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch(`/api/data/${projectId}/automations/stats`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      if (data && typeof data === 'object') setStats(data);
    } catch (e) { console.error("Stats fetch error"); }
  };

  const fetchVault = async () => {
    try {
      const res = await fetch(`/api/control/projects/${projectId}/vault`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      setVaultSecrets(Array.isArray(data) ? data.filter((s: any) => s.type !== 'folder') : []);
    } catch (e) { console.error("Vault fetch error"); }
  };

  const fetchTables = async () => {
    try {
      const res = await fetch(`/api/data/${projectId}/tables`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      setTables(Array.isArray(data) ? data : []);
      if (Array.isArray(data) && data.length > 0) {
        handleFetchColumns(typeof data[0] === 'string' ? data[0] : data[0].name);
      }
    } catch (e) { console.error("Tables fetch error"); }
  };

  const handleFetchColumns = async (tableName: string) => {
    if (columns[tableName]) return;
    try {
      const res = await fetch(`/api/data/${projectId}/tables/${tableName}/columns`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      if (Array.isArray(data)) {
        setColumns((prev: Record<string, string[]>) => ({ ...prev, [tableName]: data.map((c: { name: string }) => c.name) }));
      }
    } catch (e) { console.error("Columns fetch error"); }
  };

  useEffect(() => { 
      Promise.all([fetchAutomations(), fetchRuns(), fetchStats(), fetchTables(), fetchVault()]).then(() => setLoading(false)); 
  }, [projectId]);

  // COMPOSER ACTIONS
  const handleCreateNew = () => {
    const triggerTable = (tables[0] && typeof tables[0] === 'object') ? (tables[0] as any).name : (tables[0] || '*');
    setEditingAutomation({
      name: 'Novo Fluxo ' + (automations.length + 1),
      description: 'Orquestração Enterprise v2',
      trigger_type: 'API_INTERCEPT',
      trigger_config: { table: triggerTable, event: '*' },
      is_active: true
    });
    setNodes([
      { id: 'node_1', type: 'trigger', x: 100, y: 300, label: 'Trigger Event', config: {}, next: [] },
      { id: 'node_2', type: 'response', x: 800, y: 300, label: 'Resposta Final', config: { body: { success: true } }, next: [] }
    ]);
    setView('composer');
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Tem certeza que deseja excluir esta orquestração?')) return;
    try {
      await fetch(`/api/data/${projectId}/automations/${id}`, { method: 'DELETE' });
      setAutomations((prev: Automation[]) => prev.filter((a: Automation) => a.id !== id));
    } catch (e) { console.error(e); }
  };

  const handleToggle = async (auto: Automation) => {
    try {
      const newStatus = !auto.is_active;
      await fetch(`/api/data/${projectId}/automations/${auto.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: newStatus }),
        headers: { 'Content-Type': 'application/json' }
      });
      setAutomations((prev: Automation[]) => prev.map((a: Automation) => a.id === auto.id ? { ...a, is_active: newStatus } : a));
    } catch (e) { console.error(e); }
  };

  const handleSave = async () => {
    if (!editingAutomation || !editingAutomation.name) { setError("Nome é obrigatório."); return; }
    setSubmitting(true);
    try {
      await fetch(`/api/data/${projectId}/automations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
        body: JSON.stringify({ ...(editingAutomation || {}), nodes })
      });
      setView('list');
      fetchAutomations();
      setSuccess("Workflow salvo com sucesso.");
    } catch (e: any) { setError("Erro ao salvar."); }
    finally { setSubmitting(false); setTimeout(() => setSuccess(null), 3000); }
  };

  const addNode = (type: Node['type']) => {
    const id = `node_${Date.now()}`;
    const newNode: Node = {
      id, type, x: 400, y: 300, label: type.toUpperCase(),
      config: type === 'http' ? { url: '', method: 'POST', auth: 'none', retries: 0, headers: {}, body: {}, timeout: 15000 } :
              type === 'logic' ? { conditions: [{ left: '', op: 'eq', right: '' }], match: 'all' } :
              type === 'query' ? { sql: '-- SELECT * FROM users WHERE id = $1', params: [], readonly: true } :
              type === 'data' ? { operation: 'select', table: '', filters: [], body: {} } :
              type === 'rpc' ? { function: '', args: [] } :
              type === 'transform' ? { body: {} } : 
              type === 'response' ? { status_code: 200, body: { success: true } } : {},
      next: (type === 'logic') ? { true: undefined, false: undefined } : []
    };
    setNodes([...nodes, newNode] as Node[]);
    setConfigNodeId(id);
  };

  // DRAG & DROP
  const onMouseDown = (id: string, e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.port')) return;
    setDraggedNode(id);
    const node = nodes.find((n: Node) => n.id === id);
    if (node) setOffset({ x: e.clientX - node.x, y: e.clientY - node.y });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (draggedNode) {
      setNodes(nodes.map((n: Node) => n.id === draggedNode ? { ...n, x: e.clientX - offset.x, y: e.clientY - offset.y } : n));
    }
  };

  const handlePortClick = (nodeId: string, port: 'out' | 'true' | 'false') => {
    if (connectingFrom) {
       // Cannot connect to itself
       if (connectingFrom.id === nodeId) { setConnectingFrom(null); return; }
       
       // Success connection
       setNodes(nodes.map((n: Node) => {
         if (n.id === connectingFrom.id) {
            if (n.type === 'logic') {
               const nextObj = { ...(n.next as any), [connectingFrom.port]: nodeId };
               return { ...n, next: nextObj };
            } else {
               const nextArr = Array.isArray(n.next) ? [...n.next] : [];
               if (!nextArr.includes(nodeId)) nextArr.push(nodeId);
               return { ...n, next: nextArr };
            }
         }
         return n;
       }));
       setConnectingFrom(null);
    } else {
       setConnectingFrom({ id: nodeId, port });
    }
  };

  const disconnect = (fromId: string, toId: string, port?: string) => {
    setNodes(nodes.map((n: Node) => {
      if (n.id === fromId) {
        if (n.type === 'logic') {
           const nextObj = { ...(n.next as any) };
           if (port === 'true') nextObj.true = undefined;
           if (port === 'false') nextObj.false = undefined;
           return { ...n, next: nextObj };
        } else {
           return { ...n, next: (n.next as string[]).filter(id => id !== toId) };
        }
      }
      return n;
    }));
  };

  // MODAL CONFIG
  const activeNode = nodes.find((n: Node) => n.id === configNodeId);

  if (view === 'composer') {
    return (
      <div className="h-[82vh] flex flex-col bg-white border border-slate-200 rounded-[3.5rem] overflow-hidden animate-in zoom-in-95 shadow-2xl relative">
        {/* HEADER */}
        <header className="bg-white border-b border-slate-100 p-8 flex items-center justify-between z-30">
          <div className="flex items-center gap-6">
            <button onClick={() => setView('list')} className="w-12 h-12 flex items-center justify-center hover:bg-slate-50 rounded-2xl text-slate-400 hover:text-slate-900 transition-all border border-transparent hover:border-slate-100">
              <X size={24} />
            </button>
            <div className="h-10 w-[1px] bg-slate-100"></div>
            <div>
              <input 
                value={editingAutomation?.name || ''}
                onChange={(e) => setEditingAutomation(prev => ({...(prev || {}), name: e.target.value}))}
                className="text-2xl font-black text-slate-900 outline-none bg-transparent hover:bg-slate-50 px-2 rounded-lg transition-all w-64"
                placeholder="Workflow Name"
              />
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em] mt-1 ml-2 flex items-center gap-2">
                 <Shield size={10} className="text-indigo-600"/> Production Grade <span className="text-indigo-600">v2.1</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
             <button onClick={handleSave} className="bg-indigo-600 text-white px-8 py-3.5 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-3 hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 hover:scale-[1.02] active:scale-95">
               <Save size={16} /> Salvar Workflow
             </button>
          </div>
        </header>

        {/* CANVAS */}
        <div 
          className="flex-1 relative bg-[#FAFAFA] overflow-hidden"
          onMouseMove={onMouseMove}
          onMouseUp={() => setDraggedNode(null)}
          ref={canvasRef}
        >
          {/* DOT GRID */}
          <div className="absolute inset-0 opacity-[0.05] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#000 1.5px, transparent 1.5px)', backgroundSize: '32px 32px' }}></div>
          
          {/* SVG CONNECTIONS */}
          <svg className="absolute inset-0 pointer-events-none w-full h-full z-0">
             {nodes.map(node => {
               const connections: { toId: string, port: string }[] = [];
               if (node.type === 'logic') {
                  const nextObj = node.next as any;
                  if (nextObj?.true) connections.push({ toId: nextObj.true, port: 'true' });
                  if (nextObj?.false) connections.push({ toId: nextObj.false, port: 'false' });
               } else if (Array.isArray(node.next)) {
                  node.next.forEach(toId => connections.push({ toId, port: 'out' }));
               }

               return connections.map(conn => {
                 const target = nodes.find(n => n.id === conn.toId);
                 if (!target) return null;

                 const startX = node.x + 300;
                 const startY = node.y + (conn.port === 'true' ? 80 : conn.port === 'false' ? 120 : 100);
                 const endX = target.x;
                 const endY = target.y + 100;

                 const cp1X = startX + (endX - startX) * 0.5;
                 const cp2X = startX + (endX - startX) * 0.5;

                 return (
                   <g key={`${node.id}-${conn.toId}-${conn.port}`}>
                      <path 
                        d={`M ${startX} ${startY} C ${cp1X} ${startY} ${cp2X} ${endY} ${endX} ${endY}`} 
                        stroke={conn.port === 'true' ? '#10B981' : conn.port === 'false' ? '#F43F5E' : '#6366F1'} 
                        strokeWidth="3" fill="none" className="opacity-40 animate-dash" 
                        strokeDasharray="8 8"
                      />
                      <foreignObject x={(startX+endX)/2 - 12} y={(startY+endY)/2 - 12} width="24" height="24" className="pointer-events-auto">
                        <button onClick={() => disconnect(node.id, conn.toId, conn.port)} className="w-6 h-6 bg-white border border-slate-200 rounded-full flex items-center justify-center text-slate-300 hover:text-rose-600 hover:border-rose-100 shadow-sm transition-all"><Unlink size={10}/></button>
                      </foreignObject>
                   </g>
                 );
               });
             })}
          </svg>

          {/* NODES */}
          <div className="absolute inset-0 z-10 p-12 overflow-visible">
            {nodes.map(node => (
              <div 
                key={node.id} 
                className={`absolute bg-white border ${draggedNode === node.id ? 'border-indigo-500 shadow-2xl scale-[1.02]' : 'border-slate-100 shadow-xl'} rounded-[2rem] p-6 w-[18rem] group cursor-grab active:cursor-grabbing transition-all hover:border-indigo-200 z-20`}
                style={{ left: node.x, top: node.y }}
                onMouseDown={(e) => onMouseDown(node.id, e)}
              >
                <div className="flex items-center justify-between mb-4">
                   <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white shadow-lg ${
                        node.type === 'trigger' ? 'bg-indigo-600' : 
                        node.type === 'logic' ? 'bg-slate-900' : 
                        node.type === 'response' ? 'bg-emerald-600' : 
                        node.type === 'http' ? 'bg-amber-500' : 
                        node.type === 'query' ? 'bg-rose-600' :
                        node.type === 'data' ? 'bg-cyan-600' :
                        node.type === 'transform' ? 'bg-indigo-600' : 'bg-indigo-500'
                      }`}>
                        {node.type === 'trigger' ? <Zap size={18}/> : 
                         node.type === 'logic' ? <GitBranch size={18}/> : 
                         node.type === 'response' ? <ArrowRight size={18}/> : 
                         node.type === 'query' ? <Terminal size={18}/> :
                         node.type === 'data' ? <Database size={18}/> :
                         node.type === 'rpc' ? <Code size={18}/> : <Layers size={18}/>}
                      </div>
                      <div>
                        <span className="text-[7px] font-black uppercase tracking-widest text-slate-400 block mb-0.5">#{node.id.split('_').pop()}</span>
                        <span className="text-[10px] font-black text-slate-900 uppercase tracking-tighter">{node.label}</span>
                      </div>
                   </div>
                   <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => setConfigNodeId(node.id)} className="p-1.5 hover:bg-slate-50 rounded-lg text-slate-300 hover:text-indigo-600 transition-all"><Settings size={14}/></button>
                      <button onClick={() => setNodes(nodes.filter(n => n.id !== node.id))} className="p-1.5 hover:bg-slate-50 rounded-lg text-slate-300 hover:text-rose-600 transition-all"><Trash2 size={14}/></button>
                   </div>
                </div>

                <p className="text-[9px] text-slate-500 font-medium truncate mb-2 opacity-60">
                   {node.type === 'trigger' ? `${editingAutomation?.trigger_config?.table || '*'} • ${editingAutomation?.trigger_config?.event || '*'}` : 
                    node.type === 'logic' ? 'Processamento Condicional' : 'Configuração Enterprise'}
                </p>

                {/* PORTS */}
                <div className="port absolute -left-2.5 top-1/2 -translate-y-1/2 w-5 h-5 bg-white border-2 border-slate-100 rounded-full flex items-center justify-center cursor-pointer hover:border-indigo-400 z-30 transition-all shadow-md group/port" onClick={() => handlePortClick(node.id, 'out')}>
                   <div className="w-1.5 h-1.5 rounded-full bg-slate-200 group-hover/port:bg-indigo-400"></div>
                </div>

                {node.type === 'logic' ? (
                  <>
                    <div className="port absolute -right-2.5 top-[70px] w-5 h-5 bg-white border-2 border-emerald-100 rounded-full flex items-center justify-center cursor-pointer hover:border-emerald-500 z-30 transition-all shadow-md group/port" onClick={() => handlePortClick(node.id, 'true')}>
                       <div className="w-1.5 h-1.5 rounded-full bg-emerald-200 group-hover/port:bg-emerald-500"></div>
                       <span className="absolute left-6 text-[7px] font-black text-emerald-500 uppercase tracking-widest opacity-0 group-hover/port:opacity-100 transition-opacity">True</span>
                    </div>
                    <div className="port absolute -right-2.5 top-[110px] w-5 h-5 bg-white border-2 border-rose-100 rounded-full flex items-center justify-center cursor-pointer hover:border-rose-500 z-30 transition-all shadow-md group/port" onClick={() => handlePortClick(node.id, 'false')}>
                       <div className="w-1.5 h-1.5 rounded-full bg-rose-200 group-hover/port:bg-rose-500"></div>
                       <span className="absolute left-6 text-[7px] font-black text-rose-500 uppercase tracking-widest opacity-0 group-hover/port:opacity-100 transition-opacity">False</span>
                    </div>
                  </>
                ) : (
                  <div className="port absolute -right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 bg-white border-2 border-slate-100 rounded-full flex items-center justify-center cursor-pointer hover:border-indigo-400 z-30 transition-all shadow-md group/port" onClick={() => handlePortClick(node.id, 'out')}>
                    <div className={`w-1.5 h-1.5 rounded-full ${connectingFrom?.id === node.id ? 'bg-indigo-600 animate-pulse' : 'bg-slate-200 group-hover/port:bg-indigo-400'}`}></div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* TOOLBOX */}
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur-2xl border border-slate-200 rounded-[2.5rem] px-10 py-5 shadow-2xl flex items-center gap-8 z-40 transition-all hover:border-indigo-100">
             <ToolboxItem icon={<GitBranch size={20}/>} label="Logic" onClick={() => addNode('logic')} color="bg-slate-900" />
             <ToolboxItem icon={<Globe size={20}/>} label="HTTP" onClick={() => addNode('http')} color="bg-amber-500" />
             <ToolboxItem icon={<Terminal size={20}/>} label="SQL" onClick={() => addNode('query')} color="bg-rose-600" />
             <ToolboxItem icon={<Database size={20}/>} label="Data" onClick={() => addNode('data')} color="bg-cyan-600" />
             <ToolboxItem icon={<Layers size={20}/>} label="Transform" onClick={() => addNode('transform')} color="bg-indigo-600" />
             <div className="w-[1px] h-10 bg-slate-100 mx-1"></div>
             <ToolboxItem icon={<ArrowRight size={20}/>} label="Output" onClick={() => addNode('response')} color="bg-emerald-600" />
          </div>
        </div>

        {/* N8N STYLE MODAL OVERLAY */}
        {configNodeId && activeNode && (
          <div className="fixed inset-0 z-[100] flex items-center justify-end animate-in fade-in duration-300">
             <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setConfigNodeId(null)}></div>
             <div className="relative w-[45rem] h-full bg-white shadow-2xl flex flex-col animate-in slide-in-from-right duration-500">
                <header className="p-8 border-b border-slate-50 flex items-center justify-between">
                   <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg">
                         <Settings size={22}/>
                      </div>
                      <div>
                         <h2 className="text-xl font-black text-slate-900 uppercase tracking-tighter">Configuração do Nó</h2>
                         <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{activeNode.type} • {activeNode.id}</p>
                      </div>
                   </div>
                   <button onClick={() => setConfigNodeId(null)} className="w-10 h-10 hover:bg-slate-50 rounded-xl flex items-center justify-center text-slate-400 transition-all"><X size={20}/></button>
                </header>
                
                <div className="flex-1 overflow-y-auto p-12 custom-scrollbar">
                   {activeNode.type === 'trigger' && (
                     <div className="space-y-8">
                        <div className="space-y-4">
                           <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Tabela de Interceptação</label>
                           <select 
                             value={editingAutomation?.trigger_config?.table || ''}
                             onChange={(e) => {
                               const val = e.target.value;
                               if (editingAutomation) {
                                  setEditingAutomation({...editingAutomation, trigger_config: {...(editingAutomation.trigger_config || {}), table: val}});
                                  handleFetchColumns(val);
                               }
                             }}
                             className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 text-sm font-bold outline-none focus:ring-4 focus:ring-indigo-500/10">
                             {tables.map((t: any) => <option key={typeof t === 'string' ? t : (t as any).name} value={typeof t === 'string' ? t : (t as any).name}>{typeof t === 'string' ? t : (t as any).name}</option>)}
                           </select>
                        </div>
                        <div className="space-y-4">
                           <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Eventos</label>
                           <div className="grid grid-cols-4 gap-2">
                              {['*', 'INSERT', 'UPDATE', 'DELETE'].map((ev: string) => (
                                <button key={ev} onClick={() => editingAutomation && setEditingAutomation({...editingAutomation, trigger_config: {...(editingAutomation.trigger_config || {}), event: ev}})} className={`py-4 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${editingAutomation?.trigger_config?.event === ev ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100' : 'bg-slate-50 text-slate-400 hover:bg-slate-100'}`}>{ev}</button>
                              ))}
                           </div>
                        </div>
                     </div>
                   )}

                   {activeNode.type === 'logic' && (
                      <div className="space-y-8">
                         <div className="flex items-center justify-between">
                            <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Condições de Saída</label>
                            <div className="flex bg-slate-50 p-1 rounded-xl">
                               <button onClick={() => setNodes(nodes.map(n => n.id === activeNode.id ? {...n, config: {...n.config, match: 'all'}} : n))} className={`px-4 py-2 rounded-lg text-[9px] font-black uppercase transition-all ${activeNode.config.match === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}>AND</button>
                               <button onClick={() => setNodes(nodes.map(n => n.id === activeNode.id ? {...n, config: {...n.config, match: 'any'}} : n))} className={`px-4 py-2 rounded-lg text-[9px] font-black uppercase transition-all ${activeNode.config.match === 'any' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}>OR</button>
                            </div>
                         </div>
                         <div className="space-y-4">
                            {activeNode.config.conditions?.map((c: any, i: number) => (
                               <div key={i} className="bg-slate-50 rounded-[2rem] p-6 flex items-center gap-4 group">
                                  <select 
                                    className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold"
                                    value={c.left}
                                    onChange={(e) => {
                                       const nc = [...activeNode.config.conditions];
                                       nc[i].left = e.target.value;
                                       setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, conditions: nc}} : n));
                                    }}
                                  >
                                     <option value="">Selecione a Coluna</option>
                                     {(editingAutomation?.trigger_config?.table && columns[editingAutomation.trigger_config.table] || []).map(col => <option key={col} value={`trigger.data.${col}`}>{col}</option>)}
                                  </select>
                                  <select 
                                    className="w-32 bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-black"
                                    value={c.op}
                                    onChange={(e) => {
                                       const nc = [...activeNode.config.conditions];
                                       nc[i].op = e.target.value;
                                       setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, conditions: nc}} : n));
                                    }}
                                  >
                                     <option value="eq">==</option>
                                     <option value="neq">!=</option>
                                     <option value="gt">&gt;</option>
                                     <option value="lt">&lt;</option>
                                     <option value="contains">CONTAINS</option>
                                  </select>
                                  <input 
                                    className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold"
                                    placeholder="Valor"
                                    value={c.right}
                                    onChange={(e) => {
                                       const nc = [...activeNode.config.conditions];
                                       nc[i].right = e.target.value;
                                       setNodes(nodes.map(n => n.id === activeNode.id ? {...n, config: {...n.config, conditions: nc}} : n));
                                    }}
                                  />
                                  <button className="text-slate-200 hover:text-rose-500 transition-colors"><Trash2 size={16}/></button>
                               </div>
                            ))}
                            <button 
                              onClick={() => {
                                const nc = [...(activeNode.config.conditions || []), { left: '', op: 'eq', right: '' }];
                                setNodes(nodes.map(n => n.id === activeNode.id ? {...n, config: {...n.config, conditions: nc}} : n));
                              }}
                              className="w-full py-4 border-2 border-dashed border-slate-100 rounded-[2rem] text-slate-300 hover:text-indigo-600 hover:border-indigo-100 transition-all font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2"
                            >
                              <Plus size={14}/> Adicionar Condição
                            </button>
                         </div>
                      </div>
                   )}

                   {activeNode.type === 'http' && (
                      <div className="space-y-8">
                         <div className="space-y-4">
                            <label className="text-xs font-black text-slate-900 uppercase tracking-widest">URL do Endpoint</label>
                            <div className="flex gap-2">
                               <select className="w-32 bg-slate-900 text-white border-none rounded-2xl px-4 py-3 text-[10px] font-black uppercase tracking-widest" value={activeNode.config.method} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, method: e.target.value}} : n))}>
                                  <option>GET</option>
                                  <option>POST</option>
                                  <option>PUT</option>
                                  <option>DELETE</option>
                               </select>
                               <input className="flex-1 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm font-bold" placeholder="https://api.exemplo.com/v1" value={activeNode.config.url} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, url: e.target.value}} : n))} />
                            </div>
                         </div>
                         <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-4">
                               <label className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-2"><Key size={12} className="text-amber-500"/> Autenticação</label>
                               <select className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold" value={activeNode.config.auth} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, auth: e.target.value}} : n))}>
                                  <option value="none">Nenhuma</option>
                                  <option value="bearer">Bearer Token</option>
                                  <option value="apikey">Basic Auth (User/Pass)</option>
                               </select>
                            </div>
                            <div className="space-y-4">
                               <label className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-2"><RefreshCcw size={12} className="text-emerald-500"/> Retentativas</label>
                               <input type="number" className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold" value={activeNode.config.retries} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, retries: parseInt(e.target.value)}} : n))} />
                            </div>
                         </div>

                         {activeNode.config.auth !== 'none' && (
                            <div className="bg-slate-50 p-6 rounded-3xl space-y-4">
                               {activeNode.config.auth === 'bearer' && (
                                  <div className="space-y-2">
                                     <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Bearer Token / Vault ID</label>
                                     <div className="flex gap-2">
                                        <input className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs" placeholder="Token ou vault://name" value={activeNode.config.auth_token || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, auth_token: e.target.value}} : n))} />
                                        <select className="bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold" onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, auth_token: `vault://${e.target.value}`}} : n))}>
                                           <option value="">Vault Secrets</option>
                                           {vaultSecrets.map((s: any) => <option key={s.id} value={s.name}>{s.name}</option>)}
                                        </select>
                                     </div>
                                  </div>
                               )}
                               {activeNode.config.auth === 'apikey' && (
                                  <div className="grid grid-cols-2 gap-4">
                                     <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Username</label>
                                        <input className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs" value={activeNode.config.auth_user || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, auth_user: e.target.value}} : n))} />
                                     </div>
                                     <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Password / Secret</label>
                                        <input className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs" type="password" value={activeNode.config.auth_pass || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, auth_pass: e.target.value}} : n))} />
                                     </div>
                                  </div>
                               )}
                            </div>
                         )}

                         <div className="space-y-4">
                            <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Headers Customizados (Opcional)</label>
                            <textarea className="w-full h-24 bg-slate-900 text-amber-400 font-mono text-[10px] p-4 rounded-xl border border-slate-800 outline-none" placeholder='{"X-Custom-Header": "value"}' value={typeof activeNode.config.headers === 'string' ? activeNode.config.headers : JSON.stringify(activeNode.config.headers, null, 2)} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                               try { const p = JSON.parse(e.target.value); setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, headers: p}} : n)); }
                               catch { setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, headers: e.target.value}} : n)); }
                            }} />
                         </div>

                         <div className="space-y-4">
                            <label className="text-xs font-black text-slate-900 uppercase tracking-widest">JSON Body</label>
                            <textarea className="w-full h-40 bg-slate-900 text-emerald-400 font-mono text-xs p-6 rounded-2xl border border-slate-800 outline-none" placeholder='{"key": "value"}' value={typeof activeNode.config.body === 'string' ? activeNode.config.body : JSON.stringify(activeNode.config.body, null, 2)} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                               try { const p = JSON.parse(e.target.value); setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, body: p}} : n)); }
                               catch { setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, body: e.target.value}} : n)); }
                            }} />
                         </div>
                      </div>
                   )}

                   {activeNode.type === 'query' && (
                      <div className="space-y-8">
                         <div className="space-y-4">
                            <label className="text-xs font-black text-slate-900 uppercase tracking-widest">SQL Statement (Restricted RLS)</label>
                            <textarea className="w-full h-80 bg-slate-900 text-amber-400 font-mono text-xs p-8 rounded-[2.5rem] border border-slate-800 outline-none shadow-2xl" value={activeNode.config.sql} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, sql: e.target.value}} : n))} />
                         </div>
                         <div className="bg-amber-50 rounded-2xl p-6 border border-amber-100">
                            <h4 className="flex items-center gap-2 text-amber-800 font-black text-[10px] uppercase tracking-widest mb-2"><Shield size={12}/> Security Note</h4>
                            <p className="text-[9px] text-amber-700/70 font-bold uppercase leading-relaxed">Este nó executa com a ROLE do usuário que acionou o gatilho. Comandos COPY, DO $$, e acesso a arquivos são bloqueados pelo motor.</p>
                         </div>
                      </div>
                   )}

                   {activeNode.type === 'data' && (
                      <div className="space-y-8">
                         <div className="grid grid-cols-2 gap-6">
                            <div className="space-y-4">
                               <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Operação</label>
                               <select className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold" value={activeNode.config.operation} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, operation: e.target.value}} : n))}>
                                  <option value="select">SELECT (Read)</option>
                                  <option value="insert">INSERT (Create)</option>
                                  <option value="update">UPDATE (Edit)</option>
                                  <option value="delete">DELETE (Remove)</option>
                               </select>
                            </div>
                            <div className="space-y-4">
                               <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Tabela</label>
                               <select className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold" value={activeNode.config.table} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, table: e.target.value}} : n))}>
                                  <option value="">Selecione...</option>
                                  {tables.map((t: string | { name: string }) => <option key={typeof t === 'string' ? t : t.name} value={typeof t === 'string' ? t : t.name}>{typeof t === 'string' ? t : t.name}</option>)}
                               </select>
                            </div>
                         </div>
                         {(activeNode.config.operation !== 'insert') && (
                            <div className="space-y-4">
                               <div className="flex items-center justify-between">
                                  <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Filtros (WHERE)</label>
                                  <p className="text-[8px] text-slate-400 font-bold uppercase">Usa ROLE do trigger</p>
                               </div>
                               {activeNode.config.filters?.map((f: { column: string; op: string; value: string }, i: number) => (
                                  <div key={i} className="flex gap-2 items-center bg-slate-50 p-3 rounded-2xl border border-slate-100">
                                     <select className="flex-1 bg-white border border-slate-200 rounded-xl px-2 py-2 text-[10px] font-bold" value={f.column} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                                        const nf = [...activeNode.config.filters]; nf[i].column = e.target.value;
                                        setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, filters: nf}} : n));
                                     }}>
                                        <option value="">Coluna...</option>
                                        {(activeNode.config.table && columns[activeNode.config.table] || []).map((col: string) => <option key={col} value={col}>{col}</option>)}
                                     </select>
                                     <select className="w-16 bg-white border border-slate-200 rounded-xl px-2 py-2 text-[10px] font-bold" value={f.op} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                                        const nf = [...activeNode.config.filters]; nf[i].op = e.target.value;
                                        setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, filters: nf}} : n));
                                     }}>
                                        <option value="eq">=</option>
                                        <option value="neq">!=</option>
                                        <option value="gt">&gt;</option>
                                        <option value="lt">&lt;</option>
                                        <option value="like">LIKE</option>
                                        <option value="ilike">ILIKE</option>
                                     </select>
                                     <input className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-2 text-[10px] font-medium" placeholder="Valor ou {{var}}" value={f.value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                        const nf = [...activeNode.config.filters]; nf[i].value = e.target.value;
                                        setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, filters: nf}} : n));
                                     }} />
                                     <button className="text-slate-300 hover:text-rose-500 transition-colors" onClick={() => {
                                        const nf = activeNode.config.filters.filter((_: any, idx: number) => idx !== i);
                                        setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, filters: nf}} : n));
                                     }}><Trash2 size={14}/></button>
                                  </div>
                               ))}
                               <button className="w-full py-3 border border-dashed border-slate-200 rounded-2xl text-[10px] font-black uppercase text-slate-400 hover:text-indigo-600 hover:border-indigo-200 transition-all bg-white" onClick={() => {
                                  const nf = [...(activeNode.config.filters || []), { column: '', op: 'eq', value: '' }];
                                  setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, filters: nf}} : n));
                               }}>+ Adicionar Filtro</button>
                            </div>
                         )}

                         {(activeNode.config.operation === 'insert' || activeNode.config.operation === 'update') && (
                            <div className="space-y-4">
                               <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Dados (Payload)</label>
                               <textarea className="w-full h-40 bg-slate-900 text-cyan-400 font-mono text-xs p-6 rounded-2xl border border-slate-800 outline-none" placeholder='{"campo": "{{trigger.data.id}}"}' value={typeof activeNode.config.body === 'string' ? activeNode.config.body : JSON.stringify(activeNode.config.body, null, 2)} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                                  try { const p = JSON.parse(e.target.value); setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, body: p}} : n)); }
                                  catch { setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, body: e.target.value}} : n)); }
                               }} />
                            </div>
                         )}
                      </div>
                   )}

                   {activeNode.type === 'transform' && (
                      <div className="space-y-8">
                         <div className="space-y-4">
                            <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Mapeamento JSON</label>
                            <textarea className="w-full h-80 bg-slate-900 text-indigo-400 font-mono text-xs p-8 rounded-[2.5rem] border border-slate-800 outline-none shadow-2xl" value={typeof activeNode.config.body === 'string' ? activeNode.config.body : JSON.stringify(activeNode.config.body, null, 2)} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                               try { const p = JSON.parse(e.target.value); setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, body: p}} : n)); }
                               catch { setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, body: e.target.value}} : n)); }
                            }} />
                            <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest leading-relaxed">Dica: Use {"{{node_id.data.campo}}"} para injetar dados de outros nós.</p>
                         </div>
                      </div>
                   )}

                   {activeNode.type === 'rpc' && (
                      <div className="space-y-8">
                         <div className="space-y-4">
                            <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Database Function (RPC)</label>
                            <input className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm font-bold" placeholder="api.minha_funcao" value={activeNode.config.function} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, function: e.target.value}} : n))} />
                         </div>
                         <div className="space-y-4">
                            <div className="flex items-center justify-between">
                               <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Argumentos (JSON Array)</label>
                               <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest">Ex: {"[\"{{trigger.data.id}}\", 123]"}</p>
                            </div>
                            <textarea 
                              className="w-full h-40 bg-slate-900 text-indigo-300 font-mono text-xs p-6 rounded-2xl border border-slate-800 outline-none" 
                              placeholder='["arg1", "arg2"]' 
                              value={typeof activeNode.config.args === 'string' ? activeNode.config.args : JSON.stringify(activeNode.config.args, null, 2)} 
                              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                                 try { const p = JSON.parse(e.target.value); setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, args: p}} : n)); }
                                 catch { setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, args: e.target.value}} : n)); }
                              }} 
                            />
                         </div>
                      </div>
                   )}

                   {activeNode.type === 'response' && (
                      <div className="space-y-6">
                         <div className="space-y-4">
                            <label className="text-xs font-black text-slate-900 uppercase tracking-widest">HTTP Status Code</label>
                            <input type="number" className="w-32 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm font-bold" value={activeNode.config.status_code || 200} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, status_code: parseInt(e.target.value) || 200}} : n))} />
                         </div>
                         <div className="space-y-4">
                            <div className="flex items-center justify-between">
                               <label className="text-xs font-black text-slate-900 uppercase tracking-widest">JSON Response Payload</label>
                               <div className="relative group/help">
                                 <button className="text-[10px] font-black text-indigo-600 uppercase flex items-center gap-2 hover:bg-indigo-50 px-3 py-1.5 rounded-lg transition-all"><Terminal size={12}/> Injetar Variável</button>
                                 <div className="absolute right-0 bottom-full mb-2 w-48 bg-slate-900 text-white p-4 rounded-2xl text-[10px] font-medium opacity-0 group-hover/help:opacity-100 transition-opacity z-50 pointer-events-none shadow-2xl border border-slate-700">
                                    <span className="text-indigo-400 font-black block mb-2 uppercase">Variáveis:</span>
                                    <code className="text-emerald-400 block mb-1">{"{{"}trigger.data.*{"}}"}</code>
                                    <code className="text-emerald-400 block">{"{{"}node_id.data.*{"}}"}</code>
                                 </div>
                               </div>
                            </div>
                            <textarea 
                              className="w-full h-80 bg-slate-900 text-emerald-400 font-mono text-xs p-8 rounded-[2.5rem] border border-slate-800 outline-none shadow-2xl custom-scrollbar"
                              value={typeof activeNode.config.body === 'string' ? activeNode.config.body : JSON.stringify(activeNode.config.body, null, 2)}
                              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                                 try {
                                    const parsed = JSON.parse(e.target.value);
                                    setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, body: parsed}} : n));
                                 } catch {
                                    setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, body: e.target.value}} : n));
                                 }
                              }}
                            />
                         </div>
                      </div>
                   )}
                </div>

                <footer className="p-8 border-t border-slate-50 flex justify-end">
                    <button onClick={() => setConfigNodeId(null)} className="bg-slate-900 text-white px-10 py-3.5 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-black transition-all shadow-xl shadow-slate-100 flex items-center gap-3">
                       <Check size={16}/> Confirmar Configuração
                    </button>
                </footer>
             </div>
          </div>
        )}

        <style>{`
          @keyframes dash {
            to { stroke-dashoffset: -1000; }
          }
          .animate-dash { animation: dash 60s linear infinite; }
          .custom-scrollbar::-webkit-scrollbar { width: 4px; }
          .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
          .custom-scrollbar::-webkit-scrollbar-thumb { background: #E2E8F0; border-radius: 10px; }
        `}</style>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      
      {/* Notifications */}
      {(success || error) && (
          <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[600] px-6 py-3 rounded-full shadow-xl flex items-center gap-3 animate-in slide-in-from-top-4 ${error ? 'bg-rose-600' : 'bg-slate-900'} text-white`}>
              {error ? <AlertCircle size={18}/> : <CheckCircle2 size={18} className="text-emerald-400"/>}
              <span className="text-xs font-black uppercase tracking-widest">{success || error}</span>
          </div>
      )}

      <header className="flex items-center justify-between">
        <div className="flex bg-slate-100 p-1 rounded-2xl shadow-inner">
           <button onClick={() => setActiveTab('workflows')} className={`px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'workflows' ? 'bg-white text-slate-900 shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>Orquestrações</button>
           <button onClick={() => setActiveTab('runs')} className={`px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'runs' ? 'bg-white text-slate-900 shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>Logs de Execução</button>
        </div>
        <button onClick={handleCreateNew} className="bg-slate-900 text-white px-8 py-4 rounded-[2rem] font-black text-[10px] uppercase tracking-widest flex items-center gap-3 hover:bg-black transition-all shadow-2xl hover:scale-[1.02] active:scale-95">
           <div className="w-5 h-5 bg-indigo-500 rounded-lg flex items-center justify-center"><Plus size={14} /></div>
           Criar Novo Fluxo
        </button>
      </header>

      {loading ? (
        <div className="py-40 flex flex-col items-center justify-center text-slate-200">
          <Loader2 size={60} className="animate-spin mb-6" />
          <p className="text-[10px] font-black uppercase tracking-widest">Sincronizando Engine...</p>
        </div>
      ) : activeTab === 'workflows' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {automations.map((auto: Automation) => (
            <div key={auto.id} className="bg-white border border-slate-100 rounded-[3rem] p-10 shadow-sm hover:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.05)] transition-all group relative overflow-hidden border-b-4 border-b-indigo-50">
               <div className="flex items-start justify-between mb-8">
                 <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg ${auto.is_active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-300'}`}>
                   <Workflow size={24} />
                 </div>
                 <div className="flex items-center gap-1">
                   <button onClick={() => { setEditingAutomation(auto); setNodes(auto.nodes || []); setView('composer'); }} className="p-2.5 hover:bg-slate-50 rounded-xl text-slate-200 hover:text-indigo-600 transition-all"><Settings size={18}/></button>
                   <button onClick={() => handleDelete(auto.id)} className="p-2.5 hover:bg-slate-50 rounded-xl text-slate-200 hover:text-rose-600 transition-all"><Trash2 size={18}/></button>
                 </div>
               </div>
               <h4 className="text-xl font-black text-slate-900 mb-2 truncate uppercase tracking-tighter">{auto.name}</h4>
               <p className="text-xs text-slate-400 font-medium mb-8 line-clamp-2 h-8">{auto.description}</p>
               
               <div className="flex flex-wrap gap-2 mb-8 border-t border-slate-50 pt-6">
                  {(() => {
                    const s = stats[auto.id];
                    const totalRuns   = s?.total_runs   ?? 0;
                    const avgMs       = s?.avg_ms       ?? 0;
                    const failedCount = s?.failed_count ?? 0;
                    const hasFailures = failedCount > 0;
                    return (
                      <>
                        <span className="text-[8px] font-black bg-indigo-50 text-indigo-600 px-3 py-1.5 rounded-lg uppercase tracking-widest flex items-center gap-2" title={`${s?.success_count ?? 0} sucessos / ${failedCount} falhas`}>
                          <Activity size={10} className={totalRuns > 0 ? 'animate-pulse' : ''}/>
                          {totalRuns} {totalRuns === 1 ? 'execução' : 'execuções'}
                        </span>
                        <span className={`text-[8px] font-black px-3 py-1.5 rounded-lg uppercase tracking-widest flex items-center gap-2 ${
                          avgMs === 0 ? 'bg-slate-50 text-slate-400' :
                          hasFailures ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'
                        }`} title={s?.last_run_at ? `Último: ${new Date(s.last_run_at).toLocaleString()}` : 'Sem execuções ainda'}>
                          <Zap size={10}/>{avgMs > 0 ? `${avgMs}ms avg` : '-- ms'}
                        </span>
                        {hasFailures && (
                          <span className="text-[8px] font-black bg-rose-50 text-rose-500 px-3 py-1.5 rounded-lg uppercase tracking-widest flex items-center gap-2">
                            <AlertCircle size={10}/> {failedCount} {failedCount === 1 ? 'falha' : 'falhas'}
                          </span>
                        )}
                      </>
                    );
                  })()}
               </div>

               <div className="flex items-center justify-between">
                   <div className="flex items-center gap-2">
                     <div className={`w-2 h-2 rounded-full ${auto.is_active ? 'bg-emerald-500 shadow-[0_0_10px_#10b981]' : 'bg-slate-200'}`}></div>
                     <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">{auto.is_active ? 'Live' : 'Paused'}</span>
                   </div>
                   <div className="flex items-center gap-2">
                     <button onClick={() => { setRunsFilter(auto.id); fetchRuns(auto.id); setActiveTab('runs'); }} className="text-[8px] font-black text-slate-400 uppercase tracking-widest hover:bg-slate-50 px-3 py-2 rounded-lg transition-all border border-slate-100 flex items-center gap-1">
                       <History size={10}/> Logs
                     </button>
                     <button onClick={() => handleToggle(auto)} className="text-[8px] font-black text-slate-900 uppercase tracking-widest hover:bg-slate-50 px-4 py-2 rounded-lg transition-all border border-slate-100">Toggle</button>
                   </div>
                </div>
            </div>
          ))}
          {automations.length === 0 && (
             <div className="col-span-full py-40 bg-slate-50/50 border-4 border-dashed border-slate-100 rounded-[4rem] flex flex-col items-center justify-center text-slate-300">
                <Layout size={64} className="mb-6 opacity-20"/>
                <p className="text-xs font-black uppercase tracking-[0.2em]">O Orquestrador aguarda sua visão.</p>
             </div>
          )}
        </div>
      ) : (
        <div className="bg-white border border-slate-100 rounded-[3rem] overflow-hidden shadow-2xl">
           <table className="w-full text-left">
             <thead>
               <tr className="bg-slate-50/50 border-b border-slate-100 text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">
                 <th className="px-10 py-8">Status</th>
                 <th className="px-10 py-8">Timestamp de Execução</th>
                 <th className="px-10 py-8">Latência Real</th>
                 <th className="px-10 py-8 text-right">Ação</th>
               </tr>
             </thead>
             <tbody className="divide-y divide-slate-50">
               {runs.map((run: ExecutionRun) => (
                 <tr key={run.id} className="hover:bg-slate-50/30 transition-all font-medium">
                   <td className="px-10 py-8">
                     <div className="flex items-center gap-2">
                        <CheckCircle2 size={16} className={run.status === 'success' ? 'text-emerald-500' : 'text-rose-500'}/>
                        <span className={`text-[10px] font-black uppercase tracking-widest ${run.status === 'success' ? 'text-emerald-600' : 'text-rose-600'}`}>{run.status}</span>
                     </div>
                   </td>
                   <td className="px-10 py-8 font-mono text-[10px] text-slate-500">{new Date(run.created_at).toLocaleString()}</td>
                   <td className="px-10 py-8">
                      <div className="flex items-center gap-2">
                         <div className="w-16 h-1 bg-slate-100 rounded-full overflow-hidden">
                            <div className="h-full bg-indigo-500" style={{ width: `${Math.min(run.execution_time_ms / 10, 100)}%` }}></div>
                         </div>
                         <span className="font-mono text-[10px] text-slate-400">{run.execution_time_ms}ms</span>
                       </div>
                    </td>
                    <td className="px-10 py-8 text-right"><button className="text-[9px] font-black text-indigo-600 hover:text-indigo-800 uppercase tracking-widest bg-indigo-50/50 px-4 py-2 rounded-lg transition-all">Ver Detalhes</button></td>
                  </tr>
               ))}
             </tbody>
           </table>
        </div>
      )}
    </div>
  );
};

const ToolboxItem: React.FC<{ icon: React.ReactNode, label: string, onClick: () => void, color: string }> = ({ icon, label, onClick, color }) => (
  <button onClick={onClick} className="flex flex-col items-center gap-2 group transition-all hover:-translate-y-2">
    <div className={`w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-300 group-hover:${color} group-hover:text-white transition-all shadow-inner border border-transparent group-hover:shadow-[0_15px_30px_-5px_rgba(0,0,0,0.1)]`}>
      {icon}
    </div>
    <span className="text-[8px] font-black uppercase text-slate-400 group-hover:text-slate-900 tracking-widest transition-colors">{label}</span>
  </button>
);

export default AutomationManager;
