
import React, { useState, useEffect, useRef } from 'react';
import { 
  Zap, Plus, Trash2, Activity, Play, 
  CheckCircle2, AlertCircle, Loader2, 
  Settings, X, Filter, GitBranch, Terminal,
  History, ToggleLeft as Toggle, Layout, Workflow,
  ChevronRight, Save, Database, Globe, MousePointer2,
  ArrowRight, Maximize2, Minimize2, Code, ChevronDown,
  Link as LinkIcon, Unlink
} from 'lucide-react';

interface Node {
  id: string;
  type: 'trigger' | 'query' | 'http' | 'logic' | 'response';
  x: number;
  y: number;
  label: string;
  config: any;
  next?: string[];
}

const AutomationManager: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [automations, setAutomations] = useState<any[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'composer'>('list');
  const [activeTab, setActiveTab] = useState<'workflows' | 'runs'>('workflows');
  const [runs, setRuns] = useState<any[]>([]);
  
  // COMPOSER STATE
  const [editingAutomation, setEditingAutomation] = useState<any>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [draggedNode, setDraggedNode] = useState<string | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
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

  const fetchRuns = async () => {
    try {
      const res = await fetch(`/api/data/${projectId}/automations/runs`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      setRuns(Array.isArray(data) ? data : []);
    } catch (e) { console.error("Runs fetch error"); }
  };

  const fetchTables = async () => {
    try {
      const res = await fetch(`/api/data/${projectId}/tables`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      setTables(Array.isArray(data) ? data : []);
    } catch (e) { console.error("Tables fetch error"); }
  };

  useEffect(() => { 
      Promise.all([fetchAutomations(), fetchRuns(), fetchTables()]).then(() => setLoading(false)); 
  }, [projectId]);

  const handleCreateNew = () => {
    setEditingAutomation({
      name: 'Novo Fluxo ' + (automations.length + 1),
      description: 'Orquestração de resposta personalizada.',
      trigger_type: 'API_INTERCEPT',
      trigger_config: { table: tables[0] || '*', event: '*' },
      is_active: true
    });
    setNodes([
      { id: 'node_1', type: 'trigger', x: 80, y: 150, label: 'Trigger', config: {} },
      { id: 'node_2', type: 'response', x: 600, y: 150, label: 'Resposta', config: { body: { success: true, data: "{{node_1.data}}" } }, next: [] }
    ]);
    // Link trigger to response initially
    setNodes(prev => prev.map(n => n.id === 'node_1' ? { ...n, next: ['node_2'] } : n));
    setView('composer');
  };

  const handleEdit = (auto: any) => {
    setEditingAutomation(auto);
    setNodes(auto.nodes || []);
    setView('composer');
  };

  const handleSave = async () => {
    if (!editingAutomation.name) { setError("Nome é obrigatório."); return; }
    setSubmitting(true);
    try {
      const payload = { ...editingAutomation, nodes };
      await fetch(`/api/data/${projectId}/automations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
        body: JSON.stringify(payload)
      });
      setView('list');
      fetchAutomations();
      setSuccess("Orquestração salva com sucesso!");
    } catch (e) { setError("Erro ao salvar fluxo."); }
    finally { setSubmitting(false); setTimeout(() => setSuccess(null), 3000); }
  };

  const handleDelete = async (id: string) => {
      if(!confirm("Deseja deletar este fluxo?")) return;
      try {
          await fetch(`/api/data/${projectId}/automations/${id}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          fetchAutomations();
          setSuccess("Removido.");
      } catch(e) { setError("Falha ao deletar."); }
      setTimeout(() => setSuccess(null), 3000);
  };

  const handleToggle = async (auto: any) => {
      try {
          await fetch(`/api/data/${projectId}/automations`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ ...auto, is_active: !auto.is_active })
          });
          fetchAutomations();
      } catch(e) { setError("Erro ao mudar status."); }
  };

  // NODE MGMT
  const addNode = (type: Node['type']) => {
    const id = `node_${Date.now()}`;
    const newNode: Node = {
      id, type, x: 300, y: 200, label: type.toUpperCase(),
      config: type === 'query' ? { sql: 'SELECT * FROM users LIMIT 1', params: [] } :
              type === 'http' ? { url: 'https://api.exemplo.com/web', method: 'POST', body: {} } :
              type === 'logic' ? { left: 'node_1.data.status', op: 'eq', right: 'active' } :
              type === 'response' ? { body: { ok: true } } : {},
      next: []
    };
    setNodes([...nodes, newNode]);
  };

  const removeNode = (id: string) => {
    setNodes(nodes.filter(n => n.id !== id).map(n => ({
      ...n, next: (n.next || []).filter(nid => nid !== id)
    })));
  };

  // DRAG & CONNECT LOGIC
  const onMouseDown = (id: string, e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.port')) return;
    setDraggedNode(id);
    const node = nodes.find(n => n.id === id);
    if (node) setOffset({ x: e.clientX - node.x, y: e.clientY - node.y });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (draggedNode) {
      setNodes(nodes.map(n => n.id === draggedNode ? { ...n, x: e.clientX - offset.x, y: e.clientY - offset.y } : n));
    }
  };

  const onMouseUp = () => {
    setDraggedNode(null);
    setConnectingFrom(null);
  };

  const handleConnect = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setNodes(nodes.map(n => {
      if (n.id === fromId) {
        const next = n.next || [];
        if (next.includes(toId)) return n;
        return { ...n, next: [...next, toId] };
      }
      return n;
    }));
    setConnectingFrom(null);
  };

  const disconnect = (fromId: string, toId: string) => {
    setNodes(nodes.map(n => n.id === fromId ? { ...n, next: (n.next || []).filter(id => id !== toId) } : n));
  };

  if (view === 'composer') {
    return (
      <div className="h-[78vh] flex flex-col bg-white border border-slate-200 rounded-[3.5rem] overflow-hidden animate-in zoom-in-95 shadow-2xl relative">
        {/* HEADER */}
        <header className="bg-white border-b border-slate-100 p-8 flex items-center justify-between z-30">
          <div className="flex items-center gap-6">
            <button onClick={() => setView('list')} className="w-12 h-12 flex items-center justify-center hover:bg-slate-50 rounded-2xl text-slate-400 hover:text-slate-900 transition-all border border-transparent hover:border-slate-100">
              <X size={24} />
            </button>
            <div className="h-10 w-[1px] bg-slate-100"></div>
            <div>
              <input 
                value={editingAutomation.name}
                onChange={(e) => setEditingAutomation({...editingAutomation, name: e.target.value})}
                className="text-2xl font-black text-slate-900 outline-none bg-transparent hover:bg-slate-50 px-2 rounded-lg transition-all w-64"
                placeholder="Nome do Fluxo"
              />
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em] mt-1 ml-2">PRO-GRADE Orchestrator <span className="text-indigo-600">v2.1</span></p>
            </div>
          </div>
          <div className="flex items-center gap-4">
             <button 
                onClick={handleSave} 
                className="bg-indigo-600 text-white px-8 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-3 hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100"
             >
               {submitting ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />} Salvar Fluxo
             </button>
          </div>
        </header>

        {/* CANVAS */}
        <div 
          className="flex-1 relative bg-[#FDFDFD] overflow-hidden"
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          ref={canvasRef}
        >
          {/* SVG GRID BACKGROUND */}
          <div className="absolute inset-0 opacity-[0.04] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#000 1.5px, transparent 1.5px)', backgroundSize: '32px 32px' }}></div>
          
          {/* CONNECTIONS LAYER */}
          <svg className="absolute inset-0 pointer-events-none w-full h-full z-0">
             {nodes.map(node => (node.next || []).map(nextId => {
               const target = nodes.find(n => n.id === nextId);
               if (!target) return null;
               
               const startX = node.x + 320; // Width of node card
               const startY = node.y + 100; // Middle of card vertically approx
               const endX = target.x;
               const endY = target.y + 100;
               
               const cp1X = startX + (endX - startX) / 2;
               const cp2X = startX + (endX - startX) / 2;
               
               return (
                 <g key={`${node.id}-${nextId}`} className="group pointer-events-auto cursor-pointer">
                    <path 
                      d={`M ${startX} ${startY} C ${cp1X} ${startY} ${cp2X} ${endY} ${endX} ${endY}`} 
                      stroke="#6366F1" strokeWidth="3" fill="none" 
                      className="opacity-40 group-hover:opacity-100 transition-opacity"
                    />
                    <circle cx={startX} cy={startY} r="4" fill="#6366F1" />
                    <circle cx={endX} cy={endY} r="4" fill="#6366F1" />
                    {/* Disconnect helper */}
                    <foreignObject x={(startX+endX)/2 - 12} y={(startY+endY)/2 - 12} width="24" height="24">
                        <button onClick={() => disconnect(node.id, nextId)} className="w-6 h-6 bg-white border border-slate-200 rounded-full flex items-center justify-center text-slate-400 hover:text-rose-600 hover:border-rose-200 shadow-sm transition-all"><Unlink size={10}/></button>
                    </foreignObject>
                 </g>
               );
             }))}
          </svg>

          {/* NODES LAYER */}
          <div className="absolute inset-0 z-10 p-12">
            {nodes.map(node => (
              <div 
                key={node.id} 
                className={`absolute bg-white border ${draggedNode === node.id ? 'border-indigo-500 shadow-2xl scale-[1.02]' : 'border-slate-100 shadow-xl'} rounded-[2.5rem] p-8 w-[20rem] group cursor-grab active:cursor-grabbing transition-all hover:border-indigo-200 z-20 overflow-visible`}
                style={{ left: node.x, top: node.y }}
                onMouseDown={(e) => onMouseDown(node.id, e)}
              >
                {/* HEADER */}
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg ${
                      node.type === 'trigger' ? 'bg-indigo-600 text-white' : 
                      node.type === 'response' ? 'bg-emerald-600 text-white' : 
                      node.type === 'logic' ? 'bg-slate-900 text-white' : 'bg-slate-900 text-white'
                    }`}>
                      {node.type === 'trigger' ? <Zap size={22}/> : node.type === 'response' ? <ArrowRight size={22}/> : node.type === 'logic' ? <GitBranch size={22}/> : <Database size={22}/>}
                    </div>
                    <div>
                      <h5 className="text-[8px] font-black uppercase tracking-widest text-slate-400">Node ID: {node.id.split('_').pop()}</h5>
                      <span className="text-xs font-black text-slate-900 uppercase tracking-tighter">{node.label}</span>
                    </div>
                  </div>
                  <button onClick={() => removeNode(node.id)} className="text-slate-100 hover:text-rose-600 transition-colors p-1"><Trash2 size={16}/></button>
                </div>

                {/* CONFIG CONTENT */}
                <div className="space-y-4">
                  {node.type === 'trigger' && (
                    <div className="space-y-4">
                      <div className="space-y-1">
                        <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest ml-1">Tabela Alvo</label>
                        <select 
                          value={editingAutomation.trigger_config.table}
                          onChange={(e) => setEditingAutomation({...editingAutomation, trigger_config: {...editingAutomation.trigger_config, table: e.target.value}})}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="w-full bg-slate-50 border border-slate-100 rounded-xl py-3 px-4 text-[10px] font-black text-indigo-600 outline-none appearance-none cursor-pointer">
                          {tables.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                    </div>
                  )}

                  {node.type === 'query' && (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest ml-1">SQL Query</label>
                        <textarea 
                          value={node.config.sql}
                          onChange={(e) => setNodes(nodes.map(n => n.id === node.id ? {...n, config: {...n.config, sql: e.target.value}} : n))}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="w-full bg-slate-900 border border-slate-800 rounded-xl py-3 px-4 text-[10px] font-mono text-indigo-300 outline-none h-20 resize-none"
                        />
                      </div>
                    </div>
                  )}

                  {node.type === 'logic' && (
                    <div className="space-y-3">
                      <input 
                         value={node.config.left}
                         onChange={(e) => setNodes(nodes.map(n => n.id === node.id ? {...n, config: {...n.config, left: e.target.value}} : n))}
                         onMouseDown={(e) => e.stopPropagation()}
                         placeholder="Variavel (ex: trigger.data.status)"
                         className="w-full bg-slate-50 border border-slate-100 rounded-xl py-2 px-3 text-[10px] font-bold"
                      />
                      <select 
                        value={node.config.op}
                        onChange={(e) => setNodes(nodes.map(n => n.id === node.id ? {...n, config: {...n.config, op: e.target.value}} : n))}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="w-full bg-slate-50 border border-slate-100 rounded-xl py-2 px-3 text-[10px] font-black">
                        <option value="eq">Igual a</option>
                        <option value="neq">Diferente de</option>
                        <option value="contains">Contém</option>
                      </select>
                      <input 
                         value={node.config.right}
                         onChange={(e) => setNodes(nodes.map(n => n.id === node.id ? {...n, config: {...n.config, right: e.target.value}} : n))}
                         onMouseDown={(e) => e.stopPropagation()}
                         placeholder="Valor esperado"
                         className="w-full bg-slate-50 border border-slate-100 rounded-xl py-2 px-3 text-[10px] font-bold"
                      />
                    </div>
                  )}

                  {node.type === 'response' && (
                    <div className="space-y-3">
                       <label className="text-[8px] font-black text-slate-400 uppercase tracking-widest ml-1">Custom Response Body</label>
                       <textarea 
                          value={typeof node.config.body === 'string' ? node.config.body : JSON.stringify(node.config.body, null, 2)}
                          onChange={(e) => {
                            try {
                                const parsed = JSON.parse(e.target.value);
                                setNodes(nodes.map(n => n.id === node.id ? {...n, config: {...n.config, body: parsed}} : n));
                            } catch {
                                setNodes(nodes.map(n => n.id === node.id ? {...n, config: {...n.config, body: e.target.value}} : n));
                            }
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="w-full bg-indigo-950/5 border border-indigo-100 rounded-2xl py-3 px-4 text-[10px] font-mono text-emerald-700 outline-none h-24 resize-none"
                        />
                    </div>
                  )}
                </div>
                
                {/* PORTS */}
                <div 
                  className="port absolute -left-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-white border-2 border-slate-100 rounded-full flex items-center justify-center cursor-pointer hover:border-indigo-400 hover:scale-110 transition-all z-30 shadow-md group/port"
                  onClick={() => connectingFrom && handleConnect(connectingFrom, node.id)}
                >
                   <div className={`w-2 h-2 rounded-full ${connectingFrom ? 'bg-indigo-400 animate-pulse' : 'bg-slate-200 group-hover/port:bg-indigo-300'}`}></div>
                </div>
                <div 
                  className="port absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 bg-white border-2 border-slate-100 rounded-full flex items-center justify-center cursor-pointer hover:border-indigo-400 hover:scale-110 transition-all z-30 shadow-md group/port"
                  onClick={() => setConnectingFrom(node.id)}
                >
                   <div className={`w-2 h-2 rounded-full ${connectingFrom === node.id ? 'bg-indigo-500' : 'bg-slate-200 group-hover/port:bg-indigo-300'}`}></div>
                </div>
              </div>
            ))}
          </div>
          
          {/* TOOLBOX */}
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur-2xl border border-slate-200 rounded-[2.5rem] px-10 py-5 shadow-2xl flex items-center gap-8 z-40 transition-all hover:border-indigo-100">
             <ToolboxItem icon={<Database size={20}/>} label="Query" onClick={() => addNode('query')} color="bg-slate-900" />
             <ToolboxItem icon={<Globe size={20}/>} label="HTTP" onClick={() => addNode('http')} color="bg-amber-500" />
             <ToolboxItem icon={<GitBranch size={20}/>} label="Logic" onClick={() => addNode('logic')} color="bg-indigo-600" />
             <div className="w-[1px] h-10 bg-slate-100 mx-1"></div>
             <ToolboxItem icon={<ArrowRight size={20}/>} label="Output" onClick={() => addNode('response')} color="bg-emerald-600" />
          </div>

          {/* CONNECTING FEEDBACK */}
          {connectingFrom && (
             <div className="absolute top-8 left-1/2 -translate-x-1/2 bg-indigo-600 text-white px-6 py-2 rounded-full text-[10px] font-black uppercase tracking-[0.2em] animate-bounce z-50 flex items-center gap-3 shadow-2xl shadow-indigo-200">
                <LinkIcon size={14}/> Selecione o nó de destino
             </div>
          )}
        </div>
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
        <div className="flex bg-slate-100 p-1 rounded-2xl">
           <button onClick={() => setActiveTab('workflows')} className={`px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'workflows' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>Workflows</button>
           <button onClick={() => setActiveTab('runs')} className={`px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'runs' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>Monitoramento</button>
        </div>
        <button onClick={handleCreateNew} className="bg-slate-900 text-white px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-3 hover:bg-black transition-all shadow-2xl">
           <div className="w-5 h-5 bg-indigo-500 rounded-lg flex items-center justify-center"><Plus size={14} /></div>
           Criar Nova Orquestração
        </button>
      </header>

      {loading ? (
        <div className="py-40 flex flex-col items-center justify-center text-slate-200">
          <Loader2 size={60} className="animate-spin mb-6" />
          <p className="text-[10px] font-black uppercase tracking-widest">Iniciando Orchestrator...</p>
        </div>
      ) : activeTab === 'workflows' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {automations.length === 0 && (
            <div className="col-span-full py-40 border border-slate-100 rounded-[3rem] flex flex-col items-center justify-center text-slate-300">
              <Workflow size={60} className="mb-4 opacity-10" />
              <p className="text-[10px] font-black uppercase tracking-widest">Aguardando seus fluxos...</p>
            </div>
          )}
          {automations.map(auto => (
            <div key={auto.id} className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-sm hover:shadow-2xl transition-all group relative">
               <div className="flex items-start justify-between mb-8">
                 <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg ${auto.is_active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                   <GitBranch size={24} />
                 </div>
                 <div className="flex items-center gap-1">
                   <button onClick={() => handleEdit(auto)} className="p-2 hover:bg-slate-50 rounded-xl text-slate-400 hover:text-indigo-600 transition-all"><Settings size={18}/></button>
                   <button onClick={() => handleDelete(auto.id)} className="p-2 hover:bg-slate-50 rounded-xl text-slate-400 hover:text-rose-600 transition-all"><Trash2 size={18}/></button>
                 </div>
               </div>
               <h4 className="text-lg font-black text-slate-900 mb-2 truncate">{auto.name}</h4>
               <p className="text-xs text-slate-500 font-medium mb-6 line-clamp-2">{auto.description}</p>
               <div className="flex gap-2 mb-8">
                 <span className="text-[9px] font-black bg-slate-50 text-indigo-600 px-3 py-1 rounded-full uppercase border border-slate-100">{auto.trigger_type}</span>
               </div>
               <div className="flex items-center justify-between pt-6 border-t border-slate-50">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${auto.is_active ? 'bg-emerald-500' : 'bg-slate-300'}`}></div>
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{auto.is_active ? 'Ativo' : 'Pausado'}</span>
                  </div>
                  <button onClick={() => handleToggle(auto)} className="text-[9px] font-black text-slate-500 uppercase hover:text-slate-900 transition-all">Alternar</button>
               </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white border border-slate-100 rounded-[3rem] overflow-hidden shadow-sm">
           <table className="w-full text-left">
             <thead className="bg-slate-50 border-b border-slate-100">
               <tr className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                 <th className="px-8 py-6">Status</th>
                 <th className="px-8 py-6">Timestamp</th>
                 <th className="px-8 py-6">Latência</th>
                 <th className="px-8 py-6 text-right">Ação</th>
               </tr>
             </thead>
             <tbody className="divide-y divide-slate-100">
               {runs.map(run => (
                 <tr key={run.id} className="hover:bg-slate-50/50 transition-all">
                   <td className="px-8 py-6">
                     <span className={`text-[10px] font-black uppercase tracking-widest ${run.status === 'success' ? 'text-emerald-500' : 'text-rose-500'}`}>{run.status}</span>
                   </td>
                   <td className="px-8 py-6 font-mono text-[10px] text-slate-500">{new Date(run.created_at).toLocaleString()}</td>
                   <td className="px-8 py-6 font-mono text-[10px] text-slate-500">{run.execution_time_ms}ms</td>
                   <td className="px-8 py-6 text-right"><button className="text-[10px] font-black text-indigo-600 uppercase">Log</button></td>
                 </tr>
               ))}
             </tbody>
           </table>
        </div>
      )}
    </div>
  );
};

const ToolboxItem: React.FC<{ icon: any, label: string, onClick: () => void, color: string }> = ({ icon, label, onClick, color }) => (
  <button onClick={onClick} className="flex flex-col items-center gap-2 group transition-all hover:-translate-y-1">
    <div className={`w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-400 group-hover:${color} group-hover:text-white transition-all shadow-inner border border-transparent group-hover:bg-opacity-100 group-hover:border-transparent group-hover:shadow-lg`}>
      {icon}
    </div>
    <span className="text-[8px] font-black uppercase text-slate-400 group-hover:text-slate-900 tracking-widest transition-colors">{label}</span>
  </button>
);

export default AutomationManager;
