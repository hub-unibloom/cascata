
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Shield, Lock, Unlock, Plus, Trash2, Edit2, AlertCircle, Loader2, X, 
  Terminal, CheckCircle2, Zap, User, Users, Globe, Eye, Code, 
  ChevronDown, ChevronRight, Copy, Siren, Activity, ShieldAlert,
  ServerCrash, Gauge, MousePointer2, ShieldCheck, EyeOff, AlertTriangle,
  RefreshCw, Circle, Download, Settings2, Calendar, Globe2, Cloud, Database, Box,
  Cpu, ArrowRight
} from 'lucide-react';

// --- RLS TAB IMPLEMENTATION ---
const RLSTab: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [tables, setTables] = useState<any[]>([]);
  const [policies, setPolicies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSecurityData = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('cascata_token');
      const headers = { 'Authorization': `Bearer ${token}` };
      
      // Fetch tables with RLS status via SQL query
      const tablesQuery = `
        SELECT relname as name, relrowsecurity as rls_enabled 
        FROM pg_class 
        JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace 
        WHERE nspname = 'public' AND relkind = 'r' AND relname NOT LIKE '_deleted_%'
        ORDER BY relname;
      `;
      
      const [tablesRes, policiesRes] = await Promise.all([
        fetch(`/api/data/${projectId}/query`, { 
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql: tablesQuery })
        }),
        fetch(`/api/data/${projectId}/policies`, { headers })
      ]);
      
      const tablesData = await tablesRes.json();
      const policiesData = await policiesRes.json();
      
      setTables(tablesData.rows || []);
      setPolicies(policiesData);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchSecurityData(); }, [projectId]);

  const toggleRLS = async (tableName: string, enable: boolean) => {
      const sql = `ALTER TABLE public."${tableName}" ${enable ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`;
      try {
        await fetch(`/api/data/${projectId}/query`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ sql })
        });
        fetchSecurityData();
      } catch (e) { alert("Failed to update RLS settings"); }
  };

  const deletePolicy = async (table: string, name: string) => {
      if(!confirm("Are you sure you want to delete this policy?")) return;
      try {
          await fetch(`/api/data/${projectId}/policies/${table}/${name}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          fetchSecurityData();
      } catch(e) { alert("Failed to delete policy"); }
  };

  if (loading) return <div className="p-20 flex justify-center"><Loader2 className="animate-spin text-indigo-600" /></div>;

  return (
    <div className="p-10 max-w-6xl mx-auto space-y-8 pb-40">
        <div className="flex items-center justify-between">
            <h3 className="text-xl font-black text-slate-900 flex items-center gap-3">
                <ShieldCheck size={24} className="text-emerald-500" />
                Table Security Policies
            </h3>
            <button onClick={fetchSecurityData} className="p-2 text-slate-400 hover:text-indigo-600 rounded-lg hover:bg-slate-50 transition-all">
                <RefreshCw size={20} />
            </button>
        </div>

        <div className="space-y-6">
            {tables.map(table => {
                const tablePolicies = policies.filter(p => p.tablename === table.name);
                
                return (
                    <div key={table.name} className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm transition-all hover:shadow-md">
                        <div className="flex items-center justify-between mb-8">
                            <div className="flex items-center gap-6">
                                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${table.rls_enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
                                    <Database size={24} />
                                </div>
                                <div>
                                    <h4 className="text-xl font-black text-slate-900 tracking-tight">{table.name}</h4>
                                    <div className="flex items-center gap-3 mt-1">
                                        <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded ${table.rls_enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                                            {table.rls_enabled ? 'RLS ENABLED' : 'RLS DISABLED'}
                                        </span>
                                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{tablePolicies.length} Policies</span>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-4">
                                <button 
                                    onClick={() => toggleRLS(table.name, !table.rls_enabled)}
                                    className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${table.rls_enabled ? 'bg-rose-50 text-rose-600 hover:bg-rose-100' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}
                                >
                                    {table.rls_enabled ? 'Disable Security' : 'Enable Security'}
                                </button>
                                <button 
                                    onClick={() => window.location.hash = `#/project/${projectId}/rls-editor/table/${table.name}`}
                                    className="bg-indigo-600 text-white px-5 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all flex items-center gap-2 shadow-lg shadow-indigo-100"
                                >
                                    <Plus size={14} /> New Policy
                                </button>
                            </div>
                        </div>

                        <div className="space-y-3">
                            {tablePolicies.length === 0 && (
                                <div className="p-6 bg-slate-50 rounded-2xl text-center border border-slate-100 border-dashed">
                                    <p className="text-xs font-bold text-slate-400">No policies defined. {table.rls_enabled ? 'Table is completely locked (Deny All).' : 'Table is completely open (Allow All).'}</p>
                                </div>
                            )}
                            {tablePolicies.map((p: any) => (
                                <div key={p.policyname} className="flex items-center justify-between p-5 bg-slate-50 border border-slate-100 rounded-2xl group hover:bg-white hover:shadow-sm transition-all">
                                    <div className="flex items-center gap-4">
                                        <div className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest ${p.cmd === 'SELECT' ? 'bg-blue-100 text-blue-700' : p.cmd === 'INSERT' ? 'bg-emerald-100 text-emerald-700' : p.cmd === 'UPDATE' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>
                                            {p.cmd === 'ALL' ? '*' : p.cmd}
                                        </div>
                                        <span className="text-sm font-bold text-slate-700">{p.policyname}</span>
                                        <span className="text-[10px] text-slate-400 font-mono bg-white px-2 py-1 rounded border border-slate-100">TO: {p.roles.join(', ')}</span>
                                    </div>
                                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button onClick={() => deletePolicy(table.name, p.policyname)} className="p-2 text-slate-300 hover:text-rose-600 transition-colors bg-white rounded-lg shadow-sm"><Trash2 size={16}/></button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )
            })}
            
            {tables.length === 0 && !loading && (
                <div className="text-center py-20 text-slate-400 font-bold text-sm uppercase tracking-widest">No public tables found</div>
            )}
        </div>
    </div>
  );
};

// --- LOGS OBSERVABILITY TAB (FULL FEATURES RESTORED) ---
const LogsTab: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [logs, setLogs] = useState<any[]>([]);
  const [project, setProject] = useState<any>(null);
  const [currentUserIp, setCurrentUserIp] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedLog, setSelectedLog] = useState<any>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'firewall'>('general');
  const [hideInternal, setHideInternal] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('cascata_token');
      // Adding x-cascata-client to ensure own traffic is marked internal by backend
      const headers = { 'Authorization': `Bearer ${token}`, 'x-cascata-client': 'dashboard' };
      
      const [logsRes, projectsRes, ipRes] = await Promise.all([
        fetch(`/api/data/${projectId}/logs`, { headers }),
        fetch('/api/control/projects', { headers }),
        fetch('/api/control/me/ip', { headers })
      ]);
      
      const logsData = await logsRes.json();
      const projectsData = await projectsRes.json();
      const ipData = await ipRes.json();
      
      setLogs(Array.isArray(logsData) ? logsData : []);
      setProject(projectsData.find((p: any) => p.slug === projectId));
      setCurrentUserIp(ipData.ip);
    } catch (err) {
      console.error('Telemetria offline');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleBlockIp = async (ip: string, isInternal: boolean) => {
    if (isInternal) {
      alert("PROTECTION ENGAGED: Cannot block Cascata internal infrastructure.");
      return;
    }
    if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('172.') || ip.startsWith('10.') || ip.startsWith('192.168.')) {
        alert("PROTECTION ENGAGED: Cannot block local/private network ranges.");
        return;
    }
    if (ip === currentUserIp) {
      if (!confirm(`⚠️ CRITICAL WARNING: This IP (${ip}) matches your current session.\nBlocking it will lock you out of the Data API.\nAre you sure?`)) return;
    } else {
      if (!confirm(`Confirm firewall ban for ${ip}?`)) return;
    }

    setExecuting(true);
    try {
      const response = await fetch(`/api/control/projects/${projectId}/block-ip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
        body: JSON.stringify({ ip })
      });
      if (response.ok) {
        setSuccess(`IP ${ip} bloqueado.`);
        fetchData();
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch (e) { setError("Erro ao bloquear IP."); setTimeout(() => setError(null), 3000); } 
    finally { setExecuting(false); }
  };

  const handleUnblockIp = async (ip: string) => {
      setExecuting(true);
      try {
          const res = await fetch(`/api/control/projects/${projectId}/blocklist/${ip}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          if (res.ok) { setSuccess(`${ip} removido da blocklist.`); fetchData(); }
      } catch (e) { setError("Erro ao desbloquear."); }
      finally { setExecuting(false); }
  };

  const toggleAutoBlock = async () => {
      const current = project?.metadata?.security?.auto_block_401 || false;
      try {
          const newMetadata = { ...(project?.metadata || {}), security: { ...(project?.metadata?.security || {}), auto_block_401: !current } };
          await fetch(`/api/control/projects/${projectId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ metadata: newMetadata })
          });
          setProject({...project, metadata: newMetadata});
          setSuccess(!current ? "Auto-Block Enabled" : "Auto-Block Disabled");
          setTimeout(() => setSuccess(null), 2000);
      } catch (e) { setError("Failed to update security settings"); }
  };

  const handleClearLogs = async (days: number) => {
    if (!confirm(`Confirma a exclusão de logs ANTIGOS (anteriores a ${days} dias atrás)?`)) return;
    setExecuting(true);
    try {
      await fetch(`/api/control/projects/${projectId}/logs?days=${days}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      setSuccess(`Limpeza concluída.`);
      fetchData();
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) { alert("Erro na limpeza"); } 
    finally { setExecuting(false); }
  };

  const updateRetention = async (days: number) => {
      setProject({ ...project, log_retention_days: days });
      try {
          await fetch(`/api/control/projects/${projectId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
            body: JSON.stringify({ log_retention_days: days })
          });
      } catch (e) { fetchData(); }
  };

  const handleExportLogs = () => {
    const dataStr = JSON.stringify(logs, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `logs_${projectId}_${new Date().toISOString()}.json`;
    link.click();
  };

  const filteredLogs = hideInternal ? logs.filter(l => !l.geo_info?.is_internal) : logs;

  const getActionBadge = (log: any) => {
      const action = log.geo_info?.semantic_action;
      if (action) {
          if (action.includes('DROP') || action.includes('DELETE')) return <span className="bg-rose-100 text-rose-700 px-2 py-0.5 rounded text-[9px] font-black">{action.replace('_', ' ')}</span>;
          if (action.includes('CREATE') || action.includes('INSERT')) return <span className="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded text-[9px] font-black">{action.replace('_', ' ')}</span>;
          if (action.includes('AUTH')) return <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded text-[9px] font-black">{action.replace('_', ' ')}</span>;
          return <span className="bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded text-[9px] font-black">{action.replace('_', ' ')}</span>;
      }
      return <span className={`px-2 py-1 rounded-lg text-[9px] font-black uppercase ${log.method === 'GET' ? 'bg-emerald-50 text-emerald-600' : 'bg-indigo-50 text-indigo-600'}`}>{log.method}</span>;
  };

  return (
    <div className="flex h-full flex-col relative overflow-hidden">
      {/* Notifications */}
      {success && <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[600] bg-indigo-600 text-white px-8 py-4 rounded-[2rem] shadow-2xl animate-bounce flex items-center gap-3"><CheckCircle2 size={18} /><span className="text-xs font-black uppercase tracking-widest">{success}</span></div>}
      {error && <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[600] bg-rose-600 text-white px-8 py-4 rounded-[2rem] shadow-2xl animate-pulse flex items-center gap-3"><AlertTriangle size={18} /><span className="text-xs font-black uppercase tracking-widest">{error}</span></div>}

      <div className="px-10 py-6 flex items-center justify-between shrink-0 z-10">
        <h3 className="text-xl font-black text-slate-900 flex items-center gap-3"><Activity size={24} className="text-amber-500" /> Observability Hub</h3>
        <div className="flex items-center gap-4">
          <div className="flex items-center bg-white p-1.5 rounded-2xl shadow-sm border border-slate-100">
             <button onClick={() => setHideInternal(!hideInternal)} className={`p-3 transition-all rounded-xl flex items-center gap-2 text-[10px] font-black uppercase tracking-widest ${hideInternal ? 'text-slate-400' : 'bg-slate-100 text-indigo-600'}`}>
                {hideInternal ? <EyeOff size={18} /> : <Eye size={18} />} {hideInternal ? 'INTERNAL HIDDEN' : 'INTERNAL VISIBLE'}
             </button>
             <div className="w-[1px] h-6 bg-slate-200 mx-1"></div>
             <button onClick={() => fetchData()} className="p-3 text-slate-500 hover:text-indigo-600 transition-all"><RefreshCw size={20} className={loading ? 'animate-spin' : ''} /></button>
             <button onClick={handleExportLogs} className="p-3 text-slate-500 hover:text-indigo-600 transition-all"><Download size={20} /></button>
             <button onClick={() => setShowSettings(true)} className="p-3 text-slate-500 hover:text-indigo-600 transition-all"><Settings2 size={20} /></button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex px-10 pb-10">
        <main className="flex-1 overflow-y-auto rounded-[3rem] bg-white border border-slate-200 shadow-sm relative">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-white z-10">
                <tr className="border-b border-slate-100">
                  <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Snapshot</th>
                  <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Action</th>
                  <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Identity</th>
                  <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Status</th>
                  <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Latency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filteredLogs.length === 0 && !loading ? (
                  <tr><td colSpan={5} className="py-40 text-center"><Terminal size={64} className="mx-auto text-slate-100 mb-6" /><p className="text-sm font-black text-slate-300 uppercase tracking-widest">Awaiting first request...</p></td></tr>
                ) : filteredLogs.map((log) => {
                  const isInternal = log.geo_info?.is_internal;
                  const isAuthFail = log.status_code === 401 || log.status_code === 403;
                  const isError = log.status_code >= 400;
                  return (
                    <tr key={log.id} onClick={() => setSelectedLog(log)} className={`transition-all cursor-pointer group ${selectedLog?.id === log.id ? 'bg-indigo-50' : 'hover:bg-indigo-50/30'} ${isInternal ? 'opacity-60 grayscale' : ''} ${isAuthFail ? 'bg-rose-50/50 hover:bg-rose-100/50' : ''}`}>
                      <td className="px-8 py-5"><div className="flex flex-col"><span className={`text-xs font-bold ${isAuthFail ? 'text-rose-600' : 'text-slate-900'}`}>{new Date(log.created_at).toLocaleTimeString()}</span><span className="text-[9px] font-black text-slate-400 uppercase tracking-tight">{new Date(log.created_at).toLocaleDateString()}</span></div></td>
                      <td className="px-8 py-5"><div className="flex items-center gap-3">{getActionBadge(log)}<div className="flex flex-col"><code className={`text-sm font-mono font-bold truncate max-w-[200px] ${isAuthFail ? 'text-rose-700' : 'text-slate-600'}`}>{log.path}</code>{isInternal && <span className="text-[8px] font-black text-indigo-400 uppercase tracking-widest flex items-center gap-1"><ShieldCheck size={8} /> INTERNAL</span>}</div></div></td>
                      <td className="px-8 py-5 text-center"><span className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full border ${isAuthFail ? 'bg-rose-100 text-rose-700 border-rose-200' : 'bg-slate-50 text-slate-400 border-slate-100'}`}>{log.user_role}</span></td>
                      <td className="px-8 py-5 text-center"><div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border ${isError ? 'bg-rose-50 text-rose-600 border-rose-100' : 'bg-emerald-50 text-emerald-600 border-emerald-100'}`}>{isError ? <AlertCircle size={10} /> : <Circle size={8} className="fill-emerald-500" />}<span className="font-black text-xs">{log.status_code}</span></div></td>
                      <td className="px-8 py-5 text-right"><span className={`text-xs font-mono font-black ${log.duration_ms > 100 ? 'text-amber-500' : 'text-emerald-500'}`}>{log.duration_ms}ms</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        </main>

        {/* LOG DETAILS DRAWER */}
        {selectedLog && (
          <aside className="w-[500px] bg-white border border-slate-200 rounded-[3rem] ml-6 overflow-y-auto animate-in slide-in-from-right duration-300 flex flex-col shadow-2xl relative z-20">
            <header className="p-10 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-4">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-white ${selectedLog.status_code >= 400 ? 'bg-rose-600' : 'bg-emerald-600'}`}><Activity size={24} /></div>
                <div><h3 className="text-xl font-black text-slate-900 tracking-tight">Request DNA</h3><p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">ID: {selectedLog.id.slice(0, 8)}...</p></div>
              </div>
              <button onClick={() => setSelectedLog(null)} className="p-3 hover:bg-slate-200 rounded-full transition-all text-slate-400"><X size={24}/></button>
            </header>
            <div className="p-10 space-y-10">
              <div className={`rounded-[2.5rem] p-8 text-white relative overflow-hidden group ${selectedLog.geo_info?.is_internal ? 'bg-slate-900' : (selectedLog.client_ip === currentUserIp ? 'bg-slate-950' : (selectedLog.status_code >= 400 ? 'bg-rose-900 shadow-[0_20px_40px_rgba(225,29,72,0.2)]' : 'bg-rose-600'))}`}>
                <ShieldAlert className="absolute -bottom-4 -right-4 w-32 h-32 opacity-10 group-hover:scale-125 transition-transform" />
                <h4 className="font-black uppercase text-xs tracking-widest mb-1">Source Governance</h4>
                <p className="text-[10px] font-medium opacity-80 mb-6 flex items-center gap-2">IP: {selectedLog.client_ip} {selectedLog.client_ip === currentUserIp && <span className="bg-white/20 px-2 py-0.5 rounded-lg border border-white/10 font-bold uppercase tracking-wider text-[8px]">(Current Session)</span>}</p>
                <button onClick={() => handleBlockIp(selectedLog.client_ip, selectedLog.geo_info?.is_internal)} disabled={project?.blocklist?.includes(selectedLog.client_ip) || selectedLog.geo_info?.is_internal} className="w-full bg-white text-slate-900 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-3 shadow-2xl hover:bg-slate-50 transition-all active:scale-95 disabled:opacity-50">
                  {selectedLog.geo_info?.is_internal ? <><Lock size={14}/> IP INTERNO PROTEGIDO</> : project?.blocklist?.includes(selectedLog.client_ip) ? <><Lock size={14}/> IP JÁ BLOQUEADO</> : <><ShieldAlert size={14} className="text-rose-600"/> BLOQUEAR ORIGEM</>}
                </button>
              </div>
              <div className="space-y-8">
                <DetailSection icon={<Globe2 size={16}/>} label="Security Context"><div className="grid grid-cols-2 gap-4"><InfoBox label="Auth Result" value={selectedLog.status_code >= 400 ? 'DENIED' : 'GRANTED'} /><InfoBox label="Resolved Role" value={selectedLog.user_role || 'NONE'} /></div></DetailSection>
                <DetailSection icon={<Globe2 size={16}/>} label="Origin Insights"><div className="grid grid-cols-2 gap-4"><InfoBox label="Client IP" value={selectedLog.client_ip} /><InfoBox label="Latency" value={`${selectedLog.duration_ms}ms`} /></div></DetailSection>
                <DetailSection icon={<Code size={16}/>} label="Request Payload"><pre className="bg-slate-950 text-emerald-400 p-6 rounded-[2rem] font-mono text-[11px] overflow-auto max-h-60 shadow-inner">{JSON.stringify(selectedLog.payload, null, 2)}</pre></DetailSection>
                <DetailSection icon={<Lock size={16}/>} label="System Headers"><pre className="bg-slate-50 border border-slate-100 p-6 rounded-[2rem] font-mono text-[11px] text-slate-600 overflow-auto">{JSON.stringify(selectedLog.headers, null, 2)}</pre></DetailSection>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* SETTINGS MODAL */}
      {showSettings && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-2xl z-[500] flex items-center justify-center p-8 animate-in fade-in duration-300">
           <div className="bg-white rounded-[4rem] w-full max-w-2xl p-12 shadow-2xl border border-slate-200 animate-in zoom-in-95 max-h-[90vh] overflow-y-auto">
              <header className="flex items-center justify-between mb-8">
                 <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><Settings2 size={24} /></div>
                    <div>
                        <h3 className="text-3xl font-black text-slate-900 tracking-tighter">Governance</h3>
                        <div className="flex gap-4 mt-2">
                            <button onClick={() => setSettingsTab('general')} className={`text-[10px] font-black uppercase tracking-widest ${settingsTab === 'general' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-400'}`}>General</button>
                            <button onClick={() => setSettingsTab('firewall')} className={`text-[10px] font-black uppercase tracking-widest ${settingsTab === 'firewall' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-400'}`}>Firewall Rules</button>
                        </div>
                    </div>
                 </div>
                 <button onClick={() => setShowSettings(false)} className="text-slate-300 hover:text-slate-900 transition-colors"><X size={32}/></button>
              </header>
              {settingsTab === 'general' && (
                  <div className="space-y-12">
                     <div className="bg-slate-50 border border-slate-200 p-6 rounded-[2.5rem] flex items-center justify-between"><div className="flex items-center gap-4"><div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-sm text-indigo-600"><Zap size={20}/></div><div><h4 className="text-sm font-black text-slate-900">Auto-Ban Suspicious Origins</h4><p className="text-[10px] text-slate-500 font-bold mt-1">Automatically add IP to firewall if 401 Unauthorized occurs.</p></div></div><button onClick={toggleAutoBlock} className={`w-16 h-8 rounded-full p-1 transition-colors ${project?.metadata?.security?.auto_block_401 ? 'bg-indigo-600' : 'bg-slate-200'}`}><div className={`w-6 h-6 bg-white rounded-full shadow-md transition-transform ${project?.metadata?.security?.auto_block_401 ? 'translate-x-8' : ''}`}></div></button></div>
                     <div className="space-y-4"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Manual Purge Controls (Apagar Antes de...)</label><div className="grid grid-cols-3 gap-3">{[3, 7, 15, 30, 60, 90].map(days => (<button key={days} onClick={() => handleClearLogs(days)} className="py-4 border border-slate-100 rounded-2xl text-[10px] font-black uppercase tracking-widest text-slate-500 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition-all flex flex-col items-center gap-1 group"><Trash2 size={14} className="group-hover:animate-bounce" />{days} Dias Atrás</button>))}</div></div>
                     <div className="p-8 bg-slate-50 border border-slate-100 rounded-[2.5rem] space-y-4"><div className="flex items-center justify-between"><div className="flex items-center gap-3"><Calendar size={18} className="text-indigo-600" /><span className="text-sm font-bold text-slate-800">Retention Strategy</span></div><select value={project?.log_retention_days || 30} onChange={(e) => updateRetention(parseInt(e.target.value))} className="bg-white border-none rounded-xl px-4 py-2 text-xs font-black text-indigo-600 outline-none shadow-sm cursor-pointer"><option value="7">7 Dias</option><option value="30">30 Dias</option><option value="90">90 Dias</option><option value="365">1 Ano</option></select></div></div>
                  </div>
              )}
              {settingsTab === 'firewall' && (
                  <div className="space-y-6">
                      <div className="bg-rose-50 border border-rose-100 p-6 rounded-[2.5rem]"><h4 className="text-rose-700 font-black text-sm mb-2 flex items-center gap-2"><ShieldAlert size={16}/> Active Blocklist</h4><p className="text-[10px] text-rose-500 font-medium">IPs listed here are completely blocked from accessing the API.</p></div>
                      <div className="space-y-2">{project?.blocklist?.length === 0 && <p className="text-center text-slate-400 text-xs py-8">Nenhum IP bloqueado.</p>}{project?.blocklist?.map((ip: string) => (<div key={ip} className="flex items-center justify-between bg-white border border-slate-200 p-4 rounded-2xl"><span className="text-xs font-mono font-bold text-slate-700">{ip}</span><button onClick={() => handleUnblockIp(ip)} className="text-[10px] font-black bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-xl hover:bg-emerald-200 transition-colors">DESBLOQUEAR</button></div>))}</div>
                  </div>
              )}
           </div>
        </div>
      )}
    </div>
  );
};

