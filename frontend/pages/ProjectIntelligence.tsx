
import React, { useState, useEffect } from 'react';
import { 
  Bot, Cable, Brain, ScanEye, EyeOff, Loader2, Copy, CheckCircle2, Lock, Eye, Shield, 
  Search, Server, FileJson, CheckSquare, Square, AlertTriangle, Zap, Database,
  Table as TableIcon, MousePointer2, X
} from 'lucide-react';

interface TableGovernance {
  c: boolean; // Create
  r: boolean; // Read
  u: boolean; // Update
  d: boolean; // Delete
}

const ProjectIntelligence: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // AI Governance State (New Structure)
  const [aiGovernance, setAiGovernance] = useState({ 
      mcp_enabled: true,
      tables: {} as Record<string, TableGovernance>,
      rpcs: [] as string[]
  });
  
  // Data State
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [availableRpcs, setAvailableRpcs] = useState<string[]>([]);
  const [tableSearch, setTableSearch] = useState('');
  
  // MCP Connection View State
  const [mcpViewMode, setMcpViewMode] = useState<'url' | 'json'>('url');
  const [revealedKeyValues, setRevealedKeyValues] = useState<Record<string, string>>({});
  
  // Verify Modal
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyPassword, setVerifyPassword] = useState('');
  const [verifyLoading, setVerifyLoading] = useState(false);

  const fetchProject = async () => {
    try {
        const res = await fetch('/api/control/projects', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
        });
        const data = await res.json();
        const current = data.find((p: any) => p.slug === projectId);
        
        if (current) {
            setProject(current);
            // Migrate legacy governance if necessary
            if (current.metadata?.ai_governance) {
                const gov = current.metadata.ai_governance;
                
                // Compatibility migration for old structure
                if (Array.isArray(gov.allowed_tables)) {
                    const newTables: Record<string, TableGovernance> = {};
                    gov.allowed_tables.forEach((t: string) => {
                        newTables[t] = { c: false, r: true, u: false, d: false }; // Default Read-Only
                    });
                    setAiGovernance({
                        mcp_enabled: gov.mcp_enabled ?? true,
                        tables: newTables,
                        rpcs: gov.rpcs || []
                    });
                } else {
                    setAiGovernance(gov);
                }
            }
        }
        fetchMetadata();
    } catch (e) {
        console.error("Failed to sync project settings");
    } finally {
        setLoading(false);
    }
  };

  const fetchMetadata = async () => {
      try {
          const token = localStorage.getItem('cascata_token');
          const [tablesRes, rpcsRes] = await Promise.all([
            fetch(`/api/data/${projectId}/tables`, { headers: { 'Authorization': `Bearer ${token}` } }),
            fetch(`/api/data/${projectId}/functions`, { headers: { 'Authorization': `Bearer ${token}` } })
          ]);
          
          const tablesData = await tablesRes.json();
          setAvailableTables(tablesData.map((t: any) => t.name));

          const rpcsData = await rpcsRes.json();
          setAvailableRpcs(rpcsData.map((r: any) => r.name));
      } catch(e) {}
  };

  useEffect(() => { fetchProject(); }, [projectId]);

  const handleUpdateSettings = async () => {
    setSaving(true);
    try {
      const metaUpdate: any = { 
          ...project.metadata,
          ai_governance: aiGovernance
      };
      
      const res = await fetch(`/api/control/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
        body: JSON.stringify({ metadata: metaUpdate })
      });
      
      if (!res.ok) throw new Error((await res.json()).error);

      setSuccess('Regras de Governança Atualizadas.');
      setTimeout(() => setSuccess(null), 3000);
    } catch (e: any) { 
        setError(e.message || 'Erro ao salvar governança.');
        setTimeout(() => setError(null), 3000);
    } finally { 
        setSaving(false); 
    }
  };

  const handleRevealKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifyPassword) { alert("Digite a senha."); return; }
    
    setVerifyLoading(true);
    try {
        const res = await fetch(`/api/control/projects/${projectId}/reveal-key`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
            body: JSON.stringify({ password: verifyPassword, keyType: 'service_key' })
        });
        const data = await res.json();
        if (!res.ok) { alert(data.error || "Senha incorreta."); } else {
            setRevealedKeyValues(prev => ({ ...prev, service: data.key }));
            setTimeout(() => { setRevealedKeyValues(prev => { const updated = { ...prev }; delete updated['service']; return updated; }); }, 60000);
            setShowVerifyModal(false); setVerifyPassword('');
        }
    } catch (e) { alert("Erro de conexão."); } 
    finally { setVerifyLoading(false); }
  };

  const copyToClipboard = (text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setSuccess("Copiado!");
    setTimeout(() => setSuccess(null), 2000);
  };

  const toggleTablePerm = (table: string, perm: keyof TableGovernance) => {
      const current = aiGovernance.tables[table] || { c: false, r: false, u: false, d: false };
      const updated = { ...current, [perm]: !current[perm] };
      
      // If all false, remove table from object to keep clean
      if (!updated.c && !updated.r && !updated.u && !updated.d) {
          const nextTables = { ...aiGovernance.tables };
          delete nextTables[table];
          setAiGovernance(prev => ({ ...prev, tables: nextTables }));
      } else {
          setAiGovernance(prev => ({ ...prev, tables: { ...prev.tables, [table]: updated } }));
      }
  };

  const toggleRpc = (rpcName: string) => {
      const current = new Set(aiGovernance.rpcs);
      if (current.has(rpcName)) current.delete(rpcName); else current.add(rpcName);
      setAiGovernance(prev => ({ ...prev, rpcs: Array.from(current) }));
  };

  if (loading) return <div className="p-20 flex justify-center"><Loader2 className="animate-spin text-indigo-600" /></div>;

  const mcpConfigJson = JSON.stringify({
      "mcpServers": {
          "cascata": {
              "url": `${window.location.origin}/api/data/${project?.slug}/mcp/sse`,
              "headers": {
                  "x-cascata-client": "mcp",
                  "Authorization": `Bearer ${revealedKeyValues['service'] || '<REVEAL_KEY_FIRST>'}`
              }
          }
      }
  }, null, 2);

  const filteredTables = availableTables.filter(t => t.toLowerCase().includes(tableSearch.toLowerCase()));

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8 pb-40">
        {(success || error) && (
             <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[500] px-6 py-4 rounded-full shadow-2xl flex items-center gap-3 animate-in slide-in-from-top-4 ${error ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`}>
               {error ? <AlertTriangle size={18}/> : <CheckCircle2 size={18}/>}
               <span className="text-xs font-bold">{success || error}</span>
             </div>
        )}

        <div className="flex items-end justify-between">
            <div>
                 <h1 className="text-4xl font-black text-slate-900 tracking-tighter mb-2">Neural Core AI</h1>
                 <p className="text-slate-400 text-sm font-medium">Configure como Agentes de IA (Cursor, Windsurf, Lovable) interagem com seus dados.</p>
            </div>
            <div className="bg-indigo-50 text-indigo-700 px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 border border-indigo-100">
                <Brain size={16}/> MCP Protocol v1.0
            </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
            
            {/* COL 1: CONNECT & AGENT KEYS */}
            <div className="xl:col-span-1 space-y-8">
                
                {/* MCP AGENT CONNECT CARD */}
                <div className="bg-white border border-slate-200 rounded-[3rem] p-8 shadow-sm relative overflow-hidden group">
                    <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform duration-500"><Cable size={120}/></div>
                    
                    <div className="relative z-10">
                        <div className="flex justify-between items-start mb-6">
                            <div>
                                <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3"><Bot size={22} className="text-indigo-600"/> Connect Agent</h3>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Model Context Protocol</p>
                            </div>
                            <div className="bg-slate-100 rounded-lg p-1 flex">
                                <button onClick={() => setMcpViewMode('url')} className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase transition-all ${mcpViewMode === 'url' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-indigo-600'}`}>URL</button>
                                <button onClick={() => setMcpViewMode('json')} className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase transition-all ${mcpViewMode === 'json' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-indigo-600'}`}>Config</button>
                            </div>
                        </div>
                        
                        <p className="text-xs text-slate-500 mb-6 font-medium leading-relaxed">
                            Permite que ferramentas de IA acessem seu schema e executem queries SQL via protocolo seguro MCP.
                        </p>
                        
                        {mcpViewMode === 'url' ? (
                            <div className="space-y-4">
                                <div className="group/code relative">
                                    <div className="text-[9px] font-black uppercase text-slate-400 mb-1 tracking-widest">Server URL (SSE)</div>
                                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex items-center gap-2">
                                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                                        <code className="text-xs text-slate-700 font-mono truncate flex-1">{`${window.location.origin}/api/data/${project?.slug}/mcp/sse`}</code>
                                        <button onClick={() => copyToClipboard(`${window.location.origin}/api/data/${project?.slug}/mcp/sse`)} className="text-slate-400 hover:text-indigo-600"><Copy size={14}/></button>
                                    </div>
                                </div>
                                <div className="p-3 bg-amber-50 rounded-xl border border-amber-100 text-[10px] text-amber-800 font-medium">
                                    <strong>Header Obrigatório:</strong> <br/>
                                    <code>Authorization: Bearer SERVICE_KEY</code>
                                </div>
                            </div>
                        ) : (
                            <div className="group/code relative">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-[9px] font-black uppercase text-slate-400 tracking-widest">claude_desktop_config.json</span>
                                    {!revealedKeyValues['service'] && (
                                        <button onClick={() => setShowVerifyModal(true)} className="text-[9px] bg-indigo-50 text-indigo-600 px-2 py-1 rounded border border-indigo-100 font-bold hover:bg-indigo-100 transition-colors flex items-center gap-1">
                                            <Lock size={10}/> REVEAL KEY
                                        </button>
                                    )}
                                </div>
                                <div className="relative">
                                    <pre className="bg-slate-900 p-4 rounded-xl border border-slate-800 text-[10px] text-emerald-400 font-mono overflow-x-auto whitespace-pre-wrap max-h-48 custom-scrollbar shadow-inner">
                                        {mcpConfigJson}
                                    </pre>
                                    <button onClick={() => copyToClipboard(mcpConfigJson)} className="absolute top-2 right-2 p-2 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-all opacity-0 group-hover/code:opacity-100"><Copy size={14}/></button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="bg-gradient-to-br from-slate-50 to-white border border-slate-200 rounded-[3rem] p-8 shadow-sm">
                    <h3 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-3 mb-4">
                        <Shield size={18} className="text-emerald-600"/> Security Context
                    </h3>
                    <ul className="space-y-3">
                        <li className="flex items-start gap-3 text-xs text-slate-600">
                            <CheckCircle2 size={16} className="text-emerald-500 shrink-0 mt-0.5"/>
                            <span>Agentes usam a <strong>Service Role</strong>, mas o backend filtra as queries via parser.</span>
                        </li>
                        <li className="flex items-start gap-3 text-xs text-slate-600">
                            <CheckCircle2 size={16} className="text-emerald-500 shrink-0 mt-0.5"/>
                            <span>O contexto de schema enviado para a IA contém apenas as tabelas permitidas (R).</span>
                        </li>
                        <li className="flex items-start gap-3 text-xs text-slate-600">
                            <CheckCircle2 size={16} className="text-emerald-500 shrink-0 mt-0.5"/>
                            <span>Logs de auditoria registram todas as queries geradas por IA.</span>
                        </li>
                    </ul>
                </div>
            </div>

            {/* COL 2: GOVERNANCE SETTINGS */}
            <div className="xl:col-span-2 space-y-8">
                <div className="bg-white border border-slate-200 rounded-[4rem] p-12 shadow-sm relative overflow-hidden">
                     <div className="flex items-center justify-between mb-8">
                        <div>
                            <h3 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-4">
                                <div className="w-12 h-12 bg-slate-900 text-white rounded-2xl flex items-center justify-center shadow-xl"><Brain size={24} /></div>
                                Governance Rules
                            </h3>
                        </div>
                        <button 
                            onClick={handleUpdateSettings} 
                            disabled={saving}
                            className="bg-indigo-600 text-white px-8 py-3 rounded-2xl font-black uppercase tracking-widest text-xs flex items-center justify-center hover:bg-indigo-700 transition-all shadow-lg disabled:opacity-50"
                        >
                            {saving ? <Loader2 className="animate-spin" size={16}/> : 'Salvar Alterações'}
                        </button>
                     </div>
                    
                    {/* Toggle Master */}
                    <div className={`rounded-[2.5rem] p-8 border mb-8 transition-all ${aiGovernance.mcp_enabled ? 'bg-emerald-50 border-emerald-100' : 'bg-slate-50 border-slate-200'}`}>
                        <div className="flex justify-between items-start mb-4">
                            <div>
                                <span className={`text-sm font-black uppercase tracking-widest block ${aiGovernance.mcp_enabled ? 'text-emerald-700' : 'text-slate-500'}`}>MCP Access</span>
                                <span className="text-xs font-medium text-slate-500">{aiGovernance.mcp_enabled ? 'Habilitado' : 'Desabilitado'}</span>
                            </div>
                            <button 
                                onClick={() => setAiGovernance(prev => ({ ...prev, mcp_enabled: !prev.mcp_enabled }))}
                                className={`w-14 h-8 rounded-full p-1 transition-colors ${aiGovernance.mcp_enabled ? 'bg-emerald-500 shadow-emerald-200 shadow-md' : 'bg-slate-300'}`}
                            >
                                <div className={`w-6 h-6 bg-white rounded-full shadow-sm transition-transform ${aiGovernance.mcp_enabled ? 'translate-x-6' : ''}`}></div>
                            </button>
                        </div>
                        <p className="text-[10px] text-slate-500 font-medium leading-relaxed">
                            Master Switch. Se desligado, nenhuma ferramenta de IA conseguirá conectar neste projeto, independente da chave usada.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        {/* Table CRUD Selector */}
                        <div className="space-y-6">
                            <div className="flex items-center justify-between">
                                <div>
                                    <label className="text-sm font-black text-slate-900 uppercase tracking-widest block">Data Access (CRUD)</label>
                                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Permissões de Tabela</p>
                                </div>
                                <div className="relative">
                                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
                                    <input 
                                        value={tableSearch}
                                        onChange={(e) => setTableSearch(e.target.value)}
                                        placeholder="Filtrar..."
                                        className="pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-indigo-500/20"
                                    />
                                </div>
                            </div>
                            
                            <div className="bg-slate-50 rounded-[2rem] p-4 border border-slate-200 h-[400px] overflow-y-auto custom-scrollbar">
                                <div className="grid grid-cols-1 gap-2">
                                    {filteredTables.map(t => {
                                        const perms = aiGovernance.tables[t] || { c: false, r: false, u: false, d: false };
                                        const hasAny = perms.c || perms.r || perms.u || perms.d;
                                        
                                        return (
                                            <div key={t} className={`p-3 rounded-2xl border transition-all ${hasAny ? 'bg-white border-indigo-200 shadow-sm' : 'bg-transparent border-transparent opacity-60 hover:opacity-100'}`}>
                                                <div className="flex items-center justify-between mb-2">
                                                    <div className="flex items-center gap-2">
                                                        <TableIcon size={14} className="text-slate-400"/>
                                                        <span className="text-xs font-bold text-slate-700">{t}</span>
                                                    </div>
                                                </div>
                                                <div className="flex gap-2">
                                                    <button onClick={() => toggleTablePerm(t, 'r')} className={`flex-1 py-1 rounded text-[9px] font-black transition-colors ${perms.r ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-200 text-slate-400'}`}>READ</button>
                                                    <button onClick={() => toggleTablePerm(t, 'c')} className={`flex-1 py-1 rounded text-[9px] font-black transition-colors ${perms.c ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-400'}`}>CREATE</button>
                                                    <button onClick={() => toggleTablePerm(t, 'u')} className={`flex-1 py-1 rounded text-[9px] font-black transition-colors ${perms.u ? 'bg-amber-100 text-amber-700' : 'bg-slate-200 text-slate-400'}`}>UPDATE</button>
                                                    <button onClick={() => toggleTablePerm(t, 'd')} className={`flex-1 py-1 rounded text-[9px] font-black transition-colors ${perms.d ? 'bg-rose-100 text-rose-700' : 'bg-slate-200 text-slate-400'}`}>DELETE</button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>

                        {/* RPC Selector */}
                        <div className="space-y-6">
                            <div>
                                <label className="text-sm font-black text-slate-900 uppercase tracking-widest block">Logic Access (RPC)</label>
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Funções Permitidas</p>
                            </div>
                            
                            <div className="bg-slate-50 rounded-[2rem] p-4 border border-slate-200 h-[400px] overflow-y-auto custom-scrollbar">
                                <div className="grid grid-cols-1 gap-2">
                                    {availableRpcs.map(rpc => {
                                        const isAllowed = aiGovernance.rpcs.includes(rpc);
                                        return (
                                            <div 
                                                key={rpc} 
                                                onClick={() => toggleRpc(rpc)}
                                                className={`p-4 rounded-2xl border cursor-pointer flex items-center justify-between transition-all ${isAllowed ? 'bg-white border-amber-200 shadow-sm' : 'bg-transparent border-transparent opacity-60 hover:opacity-100'}`}
                                            >
                                                <div className="flex items-center gap-3">
                                                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isAllowed ? 'bg-amber-100 text-amber-600' : 'bg-slate-200 text-slate-400'}`}>
                                                        <Zap size={16}/>
                                                    </div>
                                                    <span className="text-xs font-bold text-slate-700">{rpc}</span>
                                                </div>
                                                {isAllowed ? <CheckCircle2 size={16} className="text-amber-500"/> : <Square size={16} className="text-slate-300"/>}
                                            </div>
                                        );
                                    })}
                                    {availableRpcs.length === 0 && <p className="text-center text-[10px] text-slate-400 py-10">Nenhuma função encontrada.</p>}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        {/* Verify Password Modal */}
        {showVerifyModal && (
            <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[800] flex items-center justify-center p-8 animate-in zoom-in-95">
                <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl text-center border border-slate-200">
                    <Lock size={40} className="mx-auto text-slate-900 mb-6" />
                    <h3 className="text-xl font-black text-slate-900 mb-2">Security Check</h3>
                    <p className="text-xs text-slate-500 font-bold mb-8">Enter admin password to reveal Service Key.</p>
                    <form onSubmit={handleRevealKey}>
                        <input 
                            type="password" 
                            autoFocus
                            value={verifyPassword}
                            onChange={e => setVerifyPassword(e.target.value)}
                            className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-center font-bold text-slate-900 outline-none mb-6 focus:ring-4 focus:ring-indigo-500/10"
                            placeholder="••••••••"
                        />
                        <button type="submit" disabled={verifyLoading} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-2">
                            {verifyLoading ? <Loader2 className="animate-spin" size={16}/> : 'Reveal Key'}
                        </button>
                    </form>
                    <button onClick={() => { setShowVerifyModal(false); }} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600">Cancel</button>
                </div>
            </div>
        )}
    </div>
  );
};

export default ProjectIntelligence;
