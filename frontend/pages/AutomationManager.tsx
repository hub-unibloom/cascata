
import React, { useState, useEffect, useRef } from 'react';
import { 
  Zap, Plus, Trash2, Activity, Play, 
  CheckCircle2, AlertCircle, Loader2, 
  Settings, X, Filter, GitBranch, Terminal,
  History, ToggleLeft as Toggle, Layout, Workflow,
  ChevronRight, Save, Database, Globe, MousePointer2,
  ArrowRight, Maximize2, Minimize2, Code, ChevronDown,
  Link as LinkIcon, Unlink, Key, Shield, RefreshCcw,
  Layers, Copy, ArrowDownRight, Check, Search
} from 'lucide-react';

interface Node {
  id: string;
  type: 'trigger' | 'query' | 'http' | 'logic' | 'response' | 'transform' | 'data' | 'rpc' | 'convert';
  x: number;
  y: number;
  label: string;
  config: any;
  next?: string[] | { true?: string, false?: string, out?: string, error?: string };
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

const SYSTEM_RPC_PREFIXES = ['uuid_', 'pg_', 'armor', 'crypt', 'digest', 'hmac', 'gen_', 'encrypt', 'decrypt', 'pissh_', 'notify_', 'dearmor', 'fips_mode'];

const AutomationManager: React.FC<{ projectId: string }> = ({ projectId }: { projectId: string }) => {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [tables, setTables] = useState<any[]>([]);
  const [columns, setColumns] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'composer'>('list');
  const [activeTab, setActiveTab] = useState<'editor' | 'runs'>('editor');
  const [runs, setRuns] = useState<ExecutionRun[]>([]);
  const [stats, setStats] = useState<Record<string, AutomationStats>>({});
  const [runsFilter, setRunsFilter] = useState<string | null>(null);
  const [vaultSecrets, setVaultSecrets] = useState<any[]>([]);
  // webhookReceivers removed as it's now integrated directly into trigger nodes
  const [showVariablePicker, setShowVariablePicker] = useState<{ 
    nodeId: string, 
    field: string, 
    type: 'config' | 'headers' | 'body' | 'url' | 'any' | 'rpc_arg' | 'custom_field' 
  } | null>(null);
  const [functions, setFunctions] = useState<{name: string}[]>([]);
  const [functionArgs, setFunctionArgs] = useState<Record<string, {name: string, type: string, mode: string}[]>>({});
  
  // COMPOSER STATE
  const [editingAutomation, setEditingAutomation] = useState<Partial<Automation> | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [draggedNode, setDraggedNode] = useState<string | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [connectingFrom, setConnectingFrom] = useState<{ id: string, port: 'out' | 'true' | 'false' } | null>(null);
  const [configNodeId, setConfigNodeId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const [testingNodeId, setTestingNodeId] = useState<string | null>(null);
  const [rpcSearch, setRpcSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleNodeTest = async (node: Node) => {
    setTestingNodeId(node.id);
    try {
      const res = await fetch(`/api/data/${projectId}/automations/test-node`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          node,
          triggerPayload: editingAutomation?.trigger_config?.sample_payload || {}
        })
      });
      const data = await res.json();
      if (data.success) {
        setNodes(nodes.map(n => n.id === node.id ? {
          ...n, 
          config: {
            ...n.config, 
            _sampleData: data.output,
            _sampleKeys: data.keys
          }
        } : n));
        setSuccess('Nó executado com sucesso!');
        setTimeout(() => setSuccess(null), 2000);
      } else {
        setError(data.error || 'Erro ao testar nó');
      }
    } catch (e) {
      setError('Erro de conexão ao testar nó');
    } finally {
      setTestingNodeId(null);
    }
  };

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