const RLSManager: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [activeTab, setActiveTab] = useState<'rls' | 'hard_security' | 'logs'>('rls');

  return (
    <div className="flex flex-col h-full bg-[#F8FAFC] overflow-hidden">
      <header className="px-10 py-8 bg-white border-b border-slate-200 flex items-center justify-between shadow-sm z-10">
        <div className="flex items-center gap-6">
          <div className="w-16 h-16 bg-slate-900 text-white rounded-[1.8rem] flex items-center justify-center shadow-2xl shadow-slate-200">
            <Shield size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tighter leading-none">Security Center</h1>
            <p className="text-slate-400 font-bold uppercase tracking-widest text-[10px] mt-2">Access & Traffic Control</p>
          </div>
        </div>
        
        <div className="flex bg-slate-100 p-1.5 rounded-2xl">
           <button onClick={() => setActiveTab('rls')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${activeTab === 'rls' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}><Code size={14}/> Row Level Security</button>
           <button onClick={() => setActiveTab('hard_security')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${activeTab === 'hard_security' ? 'bg-white shadow-md text-rose-600' : 'text-slate-400 hover:text-slate-600'}`}><Siren size={14}/> Hard Security</button>
           <button onClick={() => setActiveTab('logs')} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${activeTab === 'logs' ? 'bg-white shadow-md text-amber-600' : 'text-slate-400 hover:text-slate-600'}`}><Activity size={14}/> Logs Observability</button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
         {activeTab === 'rls' ? (
            <RLSTab projectId={projectId} />
         ) : activeTab === 'hard_security' ? (
            <HardSecurityTab projectId={projectId} />
         ) : (
            <LogsTab projectId={projectId} />
         )}
      </div>
    </div>
  );
};

