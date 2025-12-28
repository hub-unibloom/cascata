
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Code2, Play, Plus, Book, Clock, Terminal, Loader2, Folder, FolderPlus, 
  ChevronRight, ChevronDown, FileCode, Search, MoreVertical, Trash2, Copy, 
  CheckCircle2, X, Zap, Info, ExternalLink, Save, Cpu, RefreshCw, Layout, 
  AlertCircle, Edit, BookOpen, Key, Globe
} from 'lucide-react';

type AssetType = 'rpc' | 'trigger' | 'cron' | 'folder' | 'edge_function';

interface ProjectAsset {
  id: string;
  name: string;
  type: AssetType;
  parent_id: string | null;
  metadata: {
    notes?: string;
    sql?: string; // For RPC/Triggers
    db_object_name?: string;
    env_vars?: Record<string, string>; // For Edge Functions
    timeout?: number; // In Seconds
  };
}

interface AssetTreeNode extends ProjectAsset {
  children: AssetTreeNode[];
}

const RPCManager: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [activeContext, setActiveContext] = useState<AssetType>('rpc');
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [dbObjects, setDbObjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<ProjectAsset | null>(null);
  const [projectData, setProjectData] = useState<any>(null);
  
  // Editor State
  const [editorSql, setEditorSql] = useState('');
  const [notes, setNotes] = useState('');
  const [testParams, setTestParams] = useState('{}');
  const [testResult, setTestResult] = useState<any>(null);
  
  // Edge Function Specific State
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvVal, setNewEnvVal] = useState('');
  const [timeoutSec, setTimeoutSec] = useState(5);

  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Context Menu & Renaming State
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, item: AssetTreeNode } | null>(null);
  const [renamingItem, setRenamingItem] = useState<ProjectAsset | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const fetchWithAuth = useCallback(async (url: string, options: any = {}) => {
    const token = localStorage.getItem('cascata_token');
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Error ${response.status}`);
    }
    return response.json();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [assetsData, functionsData, triggersData, projects] = await Promise.all([
        fetchWithAuth(`/api/data/${projectId}/assets`),
        fetchWithAuth(`/api/data/${projectId}/functions`),
        fetchWithAuth(`/api/data/${projectId}/triggers`),
        fetchWithAuth(`/api/control/projects`)
      ]);
      setAssets(assetsData);
      setDbObjects([...functionsData.map((f:any) => ({...f, type: 'rpc'})), ...triggersData.map((t:any) => ({...t, type: 'trigger'}))]);
      setProjectData(projects.find((p: any) => p.slug === projectId));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const hide = () => setContextMenu(null);
    window.addEventListener('click', hide);
    return () => window.removeEventListener('click', hide);
  }, [projectId]);

  const extractObjectName = (sql: string): string | null => {
    // Basic heuristic for SQL functions
    const match = sql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TRIGGER|VIEW|PROCEDURE)\s+(?:public\.)?(\w+)/i);
    return match ? match[1] : null;
  };

  const handleCreateAsset = async (name: string, type: AssetType, parentId: string | null = null) => {
    try {
      const newAsset = await fetchWithAuth(`/api/data/${projectId}/assets`, {
        method: 'POST',
        body: JSON.stringify({ name, type, parent_id: parentId })
      });
      setAssets([...assets, newAsset]);
      if (type !== 'folder') {
        setSelectedAsset(newAsset);
        // Default Templates
        if (type === 'edge_function') {
            setEditorSql(`// Edge Function: ${name}
// Environment: Node.js (Isolated)
// Available Globals: fetch, console, env (process.env)

// Your logic here (must return JSON serializable object)
const { method, body, query } = req;

if (method === 'POST') {
    return { 
        message: "Hello from Edge!", 
        received: body 
    };
}

return { status: "ready" };
`);
            setEnvVars({});
            setTimeoutSec(5);
        } else {
            setEditorSql('-- Write your SQL here...');
        }
        setNotes('');
      }
      setSuccessMsg(`${type.replace('_', ' ').toUpperCase()} initialized.`);
      setTimeout(() => setSuccessMsg(null), 2000);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSaveObject = async () => {
    if (!selectedAsset) return;
    setExecuting(true);
    try {
      // Logic for SQL based assets
      if (selectedAsset.type === 'rpc' || selectedAsset.type === 'trigger') {
          await fetchWithAuth(`/api/data/${projectId}/query`, {
            method: 'POST',
            body: JSON.stringify({ sql: editorSql })
          });
      }
      
      const detectedName = selectedAsset.type === 'edge_function' ? selectedAsset.name : (extractObjectName(editorSql) || selectedAsset.name);
      
      const updated = await fetchWithAuth(`/api/data/${projectId}/assets`, {
        method: 'POST',
        body: JSON.stringify({ 
          ...selectedAsset,
          name: detectedName,
          metadata: { 
              ...selectedAsset.metadata, 
              notes, 
              sql: editorSql, // For Edge Functions, 'sql' stores the JS code
              env_vars: selectedAsset.type === 'edge_function' ? envVars : undefined,
              timeout: selectedAsset.type === 'edge_function' ? timeoutSec : undefined
          } 
        })
      });
      setAssets(assets.map(a => a.id === updated.id ? updated : a));
      setSelectedAsset(updated);
      setSuccessMsg(`Saved successfully as "${detectedName}"`);
      setTimeout(() => setSuccessMsg(null), 2000);
      fetchData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExecuting(false);
    }
  };

  const handleDeleteAsset = async (id: string) => {
    try {
      await fetchWithAuth(`/api/data/${projectId}/assets/${id}`, { method: 'DELETE' });
      setAssets(assets.filter(a => a.id !== id));
      if (selectedAsset?.id === id) setSelectedAsset(null);
      setSuccessMsg('Asset purged.');
      setTimeout(() => setSuccessMsg(null), 2000);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const executeTest = async () => {
    if (!selectedAsset) return;
    setExecuting(true);
    setTestResult(null);
    try {
      let params = {};
      try { params = JSON.parse(testParams); } catch(e) { }
      
      if (selectedAsset.type === 'edge_function') {
          // CALL EDGE ENDPOINT
          const result = await fetchWithAuth(`/api/data/${projectId}/edge/${selectedAsset.name}`, {
              method: 'POST',
              body: JSON.stringify(params)
          });
          setTestResult(result);
      } else {
          // SQL CALL
          const paramValues = Object.values(params);
          const argsString = paramValues.length > 0 
            ? paramValues.map(v => typeof v === 'string' ? `'${v}'` : v).join(', ') 
            : '';
          const sql = selectedAsset.type === 'rpc' 
            ? `SELECT * FROM public."${selectedAsset.name}"(${argsString})`
            : `-- Execution check for ${selectedAsset.type}`;
          const result = await fetchWithAuth(`/api/data/${projectId}/query`, {
            method: 'POST',
            body: JSON.stringify({ sql })
          });
          setTestResult(result);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExecuting(false);
    }
  };

  const copyCurl = () => {
    if (!selectedAsset || !projectData) return;
    const protocol = window.location.protocol;
    const typePath = selectedAsset.type === 'edge_function' ? 'edge' : 'rpc';
    
    const endpoint = projectData.custom_domain 
      ? `${protocol}//${projectData.custom_domain}/${typePath}/${selectedAsset.name}`
      : `${window.location.origin}/api/data/${projectId}/${typePath}/${selectedAsset.name}`;

    const curl = `curl -X POST ${endpoint} \\
  -H "Content-Type: application/json" \\
  -H "apikey: ${projectData.anon_key}" \\
  -d '${testParams}'`;
    navigator.clipboard.writeText(curl);
    setSuccessMsg('cURL copied');
    setTimeout(() => setSuccessMsg(null), 2000);
  };

  // --- ENV VARS LOGIC ---
  const addEnvVar = () => {
      if (!newEnvKey) return;
      setEnvVars({ ...envVars, [newEnvKey.toUpperCase()]: newEnvVal });
      setNewEnvKey('');
      setNewEnvVal('');
  };
  const removeEnvVar = (key: string) => {
      const next = { ...envVars };
      delete next[key];
      setEnvVars(next);
  };

  const filteredAssets = useMemo(() => {
    return assets.filter(a => a.type === 'folder' || a.type === activeContext);
  }, [assets, activeContext]);

  const treeData = useMemo(() => {
    const buildTree = (parentId: string | null = null): AssetTreeNode[] => {
      return filteredAssets
        .filter(a => a.parent_id === parentId)
        .map(a => ({
          ...a,
          children: a.type === 'folder' ? buildTree(a.id) : []
        }));
    };
    return buildTree(null);
  }, [filteredAssets]);

  const renderTreeItem = (item: AssetTreeNode) => {
    const isFolder = item.type === 'folder';
    const isExpanded = expandedFolders.has(item.id);
    const isSelected = selectedAsset?.id === item.id;

    return (
      <div key={item.id} className="select-none">
        <div 
          onClick={() => {
            if (isFolder) {
                const next = new Set(expandedFolders);
                if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                setExpandedFolders(next);
            }
            else {
              setSelectedAsset(item);
              setEditorSql(item.metadata?.sql || '');
              setNotes(item.metadata?.notes || '');
              setEnvVars(item.metadata?.env_vars || {});
              setTimeoutSec(item.metadata?.timeout || 5);
              setTestResult(null);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ x: e.clientX, y: e.clientY, item });
          }}
          className={`flex items-center gap-2 px-3 py-2.5 rounded-xl cursor-pointer transition-all group ${isSelected ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100' : 'text-slate-600 hover:bg-slate-50'}`}
        >
          {isFolder ? (
            <>
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Folder size={18} className={isSelected ? 'text-white' : 'text-slate-400'} />
            </>
          ) : (
            <FileCode size={18} className={isSelected ? 'text-white' : 'text-slate-400'} />
          )}
          <span className="text-sm font-bold truncate">{item.name}</span>
        </div>
        {isFolder && isExpanded && (
          <div className="pl-6 mt-1 space-y-1">
            {item.children.map(renderTreeItem)}
            <button 
              onClick={(e) => { e.stopPropagation(); handleCreateAsset('new_' + activeContext, activeContext, item.id); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest hover:text-indigo-600 transition-colors"
            >
              <Plus size={12} /> Add Asset
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-[#FDFDFD] overflow-hidden relative">
      {/* Context Menu & Renaming (Preserved Logic) */}
      {contextMenu && (
        <div 
          className="fixed z-[500] bg-white border border-slate-200 shadow-2xl rounded-2xl p-2 w-56 animate-in fade-in zoom-in-95" 
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => { setRenamingItem(contextMenu.item); setRenameValue(contextMenu.item.name); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Edit size={14}/> Rename</button>
          <button onClick={() => { handleDeleteAsset(contextMenu.item.id); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-xl transition-all"><Trash2 size={14}/> Delete</button>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-slate-200 px-10 py-6 bg-white flex items-center justify-between shadow-sm z-10">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-slate-900 text-white rounded-2xl shadow-xl"><Cpu size={24} /></div>
          <div><h2 className="text-2xl font-black text-slate-900 tracking-tighter leading-tight">Logic Engine</h2><p className="text-[10px] text-indigo-600 font-bold uppercase tracking-[0.2em]">Asset Orchestration</p></div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center bg-slate-100 p-1.5 rounded-2xl">
            <button onClick={() => { setActiveContext('rpc'); setSelectedAsset(null); }} className={`px-6 py-2.5 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeContext === 'rpc' ? 'bg-white shadow-lg text-indigo-600' : 'text-slate-500'}`}><Code2 size={16}/> RPC</button>
            <button onClick={() => { setActiveContext('trigger'); setSelectedAsset(null); }} className={`px-6 py-2.5 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeContext === 'trigger' ? 'bg-white shadow-lg text-indigo-600' : 'text-slate-500'}`}><Zap size={16}/> TRIGGERS</button>
            <button onClick={() => { setActiveContext('edge_function'); setSelectedAsset(null); }} className={`px-6 py-2.5 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeContext === 'edge_function' ? 'bg-white shadow-lg text-emerald-600' : 'text-slate-500'}`}><Globe size={16}/> EDGE FUNCTIONS</button>
          </div>
          <button onClick={() => handleCreateAsset('new_folder', 'folder')} className="p-3 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-2xl transition-all" title="New Folder"><FolderPlus size={24} /></button>
          <button onClick={() => handleCreateAsset('new_' + activeContext, activeContext)} className="bg-indigo-600 text-white px-6 py-3.5 rounded-2xl text-xs font-black flex items-center gap-3 hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100"><Plus size={20} /> NEW</button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-72 border-r border-slate-200 bg-white flex flex-col shrink-0">
          <div className="p-6">
            <div className="relative group"><Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors" size={16} /><input placeholder="Search logic registry..." className="w-full pl-12 pr-4 py-3.5 text-sm bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all" /></div>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-10 space-y-1">
            {treeData.map(renderTreeItem)}
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-hidden flex flex-col bg-[#F8FAFC]">
          {selectedAsset ? (
            <div className="flex-1 flex flex-col">
              {/* Toolbar */}
              <div className="bg-white border-b border-slate-200 px-8 py-4 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-4">
                  <div className="flex flex-col"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{selectedAsset.type.replace('_', ' ')}</span><span className="text-xl font-black text-slate-900 tracking-tight font-mono">{selectedAsset.name}</span></div>
                  {selectedAsset.type === 'rpc' && <div className="flex items-center gap-2 bg-emerald-50 px-3 py-1 rounded-full"><span className={`w-2 h-2 rounded-full ${dbObjects.some(o => o.name === selectedAsset.name) ? 'bg-emerald-500' : 'bg-slate-300'}`}></span><span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">DB SYNC</span></div>}
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={handleSaveObject} disabled={executing} className="bg-slate-900 text-white px-6 py-2.5 rounded-xl text-xs font-black flex items-center gap-2 hover:bg-indigo-600 transition-all shadow-lg disabled:opacity-50">{executing ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {selectedAsset.type === 'edge_function' ? 'DEPLOY TO EDGE' : 'COMPILE & SAVE'}</button>
                </div>
              </div>

              <div className="flex-1 flex overflow-hidden">
                <div className="flex-1 flex flex-col relative">
                  {/* Editor */}
                  <textarea 
                    value={editorSql} 
                    onChange={(e) => setEditorSql(e.target.value)}
                    className="flex-1 bg-[#0f172a] text-emerald-400 p-8 font-mono text-sm outline-none resize-none spellcheck-false" 
                    spellCheck="false"
                  />
                  
                  {/* Test & Env Panel */}
                  <div className="h-80 border-t border-slate-200 bg-white flex overflow-hidden shrink-0">
                    {/* Params / Env Config */}
                    <div className="w-1/2 border-r border-slate-200 flex flex-col">
                       <div className="flex border-b border-slate-100">
                          <button className="flex-1 py-3 text-[10px] font-black uppercase tracking-widest bg-slate-50 text-indigo-600 border-b-2 border-indigo-600">Test Payload</button>
                          {selectedAsset.type === 'edge_function' && <button className="flex-1 py-3 text-[10px] font-black uppercase tracking-widest text-slate-400 bg-white">Env Variables</button>}
                       </div>
                       
                       <div className="flex-1 p-6 overflow-auto">
                          {selectedAsset.type === 'edge_function' ? (
                              <div className="space-y-4">
                                  <div className="flex gap-2">
                                      <div className="flex-1">
                                          <label className="text-[9px] font-black text-slate-400 uppercase">Timeout (sec)</label>
                                          <input 
                                            type="number" 
                                            value={timeoutSec} 
                                            onChange={e => setTimeoutSec(parseInt(e.target.value))} 
                                            className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono font-bold outline-none" 
                                            min={1} 
                                            max={60} 
                                          />
                                      </div>
                                  </div>
                                  <div className="flex gap-2 border-t border-slate-100 pt-4">
                                      <input value={newEnvKey} onChange={e => setNewEnvKey(e.target.value)} placeholder="API_KEY" className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono font-bold outline-none uppercase" />
                                      <input value={newEnvVal} onChange={e => setNewEnvVal(e.target.value)} placeholder="secret_value" className="flex-[2] bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono outline-none" type="password" />
                                      <button onClick={addEnvVar} className="bg-indigo-600 text-white p-2 rounded-lg"><Plus size={14}/></button>
                                  </div>
                                  <div className="space-y-2">
                                      {Object.entries(envVars).map(([k, v]) => (
                                          <div key={k} className="flex items-center justify-between bg-slate-50 p-2 rounded-lg border border-slate-100">
                                              <div className="flex items-center gap-2"><Key size={10} className="text-slate-400"/><span className="text-xs font-mono font-bold text-slate-700">{k}</span></div>
                                              <button onClick={() => removeEnvVar(k)} className="text-rose-400 hover:text-rose-600"><X size={12}/></button>
                                          </div>
                                      ))}
                                  </div>
                              </div>
                          ) : (
                              <textarea 
                                value={testParams} 
                                onChange={(e) => setTestParams(e.target.value)}
                                className="w-full h-full bg-slate-50 border-none rounded-xl p-4 font-mono text-xs outline-none resize-none" 
                                placeholder='{ "arg1": "value" }'
                              />
                          )}
                       </div>
                    </div>

                    {/* Output */}
                    <div className="w-1/2 flex flex-col p-6 bg-slate-50">
                        <div className="flex justify-between items-center mb-4">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Execution Result</span>
                            <div className="flex gap-2">
                                <button onClick={copyCurl} className="p-2 bg-white rounded-lg text-slate-400 hover:text-indigo-600 shadow-sm transition-all"><Copy size={14}/></button>
                                <button onClick={executeTest} disabled={executing} className="bg-emerald-500 text-white px-4 py-2 rounded-lg text-[10px] font-black uppercase flex items-center gap-2 hover:bg-emerald-600 shadow-lg shadow-emerald-200 transition-all">{executing ? <Loader2 size={12} className="animate-spin"/> : <Play size={12}/>} Run</button>
                            </div>
                        </div>
                        <div className="flex-1 bg-slate-900 rounded-2xl p-4 overflow-auto border border-slate-800 shadow-inner">
                            {testResult ? <pre className="text-xs font-mono text-emerald-400 whitespace-pre-wrap">{JSON.stringify(testResult, null, 2)}</pre> : <div className="h-full flex items-center justify-center text-slate-700 opacity-50"><Terminal size={32}/></div>}
                        </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-300 p-20 text-center relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/5 to-transparent pointer-events-none"></div>
                <div className="w-36 h-36 bg-white rounded-[3.5rem] flex items-center justify-center text-indigo-600 mb-10 shadow-2xl border border-slate-100"><Cpu size={72} /></div>
                <h3 className="text-4xl font-black text-slate-900 tracking-tighter">Logic Workspace</h3>
                <p className="text-slate-400 mt-6 max-w-sm font-medium leading-relaxed">Select an asset to begin orchestration.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default RPCManager;