  const fetchFunctions = async () => {
    try {
      const res = await fetch(`/api/data/${projectId}/functions`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      setFunctions(Array.isArray(data) ? data : []);
    } catch (e) { console.error("Functions fetch error"); }
  };

  const fetchFunctionDef = async (fnName: string) => {
    if (functionArgs[fnName]) return;
    try {
      const res = await fetch(`/api/data/${projectId}/rpc/${fnName}/definition`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      if (data?.args && Array.isArray(data.args)) {
        setFunctionArgs((prev: Record<string, {name: string, type: string, mode: string}[]>) => ({ ...prev, [fnName]: data.args }));
      }
    } catch (e) { console.error("Function def fetch error"); }
  };



  useEffect(() => { 
      Promise.all([fetchAutomations(), fetchRuns(), fetchStats(), fetchTables(), fetchVault(), fetchFunctions()]).then(() => setLoading(false)); 
  }, [projectId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setConfigNodeId(null);
        setShowVariablePicker(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
      const res = await fetch(`/api/data/${projectId}/automations/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Falha ao excluir'); }
      setAutomations((prev: Automation[]) => prev.filter((a: Automation) => a.id !== id));
      setSuccess('Workflow excluído.');
      setTimeout(() => setSuccess(null), 3000);
    } catch (e: any) { setError(e.message || 'Erro ao excluir.'); setTimeout(() => setError(null), 5000); }
  };

  const handleToggle = async (auto: Automation) => {
    try {
      const newStatus = !auto.is_active;
      const res = await fetch(`/api/data/${projectId}/automations`, {
        method: 'POST',
        body: JSON.stringify({ ...auto, is_active: newStatus }),
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Falha ao alterar status'); }
      setAutomations((prev: Automation[]) => prev.map((a: Automation) => a.id === auto.id ? { ...a, is_active: newStatus } : a));
      setSuccess(newStatus ? 'Workflow ativado.' : 'Workflow pausado.');
      setTimeout(() => setSuccess(null), 3000);
    } catch (e: any) { setError(e.message || 'Erro ao alterar status.'); setTimeout(() => setError(null), 5000); }
  };

  // --- VARIABLE PICKER COMPONENT ---
  const VariablePicker = ({ onSelect, onClose }: { onSelect: (path: string) => void, onClose: () => void }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const availableNodes = nodes.filter(n => {
      // Find position of activeNode and show only previous nodes
      const index = nodes.indexOf(activeNode as Node);
      const isPrevious = nodes.indexOf(n) < index || n.type === 'trigger';
      if (!isPrevious) return false;
      
      if (!searchTerm) return true;
      const term = searchTerm.toLowerCase();
      return n.id.toLowerCase().includes(term) || n.type.toLowerCase().includes(term);
    });

    return (
      <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/60 backdrop-blur-md p-4 animate-in fade-in duration-300">
        <div className="bg-white/90 glass w-full max-w-lg rounded-[3rem] shadow-2xl border border-white/50 overflow-hidden animate-in zoom-in-95 duration-500 premium-card">
          <div className="p-8 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
            <div>
              <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3"><Zap size={20} className="text-indigo-600 animate-pulse"/> Variable Picker</h3>
              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Select data from previous nodes</p>
            </div>
            <button onClick={onClose} className="p-3 hover:bg-slate-200 rounded-2xl transition-all active:scale-90"><X size={20}/></button>
          </div>
          <div className="px-8 py-4 bg-white border-b border-slate-50">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input 
                autoFocus
                className="w-full bg-slate-100 border-none rounded-2xl pl-12 pr-4 py-3 text-sm font-bold placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all"
                placeholder="Search variables, nodes..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
          <div className="p-4 max-h-[60vh] overflow-y-auto space-y-4">
            {availableNodes.length > 0 ? availableNodes.map((n, idx) => (
              <div key={n.id} className="space-y-2">
                <div className="flex items-center gap-3 px-4 py-2 bg-slate-100 rounded-xl">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-tight">Node {idx + 1}</span>
                    <span className="text-xs font-bold text-slate-900">{n.type.toUpperCase()}: {n.id}</span>
                </div>
                <div className="grid grid-cols-1 gap-1 px-2">
                    <button 
                        onClick={() => onSelect(`{{${n.id}.data}}`)}
                        className="flex items-center justify-between px-4 py-3 hover:bg-indigo-50 rounded-xl transition-all group text-left"
                    >
                        <span className="text-xs font-medium text-slate-600 group-hover:text-indigo-700">Full Data Object</span>
                        <code className="text-[10px] bg-slate-200 px-2 py-0.5 rounded text-slate-500 group-hover:bg-indigo-100 group-hover:text-indigo-600">data</code>
                    </button>
                    {(n.type === 'data' || n.type === 'trigger') && columns[n.config.table || editingAutomation?.trigger_config?.table]?.filter(col => !searchTerm || col.toLowerCase().includes(searchTerm.toLowerCase())).map(col => (
                        <button 
                            key={col}
                            onClick={() => onSelect(`{{${n.id}.data.${col}}}`)}
                            className="flex items-center justify-between px-4 py-3 hover:bg-indigo-50 rounded-xl transition-all group text-left"
                        >
                            <span className="text-xs font-medium text-slate-600 group-hover:text-indigo-700">{col}</span>
                            <code className="text-[10px] bg-slate-200 px-2 py-0.5 rounded text-slate-500">data.{col}</code>
                        </button>
                    ))}
                </div>
              </div>
            )) : (
              <div className="p-12 text-center space-y-3">
                <div className="w-16 h-16 bg-slate-50 rounded-[2rem] flex items-center justify-center mx-auto">
                  <Search size={24} className="text-slate-200" />
                </div>
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Nenhuma variável encontrada</p>
              </div>
            )}
          </div>
          <div className="p-6 bg-slate-50 border-t border-slate-100">
             <p className="text-[9px] text-slate-400 font-medium text-center uppercase tracking-widest">Tip: Click variables to inject at cursor position</p>
          </div>
        </div>
      </div>
    );
  };

  const PickerButton = ({ onClick }: { onClick: () => void }) => (
    <button 
        onClick={onClick}
        className="p-2 text-indigo-500 hover:bg-indigo-50 rounded-lg transition-all active:scale-95"
        title="Pick Variable"
    >
        <Zap size={14} fill="currentColor" />
    </button>
  );

  const handleVariableSelect = (path: string) => {
    if (!showVariablePicker) return;
    const { nodeId, field, type } = showVariablePicker;
    
    setNodes((prevNodes: Node[]) => prevNodes.map((n: Node) => {
      if (n.id !== nodeId) return n;
      const nextConfig = { ...n.config };
      const append = (val: string, newPath: string) => {
        if (!val) return newPath;
        if (val.includes(newPath)) return val; // Avoid duplicates
        return val + " " + newPath; // SYNERGY: Multiple triggers per field
      };

      if (type === 'headers') {
        nextConfig.headers = { ...(nextConfig.headers || {}), [field]: append(nextConfig.headers?.[field], path) };
      } else if (type === 'body') {
        nextConfig.body = { ...(nextConfig.body || {}), [field]: append(nextConfig.body?.[field], path) };
      } else if (type === 'url') {
        nextConfig.url = append(nextConfig.url, path);
      } else if (type === 'rpc_arg') {
        nextConfig.args = { ...(nextConfig.args || {}), [field]: append(nextConfig.args?.[field], path) };
      } else if (field.includes('.')) {
        const parts = field.split('.');
        const parent = parts[0];
        const idxStr = parts[1];
        
        if (parent === '_payload') {
          const idx = parseInt(idxStr);
          const np = [...(nextConfig._payload || [])];
          if (np[idx]) {
            np[idx] = { ...np[idx], value: append(np[idx].value, path) };
            nextConfig._payload = np;
            nextConfig.body = Object.fromEntries(np.filter((x: any) => x.column).map((x: any) => [x.column, x.value]));
          }
        } else if (parent === 'filters') {
          const idx = parseInt(idxStr);
          const nextFilters = [...(nextConfig.filters || [])];
          if (nextFilters[idx]) {
            nextFilters[idx] = { ...nextFilters[idx], value: append(nextFilters[idx].value, path) };
            nextConfig.filters = nextFilters;
          }
        } else if (parent === '_customFields') {
          const idx = parseInt(idxStr);
          const ncf = [...(nextConfig._customFields || [])];
          if (ncf[idx]) {
             ncf[idx] = { ...ncf[idx], value: append(ncf[idx].value, path) };
             nextConfig._customFields = ncf;
             nextConfig.body = {
               ...(nextConfig._fields || {}),
               ...Object.fromEntries(ncf.filter((x: any) => x.key).map((x: any) => [x.key, x.value]))
             };
          }
        } else if (parent === '_rpcArgs') {
           nextConfig.args = { ...(nextConfig.args || {}), [idxStr]: append(nextConfig.args?.[idxStr], path) };
        }
      } else if (type === 'config') {
        nextConfig[field] = append(nextConfig[field], path);
      } else if (type === 'custom_field') {
        const idx = parseInt(field);
        const ncf = [...(nextConfig._customFields || [])];
        if (ncf[idx]) {
           ncf[idx].value = append(ncf[idx].value, path);
           nextConfig._customFields = ncf;
        }
      }
      
      return { ...n, config: nextConfig };
    }));
    setShowVariablePicker(null);
  };

  const handleSave = async () => {
    if (!editingAutomation || !editingAutomation.name) { setError("Nome é obrigatório."); setTimeout(() => setError(null), 5000); return; }
    setSubmitting(true);
    try {
      const payload = {
        ...(editingAutomation || {}),
        nodes: JSON.stringify(nodes),
        trigger_config: JSON.stringify(editingAutomation.trigger_config || {})
      };
      const res = await fetch(`/api/data/${projectId}/automations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
        body: JSON.stringify({
           ...payload,
           id: editingAutomation.id // CRITICAL FIX: Ensure ID is passed for UPDATES to avoid 409 Conflict
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Falha ao salvar workflow');
      setView('list');
      fetchAutomations();
      fetchStats();
      setSuccess("Workflow salvo com sucesso.");
    } catch (e: any) { setError(e.message || "Erro ao salvar."); }
    finally { setSubmitting(false); setTimeout(() => { setSuccess(null); setError(null); }, 5000); }
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
              type === 'convert' ? { value: '', toType: 'string' } :
              type === 'response' ? { status_code: 200, body: { success: true } } : {},
      next: (type === 'logic') ? { true: undefined, false: undefined } : (type === 'http') ? { out: undefined, error: undefined } : []
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

  const handlePortClick = (nodeId: string, port: 'out' | 'true' | 'false' | 'error') => {
     if (connectingFrom) {
        // Cannot connect to itself or to a trigger node
        const targetNode = nodes.find(n => n.id === nodeId);
        if (connectingFrom.id === nodeId || targetNode?.type === 'trigger') { 
           setConnectingFrom(null); 
           return; 
        }
       
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
        if (n.type === 'logic' || n.type === 'http') {
           const nextObj = { ...(n.next as any) };
           if (port === 'true') nextObj.true = undefined;
           if (port === 'false') nextObj.false = undefined;
           if (port === 'out') nextObj.out = undefined;
           if (port === 'error') nextObj.error = undefined;
           return { ...n, next: nextObj };
        } else {
           const nextArr = Array.isArray(n.next) ? n.next : [];
           return { ...n, next: nextArr.filter(id => id !== toId) };
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
               } else if (node.type === 'http') {
                  const nextObj = node.next as any;
                  if (nextObj?.out) connections.push({ toId: nextObj.out, port: 'out' });
                  if (nextObj?.error) connections.push({ toId: nextObj.error, port: 'error' });
               } else if (Array.isArray(node.next)) {
                  node.next.forEach(toId => connections.push({ toId, port: 'out' }));
               }

               return connections.map(conn => {
                 const target = nodes.find(n => n.id === conn.toId);
                 if (!target) return null;

                 const startX = node.x + (18 * 16); // Node width (w-[18rem])
                 const startY = node.y + (
                   (conn.port === 'true' || (conn.port === 'out' && node.type === 'http')) ? 70 : 
                   (conn.port === 'false' || conn.port === 'error') ? 110 : 100
                 );
                 const endX = target.x;
                 const endY = target.y + 50; 

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
                      <foreignObject x={(startX+endX)/2 - 12} y={(startY+endY)/2 - 12} width="24" height="24" className="pointer-events-auto z-50">
                        <button onClick={(e) => { e.stopPropagation(); disconnect(node.id, conn.toId, conn.port); }} className="w-6 h-6 bg-white border border-slate-200 rounded-full flex items-center justify-center text-slate-300 hover:text-rose-600 hover:border-rose-100 shadow-sm transition-all"><Unlink size={10}/></button>
                      </foreignObject>
                   </g>
                 );
               });
             })}
          </svg>

          {/* NODES */}
          <div className="absolute inset-0 z-10 p-12 overflow-visible pointer-events-none">
            {nodes.map(node => (
              <div 
                key={node.id} 
                className={`absolute bg-white border ${draggedNode === node.id ? 'border-indigo-500 shadow-2xl scale-[1.02]' : 'border-slate-100 shadow-xl'} rounded-[2rem] p-6 w-[18rem] group cursor-grab active:cursor-grabbing transition-all hover:border-indigo-200 z-20 pointer-events-auto`}
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
                         node.type === 'rpc' ? <Code size={18}/> : 
                         node.type === 'convert' ? <RefreshCcw size={18}/> : <Layers size={18}/>}
                      </div>
                      <div>
                        <span className="text-[7px] font-black uppercase tracking-widest text-slate-400 block mb-0.5">#{node.id.split('_').pop()}</span>
                        <span className="text-[10px] font-black text-slate-900 uppercase tracking-tighter">{node.label}</span>
                      </div>
                   </div>
                   <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => setConfigNodeId(node.id)} className="p-1.5 hover:bg-slate-50 rounded-lg text-slate-300 hover:text-indigo-600 transition-all"><Settings size={14}/></button>
                      {node.type !== 'trigger' && (
                        <button onClick={() => setNodes(nodes.filter(n => n.id !== node.id))} className="p-1.5 hover:bg-slate-50 rounded-lg text-slate-300 hover:text-rose-600 transition-all"><Trash2 size={14}/></button>
                      )}
                   </div>
                </div>

                <p className="text-[9px] text-slate-500 font-medium truncate mb-2 opacity-60">
                   {node.type === 'trigger' ? `${editingAutomation?.trigger_config?.table || '*'} • ${editingAutomation?.trigger_config?.event || '*'}` : 
                    node.type === 'logic' ? 'Processamento Condicional' : 'Configuração Enterprise'}
                </p>

                {/* PORTS */}
                {node.type !== 'trigger' && (
                  <div className="port absolute -left-2.5 top-1/2 -translate-y-1/2 w-5 h-5 bg-white border-2 border-slate-100 rounded-full flex items-center justify-center cursor-pointer hover:border-indigo-400 z-30 transition-all shadow-md group/port" onClick={() => handlePortClick(node.id, 'out')}>
                     <div className="w-1.5 h-1.5 rounded-full bg-slate-200 group-hover/port:bg-indigo-400"></div>
                  </div>
                )}

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
                ) : node.type === 'http' ? (
                   <>
                     <div className="port absolute -right-2.5 top-[70px] w-5 h-5 bg-white border-2 border-slate-100 rounded-full flex items-center justify-center cursor-pointer hover:border-indigo-400 z-30 transition-all shadow-md group/port" onClick={() => handlePortClick(node.id, 'out')}>
                        <div className={`w-1.5 h-1.5 rounded-full ${connectingFrom?.id === node.id && connectingFrom?.port === 'out' ? 'bg-indigo-600 animate-pulse' : 'bg-slate-200 group-hover/port:bg-indigo-400'}`}></div>
                        <span className="absolute left-6 text-[7px] font-black text-slate-400 uppercase tracking-widest opacity-0 group-hover/port:opacity-100 transition-opacity">Out</span>
                     </div>
                     <div className="port absolute -right-2.5 top-[110px] w-5 h-5 bg-white border-2 border-rose-100 rounded-full flex items-center justify-center cursor-pointer hover:border-rose-500 z-30 transition-all shadow-md group/port" onClick={() => handlePortClick(node.id, 'error')}>
                        <div className={`w-1.5 h-1.5 rounded-full ${connectingFrom?.id === node.id && connectingFrom?.port === 'error' ? 'bg-rose-600 animate-pulse' : 'bg-rose-200 group-hover/port:bg-rose-500'}`}></div>
                        <span className="absolute left-6 text-[7px] font-black text-rose-500 uppercase tracking-widest opacity-0 group-hover/port:opacity-100 transition-opacity">Error</span>
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
             <ToolboxItem icon={<Code size={20}/>} label="RPC" onClick={() => addNode('rpc')} color="bg-violet-600" />
             <ToolboxItem icon={<RefreshCcw size={20}/>} label="Convert" onClick={() => addNode('convert')} color="bg-pink-600" />
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
                      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
                         {/* SYNERGY: Trigger Type Selector (Enterprise Agnostic) */}
                         <div className="space-y-4">
                            <label className="text-xs font-black text-indigo-600 uppercase tracking-widest">Origem do Gatilho</label>
                            <div className="grid grid-cols-2 gap-4">
                               <button 
                                  onClick={() => setEditingAutomation(editingAutomation ? { ...editingAutomation, trigger_type: 'API_INTERCEPT' } : null)}
                                  className={`py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${editingAutomation?.trigger_type !== 'WEBHOOK_IN' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100' : 'bg-slate-50 text-slate-400 hover:bg-slate-100'}`}
                               >
                                  <Database size={14}/> Evento de Banco
                               </button>
                               <button 
                                  onClick={() => setEditingAutomation(editingAutomation ? { ...editingAutomation, trigger_type: 'WEBHOOK_IN' } : null)}
                                  className={`py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${editingAutomation?.trigger_type === 'WEBHOOK_IN' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100' : 'bg-slate-50 text-slate-400 hover:bg-slate-100'}`}
                                >
                                  <Globe size={14}/> Webhook Externo
                               </button>
                            </div>
                         </div>

                         {editingAutomation?.trigger_type === 'WEBHOOK_IN' ? (
                            <div className="space-y-6">
                               <div className="space-y-4">
                                  <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Configuração do Endpoint</label>
                                  <div className="flex gap-4">
                                     <div className="flex-1 space-y-2">
                                        <p className="text-[10px] text-slate-400 font-bold uppercase">URL Slug / Path</p>
                                        <input 
                                          className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 text-sm font-bold outline-none focus:ring-4 focus:ring-indigo-500/10" 
                                          placeholder="ex: order-paid"
                                          value={editingAutomation?.trigger_config?.path_slug || ''}
                                          onChange={(e) => {
                                             const val = e.target.value
                                               .toLowerCase()
                                               .normalize('NFD')
                                               .replace(/[\u0300-\u036f]/g, '') // Remove accents
                                               .replace(/[^a-z0-9-_]/g, '-')    // Replace special chars with dash
                                               .replace(/-+/g, '-')             // Remove double dashes
                                               .replace(/^-|-$/g, '');          // Remove leading/trailing dashes
                                             setEditingAutomation({...editingAutomation, trigger_config: {...(editingAutomation.trigger_config || {}), path_slug: val}});
                                          }}
                                        />
                                     </div>
                                  </div>
                               </div>

                               <div className="space-y-4">
                                  <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Segurança (HMAC SHA256)</label>
                                  <div className="space-y-4">
                                     <select 
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 text-sm font-bold"
                                        value={editingAutomation?.trigger_config?.auth_method || 'none'}
                                        onChange={(e) => setEditingAutomation({...editingAutomation, trigger_config: {...(editingAutomation.trigger_config || {}), auth_method: e.target.value}})}
                                     >
                                        <option value="none">Nenhuma (Público)</option>
                                        <option value="hmac_sha256">Assinatura HMAC SHA256</option>
                                     </select>
                                     
                                     {editingAutomation?.trigger_config?.auth_method === 'hmac_sha256' && (
                                        <div className="space-y-2">
                                           <p className="text-[10px] text-slate-400 font-bold uppercase">Chave Secreta</p>
                                           <input 
                                             type="password"
                                             className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 text-sm font-bold outline-none focus:ring-4 focus:ring-indigo-500/10" 
                                             placeholder="Sua-Chave-Ultra-Secreta"
                                             value={editingAutomation?.trigger_config?.secret_key || ''}
                                             onChange={(e) => setEditingAutomation({...editingAutomation, trigger_config: {...(editingAutomation.trigger_config || {}), secret_key: e.target.value}})}
                                           />
                                        </div>
                                     )}
                                  </div>
                               </div>

                               <div className="bg-indigo-50/50 border border-indigo-100/50 rounded-[2.5rem] p-8 space-y-4">
                                  <div className="flex items-center gap-3">
                                     <Globe size={18} className="text-indigo-600"/>
                                     <h4 className="text-[10px] font-black text-slate-900 uppercase tracking-widest">Seu Endpoint é:</h4>
                                  </div>
                                  <code className="block bg-white p-6 rounded-2xl text-[10px] font-bold text-indigo-700 break-all border border-indigo-100 shadow-sm">
                                     {window.location.protocol}//{window.location.host}/api/webhooks/in/{projectId}/{editingAutomation?.trigger_config?.path_slug || ':slug'}
                                  </code>
                                  <p className="text-[9px] text-slate-400 font-bold uppercase tracking-tight text-center">
                                     Envie POST JSON para esta URL. O payload estará disponível em <span className="text-indigo-600">{"{{trigger.data}}"}</span>
                                  </p>
                               </div>
                            </div>
                         ) : (
                            <>
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
                            </>
                         )}

                         {/* SYNERGY: Trigger Conditions (Conditional Trigger) */}
                         <div className="pt-8 border-t border-slate-50 space-y-8">
                            <div className="flex items-center justify-between">
                               <div>
                                  <label className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-2">
                                     <Filter size={14} className="text-indigo-600"/> Gatilho Condicional (Opcional)
                                  </label>
                                  <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest mt-1">A automação só executa se estas condições forem atendidas</p>
                               </div>
                               <div className="flex bg-slate-50 p-1 rounded-xl">
                                  <button onClick={() => setNodes(nodes.map(n => n.id === activeNode.id ? {...n, config: {...n.config, match: 'all'}} : n))} className={`px-4 py-2 rounded-lg text-[9px] font-black uppercase transition-all ${activeNode.config.match === 'all' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}>AND</button>
                                  <button onClick={() => setNodes(nodes.map(n => n.id === activeNode.id ? {...n, config: {...n.config, match: 'any'}} : n))} className={`px-4 py-2 rounded-lg text-[9px] font-black uppercase transition-all ${activeNode.config.match === 'any' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}>OR</button>
                               </div>
                            </div>

                            <div className="space-y-4">
                               {activeNode.config.conditions?.map((c: any, i: number) => (
                                  <div key={i} className="bg-slate-50 rounded-[2rem] p-6 flex items-center gap-4 group animate-in slide-in-from-left-2 transition-all">
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
                                        <option value="eq">Igual a</option>
                                        <option value="neq">Diferente de</option>
                                        <option value="gt">Maior que</option>
                                        <option value="lt">Menor que</option>
                                        <option value="contains">Contém</option>
                                        <option value="starts_with">Começa com</option>
                                        <option value="ends_with">Termina com</option>
                                        <option value="regex">Regex Match</option>
                                        <option value="is_empty">Está Vazio</option>
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
                                     <button className="text-slate-200 hover:text-rose-500 transition-colors" onClick={() => {
                                        const nc = activeNode.config.conditions.filter((_: any, idx: number) => idx !== i);
                                        setNodes(nodes.map(n => n.id === activeNode.id ? {...n, config: {...n.config, conditions: nc}} : n));
                                     }}><Trash2 size={16}/></button>
                                  </div>
                               ))}
                               <button 
                                 onClick={() => {
                                   const nc = [...(activeNode.config.conditions || []), { left: '', op: 'eq', right: '' }];
                                   setNodes(nodes.map(n => n.id === activeNode.id ? {...n, config: {...n.config, conditions: nc}} : n));
                                 }}
                                 className="w-full py-4 border-2 border-dashed border-slate-100 rounded-[2rem] text-slate-300 hover:text-indigo-600 hover:border-indigo-100 transition-all font-black text-[10px] uppercase tracking-widest flex items-center justify-center gap-2"
                               >
                                 <Plus size={14}/> Adicionar Condição do Gatilho
                               </button>
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
                                     <option value="eq">Igual a</option>
                                     <option value="neq">Diferente de</option>
                                     <option value="gt">Maior que</option>
                                     <option value="lt">Menor que</option>
                                     <option value="contains">Contém</option>
                                     <option value="starts_with">Começa com</option>
                                     <option value="ends_with">Termina com</option>
                                     <option value="regex">Regex Match</option>
                                     <option value="is_empty">Está vazio</option>
                                     <option value="ends_with">Termina com</option>
                                     <option value="regex">Regex Match</option>
                                     <option value="is_empty">Está Vazio</option>
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
                             <div className="flex items-center justify-between">
                                <label className="text-xs font-black text-slate-900 uppercase tracking-widest">URL do Endpoint</label>
                                <PickerButton onClick={() => setShowVariablePicker({ nodeId: activeNode.id, field: 'url', type: 'url' })} />
                             </div>
                             <input 
                                className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-xs font-bold text-indigo-600" 
                                placeholder="https://api.exemplo.com/v1/resource"
                                value={activeNode.config.url || ''} 
                                onChange={(e) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, url: e.target.value}} : n))}
                             />
                          </div>

                          <div className="grid grid-cols-2 gap-6">
                             <div className="space-y-4">
                                <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Método</label>
                                <select className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold" value={activeNode.config.method || 'POST'} onChange={(e) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, method: e.target.value}} : n))}>
                                   <option value="GET">GET</option>
                                   <option value="POST">POST</option>
                                   <option value="PUT">PUT</option>
                                   <option value="PATCH">PATCH</option>
                                   <option value="DELETE">DELETE</option>
                                </select>
                             </div>
                             <div className="space-y-4">
                                <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Autenticação</label>
                                <select className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold" value={activeNode.config.auth || 'none'} onChange={(e) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, auth: e.target.value}} : n))}>
                                   <option value="none">Sem Autenticação</option>
                                   <option value="bearer">Bearer Token</option>
                                   <option value="apikey">Basic Auth (User/Pass)</option>
                                </select>
                             </div>
                          </div>

                          {activeNode.config.auth !== 'none' && (
                             <div className="bg-indigo-50/50 p-6 rounded-[2rem] border border-indigo-100 space-y-4">
                                {activeNode.config.auth === 'bearer' && (
                                   <div className="space-y-3">
                                      <div className="flex items-center justify-between">
                                          <label className="text-[10px] font-black text-indigo-900 uppercase tracking-widest">Token / Secret</label>
                                          <div className="flex gap-2">
                                            <PickerButton onClick={() => setShowVariablePicker({ nodeId: activeNode.id, field: 'auth_token', type: 'config' })} />
                                            <select 
                                                className="bg-white border border-indigo-200 rounded-lg px-2 py-1 text-[9px] font-black uppercase text-indigo-600"
                                                onChange={(e) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, auth_token: `vault://${e.target.value}`}} : n))}
                                            >
                                                <option value="">Vault Secrets</option>
                                                {vaultSecrets.map((s: any) => <option key={s.id} value={s.name}>{s.name}</option>)}
                                            </select>
                                          </div>
                                      </div>
                                      <input className="w-full bg-white border border-indigo-100 rounded-xl px-4 py-3 text-xs font-mono" placeholder="Token ou {{var}}" value={activeNode.config.auth_token || ''} onChange={(e) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, auth_token: e.target.value}} : n))} />
                                   </div>
                                )}
                                {activeNode.config.auth === 'apikey' && (
                                   <div className="grid grid-cols-1 gap-4">
                                      <div className="space-y-2">
                                         <label className="text-[10px] font-black text-indigo-900 uppercase tracking-widest">Username</label>
                                         <input className="w-full bg-white border border-indigo-100 rounded-xl px-4 py-3 text-xs" value={activeNode.config.auth_user || ''} onChange={(e) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, auth_user: e.target.value}} : n))} />
                                      </div>
                                      <div className="space-y-2">
                                         <label className="text-[10px] font-black text-indigo-900 uppercase tracking-widest">Password / Secret</label>
                                         <div className="flex gap-2">
                                            <input className="flex-1 bg-white border border-indigo-100 rounded-xl px-4 py-3 text-xs" type="password" value={activeNode.config.auth_pass || ''} onChange={(e) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, auth_pass: e.target.value}} : n))} />
                                            <select 
                                                className="bg-white border border-indigo-200 rounded-lg px-2 py-1 text-[9px] font-black uppercase text-indigo-600"
                                                onChange={(e) => setNodes(nodes.map((n: any) => n.id === activeNode.id ? {...n, config: {...n.config, auth_pass: `vault://${e.target.value}`}} : n))}
                                            >
                                                <option value="">Vault</option>
                                                {vaultSecrets.map((s: any) => <option key={s.id} value={s.name}>{s.name}</option>)}
                                            </select>
                                         </div>
                                      </div>
                                   </div>
                                )}
                             </div>
                          )}

                          <div className="space-y-6">
                             <div className="flex items-center justify-between">
                                <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Headers</label>
                                <button className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:underline" onClick={() => {
                                   const next = {...(activeNode.config.headers || {})};
                                   next[`new_header_${Object.keys(next).length}`] = '';
                                   setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, headers: next}} : n));
                                }}>+ Adicionar Header</button>
                             </div>
                             
                             <div className="space-y-2">
                                {Object.entries(activeNode.config.headers || {}).map(([hk, hv]: [string, any], i) => (
                                   <div key={i} className="flex gap-2 items-center bg-slate-50 p-3 rounded-2xl border border-slate-100 group">
                                      <input className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-2 text-[10px] font-bold" placeholder="Key" value={hk} onChange={(e) => {
                                         const next = {...activeNode.config.headers}; delete next[hk]; next[e.target.value] = hv;
                                         setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, headers: next}} : n));
                                      }} />
                                      <div className="flex-1 flex gap-2 items-center">
                                         <input className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-2 text-[10px] font-medium" placeholder="Value" value={hv} onChange={(e) => {
                                            const next = {...activeNode.config.headers}; next[hk] = e.target.value;
                                            setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, headers: next}} : n));
                                         }} />
                                         <PickerButton onClick={() => setShowVariablePicker({ nodeId: activeNode.id, field: hk, type: 'headers' })} />
                                      </div>
                                      <button className="opacity-0 group-hover:opacity-100 p-2 text-rose-500 hover:bg-rose-50 rounded-lg transition-all" onClick={() => {
                                         const next = {...activeNode.config.headers}; delete next[hk];
                                         setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, headers: next}} : n));
                                      }}><Trash2 size={14} /></button>
                                   </div>
                                ))}
                             </div>
                          </div>

                          <div className="space-y-6">
                             <div className="flex items-center justify-between">
                                <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Payload (JSON Body)</label>
                                <button className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:underline" onClick={() => {
                                   const next = {...(activeNode.config.body || {})};
                                   next[`field_${Object.keys(next).length}`] = '';
                                   setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, body: next}} : n));
                                }}>+ Adicionar Campo</button>
                             </div>
                             
                             <div className="space-y-2">
                                {Object.entries(activeNode.config.body || {}).map(([bk, bv]: [string, any], i) => (
                                   <div key={i} className="flex gap-2 items-center bg-slate-50 p-3 rounded-2xl border border-slate-100 group">
                                      <input className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-2 text-[10px] font-bold" placeholder="Chave" value={bk} onChange={(e) => {
                                         const next = {...activeNode.config.body}; delete next[bk]; next[e.target.value] = bv;
                                         setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, body: next}} : n));
                                      }} />
                                      <div className="flex-1 flex gap-2 items-center">
                                         <input className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-2 text-[10px] font-medium" placeholder="Valor" value={bv} onChange={(e) => {
                                            const next = {...activeNode.config.body}; next[bk] = e.target.value;
                                            setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, body: next}} : n));
                                         }} />
                                         <PickerButton onClick={() => setShowVariablePicker({ nodeId: activeNode.id, field: bk, type: 'body' })} />
                                      </div>
                                      <button className="opacity-0 group-hover:opacity-100 p-2 text-rose-500 hover:bg-rose-50 rounded-lg transition-all" onClick={() => {
                                         const next = {...activeNode.config.body}; delete next[bk];
                                         setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, body: next}} : n));
                                      }}><Trash2 size={14} /></button>
                                   </div>
                                ))}
                             </div>
                           </div>

                           <div className="space-y-4 pt-6 border-t border-slate-100">
                              <label className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-2"><Settings size={12} className="text-indigo-500"/> Performance & Reliability</label>
                              <div className="grid grid-cols-2 gap-4">
                                 <div className="space-y-2">
                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-tight">Timeout (ms)</span>
                                    <input 
                                       type="number"
                                       className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-bold"
                                       value={activeNode.config.timeout || 15000}
                                       onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                          const val = parseInt(e.target.value, 10);
                                          setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, timeout: val}} : n));
                                       }}
                                    />
                                 </div>
                                 <div className="space-y-2">
                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-tight">Retentativas Max.</span>
                                    <input 
                                       type="number"
                                       min="0"
                                       max="10"
                                       className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-bold"
                                       value={activeNode.config.retries || 0}
                                       onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                          const val = parseInt(e.target.value, 10);
                                          setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, retries: val}} : n));
                                       }}
                                    />
                                 </div>
                              </div>
                           </div>
                        </div>
                   )}

                   {activeNode.type === 'convert' && (
                      <div className="space-y-8">
                         <div className="space-y-4">
                            <div className="flex items-center justify-between">
                               <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Valor de Entrada</label>
                               <PickerButton onClick={() => setShowVariablePicker({ nodeId: activeNode.id, field: 'value', type: 'config' })} />
                            </div>
                            <input 
                               className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 text-sm font-bold text-pink-600" 
                               placeholder="{{node.data.campo}} ou valor fixo"
                               value={activeNode.config.value || ''} 
                               onChange={(e) => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, value: e.target.value}} : n))}
                            />
                         </div>
                         <div className="space-y-4">
                            <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Converter para:</label>
                            <select 
                               className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold" 
                               value={activeNode.config.toType || 'string'} 
                               onChange={(e) => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, toType: e.target.value}} : n))}
                            >
                               <option value="string">String (Texto)</option>
                               <option value="int">Integer (Número Inteiro)</option>
                               <option value="float">Float (Número Decimal)</option>
                               <option value="boolean">Boolean (Verdadeiro/Falso)</option>
                               <option value="json">JSON (Objeto/Array)</option>
                            </select>
                         </div>
                      </div>
                   )}

                   {activeNode.type === 'query' && (
                      <div className="space-y-8">
                         <div className="space-y-4">
                            <label className="text-xs font-black text-slate-900 uppercase tracking-widest">SQL Statement (Restricted RLS)</label>
                            <textarea className="w-full h-80 bg-slate-900 text-amber-400 font-mono text-xs p-8 rounded-[2.5rem] border border-slate-800 outline-none shadow-2xl" value={activeNode.config.sql} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, sql: e.target.value}} : n))} />
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
                               <select className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold" value={activeNode.config.operation} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, operation: e.target.value}} : n))}>
                                  <option value="select">SELECT (Read)</option>
                                  <option value="insert">INSERT (Create)</option>
                                  <option value="upsert">UPSERT (Create or Update)</option>
                                  <option value="update">UPDATE (Edit)</option>
                                  <option value="delete">DELETE (Remove)</option>
                               </select>
                            </div>
                            <div className="space-y-4">
                               <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Tabela</label>
                               <select className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-bold" value={activeNode.config.table} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                                  const tableName = e.target.value;
                                  if (tableName) handleFetchColumns(tableName);
                                  setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, table: tableName}} : n));
                               }}>
                                  <option value="">Selecione...</option>
                                  {tables.map((t: string | { name: string }) => <option key={typeof t === 'string' ? t : t.name} value={typeof t === 'string' ? t : t.name}>{typeof t === 'string' ? t : t.name}</option>)}
                               </select>
                            </div>
                         </div>

                         {activeNode.config.operation === 'upsert' && (
                            <div className="space-y-4 bg-indigo-50/20 p-6 rounded-[2rem] border border-indigo-100/50">
                               <label className="text-[9px] font-black text-indigo-900 uppercase tracking-widest leading-none">Conflict Columns (e.g. email, id)</label>
                               <input className="w-full bg-white border border-indigo-100 rounded-xl px-4 py-3 text-xs font-mono" placeholder="id, email" value={activeNode.config.conflict_cols || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, conflict_cols: e.target.value}} : n))} />
                            </div>
                         )}
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
                                        {(activeNode.config.table && columns[activeNode.config.table] || []).map((col: string) => {
                                           const isUsed = activeNode.config.filters.some((fltr: any, idx: number) => fltr.column === col && idx !== i);
                                           if (isUsed) return null;
                                           return <option key={col} value={col}>{col}</option>;
                                        })}
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
                                     <div className="flex-1 flex gap-2 items-center">
                                         <input className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-2 text-[10px] font-medium" placeholder="Valor ou {{var}}" value={f.value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                            const nf = [...activeNode.config.filters]; nf[i].value = e.target.value;
                                            setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, filters: nf}} : n));
                                         }} />
                                         <PickerButton onClick={() => setShowVariablePicker({ nodeId: activeNode.id, field: `filters.${i}.value`, type: 'any' })} />
                                     </div>
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
                               <div className="flex items-center justify-between">
                                  <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Dados (Payload)</label>
                                  <div className="flex bg-slate-100 p-0.5 rounded-lg">
                                     <button onClick={() => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _payloadMode: 'visual'}} : n))} className={`px-3 py-1 rounded-md text-[8px] font-black uppercase tracking-widest transition-all ${(activeNode.config._payloadMode || 'visual') === 'visual' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}>Visual</button>
                                     <button onClick={() => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _payloadMode: 'code'}} : n))} className={`px-3 py-1 rounded-md text-[8px] font-black uppercase tracking-widest transition-all ${activeNode.config._payloadMode === 'code' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}>Código</button>
                                  </div>
                               </div>

                               {(activeNode.config._payloadMode || 'visual') === 'visual' ? (
                                  <div className="space-y-4">
                                     <div className="bg-white border border-slate-200 rounded-[2rem] p-6 space-y-4 shadow-sm">
                                        <div className="flex items-center justify-between mb-2">
                                           <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Mapeamento de Campos</label>
                                           <p className="text-[8px] text-slate-400 font-bold uppercase">Atribuir valores às colunas</p>
                                        </div>
                                        
                                        <div className="space-y-3">
                                           {(activeNode.config._payload || []).map((p: {column: string, value: string}, i: number) => (
                                              <div key={i} className="flex gap-2 items-center bg-slate-50 p-3 rounded-2xl border border-slate-100 group">
                                                  <select 
                                                    className="flex-1 bg-white border border-slate-200 rounded-xl px-3 py-2 text-[10px] font-bold" 
                                                    value={p.column} 
                                                    onChange={(e) => {
                                                       const np = [...(activeNode.config._payload || [])];
                                                       np[i].column = e.target.value;
                                                       const body = Object.fromEntries(np.filter(x => x.column).map(x => [x.column, x.value]));
                                                       setNodes(nodes.map(n => n.id === activeNode.id ? {...n, config: {...n.config, _payload: np, body}} : n));
                                                    }}
                                                  >
                                                     <option value="">Coluna...</option>
                                                     {(activeNode.config.table && columns[activeNode.config.table] || []).map(col => {
                                                        const isUsed = activeNode.config._payload.some((pl: any, idx: number) => pl.column === col && idx !== i);
                                                        if (isUsed) return null;
                                                        return <option key={col} value={col}>{col}</option>;
                                                     })}
                                                  </select>
                                                 
                                                 <div className="flex-[2] flex gap-2 items-center">
                                                    <input 
                                                      className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-2 text-[10px] font-medium" 
                                                      placeholder="Valor ou {{var}}" 
                                                      value={p.value} 
                                                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                                         const np = [...(activeNode.config._payload || [])];
                                                         np[i].value = e.target.value;
                                                         const body = Object.fromEntries(np.filter((x: {column: string}) => x.column).map((x: {column: string, value: string}) => [x.column, x.value]));
                                                         setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _payload: np, body}} : n));
                                                      }} 
                                                    />
                                                    <PickerButton onClick={() => setShowVariablePicker({ nodeId: activeNode.id, field: `_payload.${i}.value`, type: 'config' })} />
                                                 </div>
                                                 
                                                 <button 
                                                   className="text-slate-300 hover:text-rose-500 transition-colors" 
                                                   onClick={() => {
                                                      const np = activeNode.config._payload.filter((_: any, idx: number) => idx !== i);
                                                      const body = Object.fromEntries(np.filter((x: any) => x.column).map((x: any) => [x.column, x.value]));
                                                      setNodes(nodes.map(n => n.id === activeNode.id ? {...n, config: {...n.config, _payload: np, body}} : n));
                                                   }}
                                                 >
                                                   <Trash2 size={14}/>
                                                 </button>
                                              </div>
                                           ))}
                                        </div>

                                        <div className="flex gap-2">
                                           <button 
                                             className="flex-1 py-3 border border-dashed border-indigo-100 rounded-2xl text-[10px] font-black uppercase text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50/30 transition-all flex items-center justify-center gap-2" 
                                             onClick={() => {
                                                const np = [...(activeNode.config._payload || []), { column: '', value: '' }];
                                                setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _payload: np}} : n));
                                             }}
                                           >
                                              <Plus size={14}/> Adicionar Campo
                                           </button>

                                           {activeNode.config.table && columns[activeNode.config.table]?.some((c: string) => !activeNode.config._payload?.some((p: any) => p.column === c)) && (
                                              <button 
                                                className="px-4 py-3 border border-dashed border-emerald-100 rounded-2xl text-[10px] font-black uppercase text-emerald-500 hover:text-emerald-700 hover:bg-emerald-50/30 transition-all flex items-center justify-center gap-2"
                                                onClick={() => {
                                                   const allCols = columns[activeNode.config.table] || [];
                                                   const existingCols = activeNode.config._payload?.map((p: any) => p.column) || [];
                                                   const remainingCols = allCols.filter(c => !existingCols.includes(c));
                                                   const newPayload = [...(activeNode.config._payload || []), ...remainingCols.map(c => ({ column: c, value: '' }))];
                                                   const body = Object.fromEntries(newPayload.filter(x => x.column).map(x => [x.column, x.value]));
                                                   setNodes(nodes.map(n => n.id === activeNode.id ? {...n, config: {...n.config, _payload: newPayload, body}} : n));
                                                }}
                                              >
                                                 <Layers size={14}/> Todos
                                              </button>
                                           )}
                                         </div>
                                     </div>

                                     <div className="bg-indigo-50/30 p-4 rounded-2xl border border-indigo-100/50">
                                        <p className="text-[8px] text-indigo-700/70 font-bold uppercase leading-relaxed text-center">
                                           Dica: Use o Variable Picker para injetar resultados de nós anteriores ou variáveis do gatilho.
                                        </p>
                                     </div>
                                  </div>
                               ) : (
                                  <textarea className="w-full h-40 bg-slate-900 text-cyan-400 font-mono text-xs p-6 rounded-2xl border border-slate-800 outline-none" placeholder='{"campo": "valor"}' value={typeof activeNode.config.body === 'string' ? activeNode.config.body : JSON.stringify(activeNode.config.body, null, 2)} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                                     try { const p = JSON.parse(e.target.value); setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, body: p}} : n)); }
                                     catch { setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, body: e.target.value}} : n)); }
                                  }} />
                               )}
                            </div>
                         )}
                      </div>
                   )}

                   {activeNode.type === 'transform' && (
                      <div className="space-y-8">
                         <div className="space-y-4">
                            <div className="flex items-center justify-between">
                               <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Mapeamento de Dados</label>
                               <div className="flex bg-slate-100 p-0.5 rounded-lg">
                                  <button onClick={() => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _payloadMode: 'visual'}} : n))} className={`px-3 py-1 rounded-md text-[8px] font-black uppercase tracking-widest transition-all ${(activeNode.config._payloadMode || 'visual') === 'visual' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}>Visual</button>
                                  <button onClick={() => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _payloadMode: 'code'}} : n))} className={`px-3 py-1 rounded-md text-[8px] font-black uppercase tracking-widest transition-all ${activeNode.config._payloadMode === 'code' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}>Código</button>
                               </div>
                            </div>

                            {(activeNode.config._payloadMode || 'visual') === 'visual' ? (
                               <div className="space-y-3">
                                  <div className="bg-indigo-50/50 border border-indigo-100 rounded-2xl p-4 space-y-3">
                                     <label className="text-[9px] font-black text-indigo-600 uppercase tracking-widest flex items-center gap-2"><Layers size={10}/> Fonte dos Dados</label>
                                     <select className="w-full bg-white border border-indigo-200 rounded-xl px-3 py-2 text-[10px] font-bold" value={activeNode.config._dataSource || 'trigger'} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _dataSource: e.target.value}} : n))}>
                                        <option value="trigger">{"Trigger (Dados Originais)"}</option>
                                        {nodes.filter((n: Node) => n.id !== activeNode.id && n.type !== 'trigger').map((n: Node) => <option key={n.id} value={n.id}>{n.label} (#{n.id.split('_').pop()})</option>)}
                                     </select>
                                  </div>
                                  <div className="bg-white border border-slate-200 rounded-2xl divide-y divide-slate-100">
                                     {(activeNode.config._dataSource === 'trigger' || !activeNode.config._dataSource) && editingAutomation?.trigger_config?.table && (columns[editingAutomation.trigger_config.table] || []).map((col: string) => {
                                        const fields = activeNode.config._fields || {};
                                        const isChecked = fields[col] !== undefined;
                                        return (
                                           <div key={col} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50/50 transition-colors">
                                              <input type="checkbox" checked={isChecked} onChange={() => {
                                                 const nf = {...fields};
                                                 if (isChecked) delete nf[col]; else nf[col] = `{{trigger.data.${col}}}`;
                                                 const body = Object.fromEntries(Object.entries(nf).map(([k, v]) => [k, v]));
                                                 setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _fields: nf, body}} : n));
                                              }} className="w-4 h-4 rounded border-slate-300 text-indigo-600 accent-indigo-600" />
                                              <span className="text-[10px] font-bold text-slate-700 flex-1">{col}</span>
                                              {isChecked && <span className="text-[8px] font-mono text-indigo-400 bg-indigo-50 px-2 py-1 rounded-lg">{fields[col]}</span>}
                                           </div>
                                        );
                                     })}
                                  </div>
                                  <div className="space-y-2">
                                     <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Campos Extras / Transformações</label>
                                     {(activeNode.config._customFields || []).map((cf: {key: string, value: string}, i: number) => (
                                        <div key={i} className="flex gap-2">
                                           <input className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-[10px] font-bold" placeholder="nova_chave" value={cf.key} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                              const ncf = [...(activeNode.config._customFields || [])]; ncf[i].key = e.target.value;
                                              const body = {...(activeNode.config.body || {}), [e.target.value]: ncf[i].value};
                                              setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _customFields: ncf, body}} : n));
                                           }} />
                                           <div className="flex-1 flex gap-2 items-center">
                                               <input className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-[10px] font-mono" placeholder="{{node_id.data.campo}}" value={cf.value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                                  const ncf = [...(activeNode.config._customFields || [])]; ncf[i].value = e.target.value;
                                                  const body = {...(activeNode.config.body || {}), [ncf[i].key]: e.target.value};
                                                  setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _customFields: ncf, body}} : n));
                                               }} />
                                               <PickerButton onClick={() => setShowVariablePicker({ nodeId: activeNode.id, field: i.toString(), type: 'custom_field' })} />
                                            </div>
                                           <button className="text-slate-300 hover:text-rose-500 transition-colors" onClick={() => {
                                              const ncf = (activeNode.config._customFields || []).filter((_: any, idx: number) => idx !== i);
                                              setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _customFields: ncf}} : n));
                                           }}><Trash2 size={14}/></button>
                                        </div>
                                     ))}
                                     <button className="w-full py-2 border border-dashed border-slate-200 rounded-xl text-[9px] font-black uppercase text-slate-400 hover:text-indigo-600 hover:border-indigo-200 transition-all" onClick={() => {
                                        const ncf = [...(activeNode.config._customFields || []), { key: '', value: '' }];
                                        setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _customFields: ncf}} : n));
                                     }}>+ Campo Extra / Transformação</button>
                                  </div>
                               </div>
                            ) : (
                               <div className="space-y-2">
                                  <textarea className="w-full h-80 bg-slate-900 text-indigo-400 font-mono text-xs p-8 rounded-[2.5rem] border border-slate-800 outline-none shadow-2xl" value={typeof activeNode.config.body === 'string' ? activeNode.config.body : JSON.stringify(activeNode.config.body, null, 2)} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                                     try { const p = JSON.parse(e.target.value); setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, body: p}} : n)); }
                                     catch { setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, body: e.target.value}} : n)); }
                                  }} />
                                  <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest leading-relaxed">Use {"{{node_id.data.campo}}"} para injetar dados.</p>
                               </div>
                            )}
                         </div>
                      </div>
                   )}

                   {activeNode.type === 'rpc' && (
                      <div className="space-y-8">
                         <div className="space-y-4">
                            <label className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center justify-between">
                               <div className="flex items-center gap-2">
                                  <Code size={12} className="text-violet-500"/> Função do Banco (RPC)
                               </div>
                               <div className="flex items-center gap-2 bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                                  <Search size={10} className="text-slate-400"/>
                                  <input 
                                    className="bg-transparent border-none outline-none text-[8px] font-bold w-24 placeholder:text-slate-400" 
                                    placeholder="FILTRAR..." 
                                    value={rpcSearch}
                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRpcSearch(e.target.value)}
                                  />
                               </div>
                            </label>
                            
                            <select 
                               className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3.5 text-sm font-bold shadow-sm focus:ring-2 focus:ring-violet-500/20 transition-all outline-none"
                               value={activeNode.config.function || ''}
                               onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                                  const fnName = e.target.value;
                                  setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, function: fnName, args: {}}} : n));
                                  if (fnName) fetchFunctionDef(fnName);
                               }}
                            >
                               <option value="">Selecione uma função...</option>
                               {functions
                                 .filter((fn: {name: string}) => {
                                    const isSystem = SYSTEM_RPC_PREFIXES.some((p: string) => fn.name.startsWith(p));
                                    const matchesSearch = fn.name.toLowerCase().includes(rpcSearch.toLowerCase());
                                    return !isSystem && matchesSearch;
                                 })
                                 .map((fn: {name: string}) => (
                                    <option key={fn.name} value={fn.name}>{fn.name}</option>
                                 ))
                               }
                            </select>
                            
                            {!functions.some((fn: {name: string}) => !SYSTEM_RPC_PREFIXES.some((p: string) => fn.name.startsWith(p))) && (
                               <div className="flex items-center gap-3 p-4 bg-amber-50 border border-amber-100 rounded-2xl">
                                  <AlertCircle size={16} className="text-amber-500"/>
                                  <p className="text-[10px] text-amber-700 font-bold leading-relaxed">Nenhuma função customizada encontrada. Crie funções no SQL Editor para orquestrá-las aqui.</p>
                               </div>
                            )}
                         </div>

                         {/* Auto-detected Arguments */}
                         {activeNode.config.function && (
                            <div className="space-y-4">
                               <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Parâmetros</label>
                               {functionArgs[activeNode.config.function] ? (
                                  <div className="space-y-3">
                                     {functionArgs[activeNode.config.function].filter((a: {mode: string}) => a.mode === 'IN' || a.mode === 'INOUT').map((arg: {name: string, type: string}, i: number) => (
                                        <div key={i} className="bg-slate-50 rounded-2xl p-4 space-y-2">
                                           <div className="flex items-center justify-between">
                                              <span className="text-[10px] font-black text-slate-700 uppercase tracking-widest">{arg.name || `arg_${i + 1}`}</span>
                                              <span className="text-[8px] font-bold text-violet-500 bg-violet-50 px-2 py-1 rounded-lg uppercase">{arg.type}</span>
                                           </div>
                                            <div className="flex gap-2 items-center">
                                               <input className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm" value={(activeNode.config.args && typeof activeNode.config.args === 'object' && !Array.isArray(activeNode.config.args)) ? (activeNode.config.args[arg.name || `arg_${i + 1}`] || '') : ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                                  const argKey = arg.name || `arg_${i + 1}`;
                                                  const newArgs = {...(typeof activeNode.config.args === 'object' && !Array.isArray(activeNode.config.args) ? activeNode.config.args : {}), [argKey]: e.target.value};
                                                  setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, args: newArgs}} : n));
                                               }} />
                                               <PickerButton onClick={() => setShowVariablePicker({ nodeId: activeNode.id, field: arg.name || `arg_${i + 1}`, type: 'rpc_arg' })} />
                                            </div>
                                        </div>
                                     ))}
                                     {functionArgs[activeNode.config.function].filter((a: {mode: string}) => a.mode === 'IN' || a.mode === 'INOUT').length === 0 && (
                                        <p className="text-[10px] text-slate-400 font-bold bg-slate-50 px-4 py-3 rounded-xl text-center uppercase">Esta função não requer parâmetros</p>
                                     )}
                                  </div>
                               ) : (
                                  <div className="animate-pulse bg-slate-50 rounded-2xl p-6 text-center">
                                     <p className="text-[10px] text-slate-400 font-bold uppercase">Carregando definição da função...</p>
                                  </div>
                               )}
                            </div>
                         )}

                         <div className="bg-violet-50 rounded-2xl p-4 border border-violet-100">
                            <p className="text-[9px] text-violet-700 font-bold uppercase leading-relaxed"><Shield size={10} className="inline mr-1"/> Funções executam com a ROLE do usuário que acionou o gatilho. RLS é respeitado.</p>
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
                               <label className="text-xs font-black text-slate-900 uppercase tracking-widest">Response Payload</label>
                               <div className="flex bg-slate-100 p-0.5 rounded-lg">
                                  <button onClick={() => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _payloadMode: 'visual'}} : n))} className={`px-3 py-1 rounded-md text-[8px] font-black uppercase tracking-widest transition-all ${(activeNode.config._payloadMode || 'visual') === 'visual' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}>Visual</button>
                                  <button onClick={() => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _payloadMode: 'code'}} : n))} className={`px-3 py-1 rounded-md text-[8px] font-black uppercase tracking-widest transition-all ${activeNode.config._payloadMode === 'code' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400'}`}>Código</button>
                               </div>
                            </div>

                            {(activeNode.config._payloadMode || 'visual') === 'visual' ? (
                               <div className="space-y-4">
                                  <div className="bg-emerald-50/50 border border-emerald-100 rounded-[2rem] p-6 space-y-4">
                                     <div className="flex items-center justify-between">
                                        <label className="text-[10px] font-black text-emerald-600 uppercase tracking-widest flex items-center gap-2"><ArrowRight size={10}/> Fonte dos Dados</label>
                                        <select className="bg-white border border-emerald-200 rounded-xl px-3 py-1.5 text-[10px] font-bold outline-none" value={activeNode.config._dataSource || 'trigger'} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _dataSource: e.target.value, _fields: {}}} : n))}>
                                           <option value="trigger">{"Trigger (Gatilho)"}</option>
                                           {nodes.filter((n: Node) => n.id !== activeNode.id && n.type !== 'trigger').map((n: Node) => <option key={n.id} value={n.id}>{n.label} (#{n.id.split('_').pop()})</option>)}
                                        </select>
                                     </div>

                                     <div className="bg-white border border-slate-200 rounded-2xl divide-y divide-slate-100 overflow-hidden min-h-[100px]">
                                        {(() => {
                                           const sourceId = activeNode.config._dataSource || 'trigger';
                                           const sourceNode = nodes.find(n => n.id === sourceId);
                                           let availableKeys: string[] = [];
                                           
                                           if (sourceId === 'trigger') {
                                              availableKeys = editingAutomation?.trigger_config?.table ? (columns[editingAutomation.trigger_config.table] || []) : [];
                                           } else if (sourceNode) {
                                              availableKeys = sourceNode.config._sampleKeys || [];
                                           }

                                           if (availableKeys.length === 0) {
                                              return (
                                                 <div className="p-8 text-center space-y-4">
                                                    <div className="flex justify-center"><AlertCircle size={24} className="text-slate-200"/></div>
                                                    <p className="text-[10px] text-slate-400 font-bold uppercase leading-relaxed px-4">
                                                       {sourceId === 'trigger' 
                                                         ? "Nenhuma tabela selecionada no gatilho." 
                                                         : `Clique em "Testar Nó" no drawer do nó #${sourceId.split('_').pop()} para extrair os campos disponíveis.`}
                                                    </p>
                                                    {sourceId !== 'trigger' && (
                                                       <button 
                                                         onClick={() => setConfigNodeId(sourceId)}
                                                         className="text-[9px] font-black text-indigo-600 uppercase tracking-widest border-b border-indigo-200"
                                                       >
                                                          Abrir Configurações do Nó #{sourceId.split('_').pop()}
                                                       </button>
                                                    )}
                                                 </div>
                                              );
                                           }

                                           return availableKeys.map((col: string) => {
                                              const fields = activeNode.config._fields || {};
                                              const isChecked = fields[col] !== undefined;
                                              const path = sourceId === 'trigger' ? `{{trigger.data.${col}}}` : `{{${sourceId}.data.${col}}}`;
                                              return (
                                                 <div key={col} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50/50 transition-colors">
                                                    <input type="checkbox" checked={isChecked} onChange={() => {
                                                       const nf = {...fields};
                                                       if (isChecked) delete nf[col]; else nf[col] = path;
                                                       const body = {
                                                         ...(activeNode.config.body || {}),
                                                         ...nf
                                                       };
                                                       setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _fields: nf, body}} : n));
                                                    }} className="w-4 h-4 rounded border-slate-300 text-emerald-600 accent-emerald-600" />
                                                    <span className="text-[10px] font-bold text-slate-700 flex-1">{col}</span>
                                                    {isChecked && <span className="text-[7px] font-mono text-emerald-500 bg-emerald-50 px-2 py-1 rounded-lg uppercase">{path}</span>}
                                                 </div>
                                              );
                                           });
                                        })()}
                                     </div>
                                  </div>

                                  <div className="space-y-4">
                                     <div className="flex items-center justify-between">
                                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Campos Personalizados</label>
                                        <button className="text-[8px] font-black text-indigo-600 uppercase border-b border-indigo-100" onClick={() => {
                                           const ncf = [...(activeNode.config._customFields || []), { key: '', value: '' }];
                                           setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _customFields: ncf}} : n));
                                        }}>+ Adicionar Campo</button>
                                     </div>
                                     
                                     <div className="space-y-2">
                                        {(activeNode.config._customFields || []).map((cf: {key: string, value: string}, i: number) => (
                                           <div key={i} className="flex gap-2 items-center bg-slate-50 p-2 rounded-2xl border border-slate-100 group">
                                              <input className="w-1/3 bg-white border border-slate-200 rounded-xl px-3 py-2 text-[10px] font-bold" placeholder="ID" value={cf.key} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                                 const ncf = [...(activeNode.config._customFields || [])]; ncf[i].key = e.target.value;
                                                 const body = {
                                                   ...(activeNode.config._fields || {}),
                                                   ...Object.fromEntries(ncf.filter((x: any) => x.key).map((x: any) => [x.key, x.value]))
                                                 };
                                                 setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _customFields: ncf, body}} : n));
                                              }} />
                                              <div className="flex-1 flex gap-2 items-center">
                                                  <input className="flex-1 bg-white border border-slate-200 rounded-xl px-3 py-2 text-[10px] font-medium" placeholder="Valor ou {{var}}" value={cf.value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                                     const ncf = [...(activeNode.config._customFields || [])]; ncf[i].value = e.target.value;
                                                     const body = {
                                                       ...(activeNode.config._fields || {}),
                                                       ...Object.fromEntries(ncf.filter((x: any) => x.key).map((x: any) => [x.key, x.value]))
                                                     };
                                                     setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _customFields: ncf, body}} : n));
                                                  }} />
                                                  <PickerButton onClick={() => setShowVariablePicker({ nodeId: activeNode.id, field: `_customFields.${i}.value`, type: 'config' })} />
                                               </div>
                                              <button className="text-slate-300 hover:text-rose-500 transition-colors opacity-0 group-hover:opacity-100" onClick={() => {
                                                 const ncf = (activeNode.config._customFields || []).filter((_: any, idx: number) => idx !== i);
                                                 const body = {
                                                   ...activeNode.config._fields,
                                                   ...Object.fromEntries(ncf.filter(x => x.key).map(x => [x.key, x.value]))
                                                 };
                                                 setNodes(nodes.map((n: Node) => n.id === activeNode.id ? {...n, config: {...n.config, _customFields: ncf, body}} : n));
                                              }}><Trash2 size={14}/></button>
                                           </div>
                                        ))}
                                     </div>
                                  </div>
                               </div>
                            ) : (
                               <div className="space-y-2">
                                  <div className="flex justify-end">
                                     <div className="relative group/help">
                                        <button className="text-[10px] font-black text-indigo-600 uppercase flex items-center gap-2 hover:bg-indigo-50 px-3 py-1.5 rounded-lg transition-all"><Terminal size={12}/> Variáveis</button>
                                        <div className="absolute right-0 bottom-full mb-2 w-48 bg-slate-900 text-white p-4 rounded-2xl text-[10px] font-medium opacity-0 group-hover/help:opacity-100 transition-opacity z-50 pointer-events-none shadow-2xl border border-slate-700">
                                           <span className="text-indigo-400 font-black block mb-2 uppercase">Variáveis:</span>
                                           <code className="text-emerald-400 block mb-1">{"{{"}trigger.data.*{"}}"}</code>
                                           <code className="text-emerald-400 block">{"{{"}node_id.data.*{"}}"}</code>
                                        </div>
                                     </div>
                                  </div
                                  ><textarea 
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
                            )}
                         </div>
                      </div>
                   )}
                </div>

                <footer className="p-8 border-t border-slate-50 flex justify-end">
                    <button onClick={() => setConfigNodeId(null)} className="btn-premium">
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

        {showVariablePicker && (
            <VariablePicker 
                onSelect={handleVariableSelect} 
                onClose={() => setShowVariablePicker(null)} 
            />
        )}
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">
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