// --- SMART RULE MODAL & HARD SECURITY ---
const HardSecurityTab: React.FC<{ projectId: string }> = ({ projectId }) => {
    const [limits, setLimits] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState({ current_rps: 0, panic_mode: false });
    
    // SMART MODAL STATE
    const [showSmartModal, setShowSmartModal] = useState(false);
    const [targetType, setTargetType] = useState<'global' | 'table' | 'rpc' | 'auth'>('global');
    const [targetEntity, setTargetEntity] = useState('');
    const [availableTables, setAvailableTables] = useState<string[]>([]);
    const [availableRPCs, setAvailableRPCs] = useState<string[]>([]);
    const [preset, setPreset] = useState<'strict' | 'normal' | 'high' | 'custom'>('normal');
    
    // CUSTOM PARAMS (Used if preset === custom)
    const [customRate, setCustomRate] = useState(10);
    const [customWindow, setCustomWindow] = useState(1);
    const [customBurst, setCustomBurst] = useState(5);
    const [messageAnon, setMessageAnon] = useState('');
    const [messageAuth, setMessageAuth] = useState('');

    const [executing, setExecuting] = useState(false);

    // Initial Fetch
    const fetchData = async () => {
        setLoading(true);
        try {
            const [limitsRes, statusRes] = await Promise.all([
                fetch(`/api/data/${projectId}/rate-limits`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } }),
                fetch(`/api/data/${projectId}/security/status`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } })
            ]);
            setLimits(await limitsRes.json());
            setStatus(await statusRes.json());
        } catch (e) { console.error("Error fetching security data"); }
        finally { setLoading(false); }
    };

    // Populate Dropdowns on Open
    useEffect(() => {
        if (showSmartModal && (targetType === 'table' || targetType === 'rpc')) {
            const loadEntities = async () => {
                const headers = { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` };
                const [tblRes, fnRes] = await Promise.all([
                    fetch(`/api/data/${projectId}/tables`, { headers }),
                    fetch(`/api/data/${projectId}/functions`, { headers })
                ]);
                const tblData = await tblRes.json();
                const fnData = await fnRes.json();
                setAvailableTables(tblData.map((t: any) => t.name));
                setAvailableRPCs(fnData.map((f: any) => f.name));
            };
            loadEntities();
        }
    }, [showSmartModal, targetType]);

    // Polling Status
    useEffect(() => { 
        fetchData(); 
        const interval = setInterval(async () => {
            try {
                const res = await fetch(`/api/data/${projectId}/security/status`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
                const data = await res.json();
                setStatus(prev => ({ ...prev, current_rps: data.current_rps, panic_mode: data.panic_mode })); 
            } catch(e) {}
        }, 2000);
        return () => clearInterval(interval);
    }, [projectId]);

    const handleDeploySmartRule = async () => {
        let routePattern = '*';
        let method = 'ALL';

        // 1. Determine Route Pattern
        if (targetType === 'global') routePattern = '*';
        else if (targetType === 'auth') routePattern = '/auth/*';
        else if (targetType === 'table') {
            if (!targetEntity) { alert("Select a table."); return; }
            routePattern = `/tables/${targetEntity}`;
        }
        else if (targetType === 'rpc') {
            if (!targetEntity) { alert("Select a function."); return; }
            routePattern = `/rpc/${targetEntity}`;
            method = 'POST';
        }

        // 2. Determine Limits from Preset
        let rate = 10, burst = 5, window = 1;
        if (preset === 'strict') { rate = 2; burst = 0; window = 1; } // Anti-scrape
        else if (preset === 'normal') { rate = 20; burst = 10; window = 1; }
        else if (preset === 'high') { rate = 100; burst = 50; window = 1; }
        else { rate = customRate; burst = customBurst; window = customWindow; }

        // 3. Conflict Check
        const conflict = limits.find(l => l.route_pattern === routePattern && l.method === method);
        if (conflict) {
            if (!confirm(`A rule for "${routePattern}" already exists. Overwrite?`)) return;
        }

        setExecuting(true);
        try {
            await fetch(`/api/data/${projectId}/rate-limits`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
                },
                body: JSON.stringify({
                    route_pattern: routePattern,
                    method,
                    rate_limit: rate,
                    burst_limit: burst,
                    window_seconds: window,
                    message_anon: messageAnon,
                    message_auth: messageAuth
                })
            });
            setShowSmartModal(false);
            fetchData();
        } catch (e) { alert("Failed to deploy rule."); }
        finally { setExecuting(false); }
    };

    const handleDeleteRule = async (id: string) => {
        if (!confirm("Remove protection?")) return;
        await fetch(`/api/data/${projectId}/rate-limits/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
        });
        fetchData();
    };

    const togglePanicMode = async () => {
        if (!confirm(status.panic_mode ? "DISABLE Panic Mode?" : "ENABLE Panic Mode? (Immediate Block)")) return;
        setExecuting(true);
        try {
            await fetch(`/api/data/${projectId}/security/panic`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                body: JSON.stringify({ enabled: !status.panic_mode })
            });
            setStatus(p => ({...p, panic_mode: !p.panic_mode}));
        } catch (e) { alert("Panic failed"); }
        finally { setExecuting(false); }
    };

    return (
        <div className="p-10 max-w-6xl mx-auto space-y-10 pb-40">
            {/* PANIC & STATUS DASHBOARD */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className={`rounded-[2.5rem] p-8 text-white relative overflow-hidden shadow-2xl transition-all ${status.panic_mode ? 'bg-rose-600' : 'bg-slate-900'}`}>
                    <div className="relative z-10">
                        <div className="flex items-center gap-3 mb-4">
                            <ShieldCheck size={20} className={status.panic_mode ? 'animate-bounce' : 'text-emerald-400'} />
                            <span className="text-[10px] font-black uppercase tracking-widest">{status.panic_mode ? 'SYSTEM LOCKDOWN' : 'ACTIVE PROTECTION'}</span>
                        </div>
                        <h3 className="text-3xl font-black tracking-tight">{status.panic_mode ? 'PANIC ON' : 'SECURE'}</h3>
                        <p className="text-xs opacity-70 mt-2 font-medium">
                            {status.panic_mode ? 'All external traffic blocked by Redis.' : `${limits.length} active traffic rules.`}
                        </p>
                    </div>
                    {status.panic_mode && <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-overlay"></div>}
                </div>

                <div className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
                    <div className="flex justify-between items-end mb-4">
                        <h4 className="text-slate-500 font-bold text-xs uppercase tracking-widest">Global Load</h4>
                        <span className="text-xs font-black text-indigo-600">{status.current_rps} RPS</span>
                    </div>
                    <div className="w-full bg-slate-100 h-4 rounded-full overflow-hidden relative">
                        <div className="h-full bg-indigo-600 transition-all duration-500 ease-out" style={{ width: `${Math.min((status.current_rps/50)*100, 100)}%` }}></div>
                    </div>
                </div>

                <button 
                    onClick={togglePanicMode}
                    disabled={executing}
                    className={`rounded-[2.5rem] p-8 flex flex-col justify-center items-center transition-all ${status.panic_mode ? 'bg-white border-4 border-rose-600 text-rose-600' : 'bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-100'}`}
                >
                    <Siren size={32} className={status.panic_mode ? 'animate-pulse' : ''} />
                    <span className="font-black text-sm uppercase tracking-widest mt-2">{status.panic_mode ? 'DISABLE PANIC' : 'ENABLE PANIC'}</span>
                </button>
            </div>

            {/* RULES LIST */}
            <div className="space-y-6">
                <div className="flex items-center justify-between">
                    <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3">
                        <Gauge size={20} className="text-indigo-600"/> Traffic Rules
                    </h3>
                    <button onClick={() => setShowSmartModal(true)} className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-black text-xs uppercase tracking-widest shadow-lg hover:bg-indigo-700 transition-all flex items-center gap-2">
                        <Plus size={16}/> New Rule
                    </button>
                </div>

                <div className="bg-white border border-slate-200 rounded-[3rem] shadow-sm overflow-hidden">
                    <table className="w-full text-left">
                        <thead className="bg-slate-50 border-b border-slate-100 text-[10px] font-black text-slate-400 uppercase tracking-widest">
                            <tr>
                                <th className="px-8 py-6">Resource</th>
                                <th className="px-8 py-6">Limit</th>
                                <th className="px-8 py-6">Window</th>
                                <th className="px-8 py-6 text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {limits.map(l => (
                                <tr key={l.id} className="group hover:bg-slate-50/50">
                                    <td className="px-8 py-6">
                                        <div className="flex items-center gap-3">
                                            {l.route_pattern === '*' ? <Globe size={16} className="text-indigo-500"/> : l.route_pattern.includes('/rpc/') ? <Zap size={16} className="text-amber-500"/> : <Database size={16} className="text-emerald-500"/>}
                                            <code className="text-xs font-bold text-slate-700 bg-slate-100 px-2 py-1 rounded">{l.route_pattern}</code>
                                        </div>
                                    </td>
                                    <td className="px-8 py-6 font-bold text-slate-900">{l.rate_limit} reqs (+{l.burst_limit} burst)</td>
                                    <td className="px-8 py-6 font-mono text-xs text-slate-500">{l.window_seconds}s</td>
                                    <td className="px-8 py-6 text-right"><button onClick={() => handleDeleteRule(l.id)} className="text-slate-300 hover:text-rose-600"><Trash2 size={16}/></button></td>
                                </tr>
                            ))}
                            {limits.length === 0 && <tr><td colSpan={4} className="py-10 text-center text-slate-400 font-bold text-xs uppercase">No active rules</td></tr>}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* SMART MODAL */}
            {showSmartModal && (
                <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
                    <div className="bg-white rounded-[3rem] w-full max-w-4xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
                        <header className="p-8 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><ShieldAlert size={24}/></div>
                                <div><h3 className="text-2xl font-black text-slate-900 tracking-tighter">Traffic Guard</h3><p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Intelligent Rate Limiter</p></div>
                            </div>
                            <button onClick={() => setShowSmartModal(false)} className="p-3 bg-white hover:bg-slate-100 rounded-full transition-all text-slate-400"><X size={20}/></button>
                        </header>

                        <div className="flex-1 overflow-y-auto p-10 grid grid-cols-1 lg:grid-cols-2 gap-12">
                            {/* LEFT: TARGET SELECTION */}
                            <div className="space-y-8">
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 block">1. What to Protect?</label>
                                    <div className="grid grid-cols-2 gap-3">
                                        {[
                                            { id: 'global', label: 'Global API', icon: Globe },
                                            { id: 'auth', label: 'Auth Routes', icon: Lock },
                                            { id: 'table', label: 'Specific Table', icon: Database },
                                            { id: 'rpc', label: 'RPC Function', icon: Zap },
                                        ].map(t => (
                                            <button key={t.id} onClick={() => { setTargetType(t.id as any); setTargetEntity(''); }} className={`p-4 rounded-2xl border text-left transition-all group ${targetType === t.id ? 'bg-indigo-600 border-indigo-600 text-white shadow-xl' : 'bg-white border-slate-200 hover:border-indigo-300'}`}>
                                                <t.icon size={20} className={`mb-2 ${targetType === t.id ? 'text-white' : 'text-slate-400 group-hover:text-indigo-500'}`} />
                                                <span className="text-xs font-black uppercase tracking-widest block">{t.label}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {(targetType === 'table' || targetType === 'rpc') && (
                                    <div className="animate-in fade-in slide-in-from-top-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Select {targetType === 'table' ? 'Table' : 'Function'}</label>
                                        <select 
                                            value={targetEntity} 
                                            onChange={(e) => setTargetEntity(e.target.value)}
                                            className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10"
                                        >
                                            <option value="">-- Choose Target --</option>
                                            {(targetType === 'table' ? availableTables : availableRPCs).map(name => (
                                                <option key={name} value={name}>{name}</option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>

                            {/* RIGHT: RULES */}
                            <div className="space-y-8 bg-slate-50 rounded-[2.5rem] p-8 border border-slate-100">
                                <div>
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 block">2. Security Level</label>
                                    <div className="flex bg-white p-1 rounded-2xl border border-slate-200 mb-6 shadow-sm">
                                        {['strict', 'normal', 'high', 'custom'].map(p => (
                                            <button key={p} onClick={() => setPreset(p as any)} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${preset === p ? 'bg-slate-900 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>
                                                {p}
                                            </button>
                                        ))}
                                    </div>

                                    {preset === 'custom' ? (
                                        <div className="grid grid-cols-3 gap-4">
                                            <div><label className="text-[9px] font-bold text-slate-400 uppercase">Rate</label><input type="number" value={customRate} onChange={e => setCustomRate(parseInt(e.target.value))} className="w-full p-3 rounded-xl border border-slate-200 font-bold text-center"/></div>
                                            <div><label className="text-[9px] font-bold text-slate-400 uppercase">Burst</label><input type="number" value={customBurst} onChange={e => setCustomBurst(parseInt(e.target.value))} className="w-full p-3 rounded-xl border border-slate-200 font-bold text-center"/></div>
                                            <div><label className="text-[9px] font-bold text-slate-400 uppercase">Seconds</label><input type="number" value={customWindow} onChange={e => setCustomWindow(parseInt(e.target.value))} className="w-full p-3 rounded-xl border border-slate-200 font-bold text-center"/></div>
                                        </div>
                                    ) : (
                                        <div className="p-4 bg-white rounded-2xl border border-slate-200 flex justify-between items-center">
                                            <span className="text-xs font-bold text-slate-600">{preset === 'strict' ? 'Anti-Scrape (2/s)' : preset === 'normal' ? 'Standard User (20/s)' : 'High Throughput (100/s)'}</span>
                                            <Activity size={16} className="text-indigo-500" />
                                        </div>
                                    )}
                                </div>

                                <div className="space-y-3 pt-4 border-t border-slate-200">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Custom Rejection Messages (Optional)</label>
                                    <input value={messageAnon} onChange={e => setMessageAnon(e.target.value)} placeholder="Message for Anonymous Users..." className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-medium outline-none" />
                                    <input value={messageAuth} onChange={e => setMessageAuth(e.target.value)} placeholder="Message for Logged Users..." className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-medium outline-none" />
                                </div>
                            </div>
                        </div>

                        <footer className="p-8 border-t border-slate-100 bg-white flex justify-end gap-4">
                            <button onClick={() => setShowSmartModal(false)} className="px-8 py-4 rounded-2xl text-xs font-black text-slate-400 uppercase tracking-widest hover:bg-slate-50">Cancel</button>
                            <button onClick={handleDeploySmartRule} disabled={executing} className="px-10 py-4 bg-indigo-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-indigo-700 shadow-xl flex items-center gap-2">
                                {executing ? <Loader2 className="animate-spin" size={16}/> : 'Deploy Protection'}
                            </button>
                        </footer>
                    </div>
                </div>
            )}
        </div>
    );
};

const DetailSection: React.FC<{ icon: React.ReactNode, label: string, children: React.ReactNode }> = ({ icon, label, children }) => (
  <div className="space-y-4">
    <div className="flex items-center gap-3 text-slate-400">
      {icon}
      <span className="text-[10px] font-black uppercase tracking-widest">{label}</span>
    </div>
    {children}
  </div>
);

const InfoBox: React.FC<{ label: string, value: string }> = ({ label, value }) => (
  <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4 flex flex-col gap-1">
    <span className="text-[9px] font-black text-slate-400 uppercase tracking-tight">{label}</span>
    <span className="text-xs font-bold text-slate-900 font-mono truncate">{value}</span>
  </div>
);

export default RLSManager;