const AutomationTestPanel: React.FC<{ 
  onTest: () => void, 
  loading: boolean,
  lastResult?: any 
}> = ({ onTest, loading, lastResult }) => (
  <div className="space-y-3">
    <button 
      onClick={onTest} 
      disabled={loading}
      className={`w-full py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all ${
        loading ? 'bg-slate-100 text-slate-400' : 'bg-indigo-600 text-white hover:bg-black shadow-lg shadow-indigo-100'
      }`}
    >
      {loading ? <Loader2 size={14} className="animate-spin"/> : <Play size={14}/>}
      {loading ? 'Executando Teste...' : 'Testar Nó'}
    </button>
    
    {lastResult && (
      <div className="bg-slate-900 rounded-2xl p-4 overflow-hidden border border-slate-800">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[8px] font-black text-indigo-400 uppercase tracking-widest">Resultado do Teste</span>
          <span className="text-[8px] font-mono text-slate-500">JSON</span>
        </div>
        <pre className="text-[10px] font-mono text-emerald-400 overflow-x-auto custom-scrollbar max-h-40">
          {JSON.stringify(lastResult, null, 2)}
        </pre>
      </div>
    )}
  </div>
);

const ToolboxItem = ({ icon, label, onClick, color }: { icon: React.ReactNode, label: string, onClick: () => void, color: string }) => (
  <button onClick={onClick} className="flex flex-col items-center gap-2 group transition-all hover:-translate-y-2">
    <div className={`w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-300 group-hover:${color} group-hover:text-white transition-all shadow-inner border border-transparent group-hover:shadow-[0_15px_30px_-5px_rgba(0,0,0,0.1)]`}>
      {icon}
    </div>
    <span className="text-[8px] font-black uppercase text-slate-400 group-hover:text-slate-900 tracking-widest transition-colors">{label}</span>
  </button>
);

export default AutomationManager;
