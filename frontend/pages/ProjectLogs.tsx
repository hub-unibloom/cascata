
import React, { useState, useEffect, useCallback } from 'react';
import { 
  Activity, Terminal, Filter, RefreshCw, 
  ChevronRight, Circle, Clock, Database, Globe, Loader2,
  Search, ShieldAlert, Trash2, Download, X, Eye, 
  Settings2, Calendar, Lock, Globe2, Cpu, ArrowRight,
  CheckCircle2, Code, ShieldCheck, EyeOff, AlertTriangle, Zap, AlertCircle, Cloud,
  HardDrive
} from 'lucide-react';

const ProjectLogs: React.FC<{ projectId: string }> = ({ projectId }) => {
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
  
  // Cloud Backup State
  const [exportingCloud, setExportingCloud] = useState(false);

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

  // HELPER: Format Time using Project Timezone
  const formatTime = (isoString: string) => {
     const tz = project?.metadata?.timezone || 'UTC';
     try {
       return new Date(isoString).toLocaleTimeString(undefined, { timeZone: tz });
     } catch { return new Date(isoString).toLocaleTimeString(); }
  };

  const formatDate = (isoString: string) => {
     const tz = project?.metadata?.timezone || 'UTC';
     try {
       return new Date(isoString).toLocaleDateString(undefined, { timeZone: tz });
     } catch { return new Date(isoString).toLocaleDateString(); }
  };

  const formatBytes = (bytes: number) => {
      if (!bytes || bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const handleBlockIp = async (ip: string, isInternal: boolean) => {
    // 1. Safety Checks
    if (isInternal) {
      alert("PROTECTION ENGAGED: Cannot block Cascata internal infrastructure.");
      return;
    }

    if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('172.') || ip.startsWith('10.') || ip.startsWith('192.168.')) {
        alert("PROTECTION ENGAGED: Cannot block local/private network ranges.");
        return;
    }

    if (ip === currentUserIp) {
      if (!confirm(`⚠️ CRITICAL WARNING: This IP (${ip}) matches your current session.\n\nBlocking it will immediately lock you out of the Data API. The Control Panel might still work via proxy, but direct access will fail.\n\nAre you absolutely sure?`)) return;
    } else {
      if (!confirm(`Confirm firewall ban for ${ip}?`)) return;
    }

    setExecuting(true);
    try {
      const response = await fetch(`/api/control/projects/${projectId}/block-ip`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify({ ip })
      });
      if (response.ok) {
        setSuccess(`IP ${ip} bloqueado.`);
        fetchData(); // Refresh to update project blocklist
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch (e) {
      setError("Erro ao bloquear IP.");
      setTimeout(() => setError(null), 3000);
    } finally {
      setExecuting(false);
    }
  };

  const handleUnblockIp = async (ip: string) => {
      setExecuting(true);
      try {
          const res = await fetch(`/api/control/projects/${projectId}/blocklist/${ip}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          if (res.ok) {
              setSuccess(`${ip} removido da blocklist.`);
              fetchData();
          }
      } catch (e) { setError("Erro ao desbloquear."); }
      finally { setExecuting(false); }
  };

  const toggleAutoBlock = async () => {
      const current = project?.metadata?.security?.auto_block_401 || false;
      try {
          const newMetadata = { 
              ...(project?.metadata || {}), 
              security: { ...(project?.metadata?.security || {}), auto_block_401: !current } 
          };
          
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
    if (!confirm(`Confirma a exclusão de logs ANTIGOS (anteriores a ${days} dias atrás)?\n\nLogs recentes (últimos ${days} dias) serão preservados.`)) return;
    setExecuting(true);
    try {
      await fetch(`/api/control/projects/${projectId}/logs?days=${days}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      setSuccess(`Limpeza concluída.`);
      fetchData();
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      alert("Erro na limpeza");
    } finally {
      setExecuting(false);
    }
  };

  const updateRetention = async (days: number) => {
      // Optimistic update
      setProject({ ...project, log_retention_days: days });
      try {
          await fetch(`/api/control/projects/${projectId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
            body: JSON.stringify({ log_retention_days: days })
          });
      } catch (e) { fetchData(); /* Revert on error */ }
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

  const handleCloudBackup = async () => {
      setExportingCloud(true);
      try {
          const res = await fetch(`/api/control/projects/${projectId}/logs/export-cloud`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          const data = await res.json();
          if (res.ok && data.url) {
              setSuccess("Exportação para nuvem concluída!");
              // Opcional: Abrir o link para o usuário verificar
              if (confirm("Exportação concluída. Deseja abrir o arquivo no provedor de nuvem?")) {
                  window.open(data.url, '_blank');
              }
          } else {
              setError(data.error || "Falha na exportação para nuvem. Verifique se há uma política de backup ativa.");
          }
      } catch (e: any) {
          setError("Erro de conexão ao exportar.");
      } finally {
          setExportingCloud(false);
          setTimeout(() => { setSuccess(null); setError(null); }, 4000);
      }
  };

  const filteredLogs = hideInternal 
    ? logs.filter(l => !l.geo_info?.is_internal) 
    : logs;

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
    <div className="flex h-full flex-col bg-[#F8FAFC] overflow-hidden">
      {/* Notifications */}
      {success && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[600] bg-indigo-600 text-white px-8 py-4 rounded-[2rem] shadow-2xl animate-bounce flex items-center gap-3">
          <CheckCircle2 size={18} />
          <span className="text-xs font-black uppercase tracking-widest">{success}</span>
        </div>
      )}
      {error && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[600] bg-rose-600 text-white px-8 py-4 rounded-[2rem] shadow-2xl animate-pulse flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-xs font-black uppercase tracking-widest">{error}</span>
        </div>
      )}

      <header className="px-10 py-8 bg-white border-b border-slate-200 flex items-center justify-between shrink-0 shadow-sm z-10">
        <div className="flex items-center gap-6">
          <div className="w-14 h-14 bg-slate-900 text-white rounded-[1.5rem] flex items-center justify-center shadow-xl">
            <Activity size={28} />
          </div>
          <div>
            <h2 className="text-3xl font-black text-slate-900 tracking-tighter leading-none">Observability Hub</h2>
            <p className="text-[10px] text-indigo-600 font-bold uppercase tracking-[0.2em] mt-1">Deep API Telemetry & Traffic Insights</p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex items-center bg-slate-100 p-1.5 rounded-2xl">
             <button 
                onClick={() => setHideInternal(!hideInternal)} 
                className={`p-3 transition-all rounded-xl flex items-center gap-2 text-[10px] font-black uppercase tracking-widest ${hideInternal ? 'text-slate-400' : 'bg-white shadow-sm text-indigo-600'}`}
                title={hideInternal ? "Mostrar tráfego interno (Dashboard)" : "Ocultar tráfego interno"}
              >
                {hideInternal ? <EyeOff size={18} /> : <Eye size={18} />}
                {hideInternal ? 'INTERNAL HIDDEN' : 'INTERNAL VISIBLE'}
             </button>
             <div className="w-[1px] h-6 bg-slate-200 mx-1"></div>
             <button onClick={() => fetchData()} className="p-3 text-slate-500 hover:text-indigo-600 transition-all"><RefreshCw size={20} className={loading ? 'animate-spin' : ''} /></button>
             <button onClick={handleExportLogs} className="p-3 text-slate-500 hover:text-indigo-600 transition-all" title="Baixar JSON Local"><Download size={20} /></button>
             <button onClick={() => setShowSettings(true)} className="p-3 text-slate-500 hover:text-indigo-600 transition-all"><Settings2 size={20} /></button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-hidden flex">
        <main className="flex-1 overflow-y-auto px-10 py-10">
          <div className="bg-white border border-slate-200 rounded-[3rem] shadow-sm overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/50 border-b border-slate-100">
                  <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Snapshot</th>
                  <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Action</th>
                  <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Identity</th>
                  <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Status</th>
                  <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Data Out</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filteredLogs.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={5} className="py-40 text-center">
                      <Terminal size={64} className="mx-auto text-slate-100 mb-6" />
                      <p className="text-sm font-black text-slate-300 uppercase tracking-widest">Awaiting first request...</p>
                    </td>
                  </tr>
                ) : filteredLogs.map((log) => {
                  const isInternal = log.geo_info?.is_internal;
                  // More aggressive highlighting for 401/403
                  const isAuthFail = log.status_code === 401 || log.status_code === 403;
                  const isError = log.status_code >= 400;
                  // Exfiltration Alert: Large responses (> 1MB) get red text
                  const isLarge = log.response_size > 1024 * 1024;
                  
                  return (
                    <tr 
                      key={log.id} 
                      onClick={() => setSelectedLog(log)}
                      className={`transition-all cursor-pointer group 
                        ${selectedLog?.id === log.id ? 'bg-indigo-50' : 'hover:bg-indigo-50/30'} 
                        ${isInternal ? 'opacity-60 grayscale' : ''} 
                        ${isAuthFail ? 'bg-rose-50/50 hover:bg-rose-100/50' : ''}
                      `}
                    >
                      <td className="px-8 py-5">
                        <div className="flex flex-col">
                          {/* USE PROJECT TIMEZONE FORMATTER */}
                          <span className={`text-xs font-bold ${isAuthFail ? 'text-rose-600' : 'text-slate-900'}`}>{formatTime(log.created_at)}</span>
                          <span className="text-[9px] font-black text-slate-400 uppercase tracking-tight">{formatDate(log.created_at)}</span>
                        </div>
                      </td>
                      <td className="px-8 py-5">
                        <div className="flex items-center gap-3">
                          {getActionBadge(log)}
                          <div className="flex flex-col">
                            <code className={`text-sm font-mono font-bold truncate max-w-[200px] ${isAuthFail ? 'text-rose-700' : 'text-slate-600'}`}>{log.path}</code>
                            {isInternal && <span className="text-[8px] font-black text-indigo-400 uppercase tracking-widest flex items-center gap-1"><ShieldCheck size={8} /> INTERNAL</span>}
                          </div>
                        </div>
                      </td>
                      <td className="px-8 py-5 text-center">
                        <span className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full border ${isAuthFail ? 'bg-rose-100 text-rose-700 border-rose-200' : 'bg-slate-50 text-slate-400 border-slate-100'}`}>
                          {log.user_role}
                        </span>
                      </td>
                      <td className="px-8 py-5 text-center">
                        <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border ${isError ? 'bg-rose-50 text-rose-600 border-rose-100' : 'bg-emerald-50 text-emerald-600 border-emerald-100'}`}>
                          {isError ? <AlertCircle size={10} /> : <Circle size={8} className="fill-emerald-500" />}
                          <span className="font-black text-xs">{log.status_code}</span>
                        </div>
                      </td>
                      <td className="px-8 py-5 text-right">
                         <div className="flex flex-col items-end">
                             <span className={`text-xs font-mono font-black ${isLarge ? 'text-rose-600' : 'text-slate-600'}`}>
                                {formatBytes(log.response_size)}
                             </span>
                             <span className="text-[9px] text-slate-400 font-bold">{log.duration_ms}ms</span>
                         </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </main>

        {/* LOG DETAILS DRAWER */}
        {selectedLog && (
          <aside className="w-[500px] bg-white border-l border-slate-200 overflow-y-auto animate-in slide-in-from-right duration-300 flex flex-col shadow-2xl relative z-20">
            <header className="p-10 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-4">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-white ${selectedLog.status_code >= 400 ? 'bg-rose-600' : 'bg-emerald-600'}`}>
                   <Activity size={24} />
                </div>
                <div>
                   <h3 className="text-xl font-black text-slate-900 tracking-tight">Request DNA</h3>
                   <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">ID: {selectedLog.id.slice(0, 8)}...</p>
                </div>
              </div>
              <button onClick={() => setSelectedLog(null)} className="p-3 hover:bg-slate-200 rounded-full transition-all text-slate-400"><X size={24}/></button>
            </header>

            <div className="p-10 space-y-10">
              {/* Security Block Action with Intelligence */}
              <div className={`rounded-[2.5rem] p-8 text-white relative overflow-hidden group ${
                  selectedLog.geo_info?.is_internal ? 'bg-slate-900' : 
                  (selectedLog.client_ip === currentUserIp ? 'bg-slate-950' : 
                  (selectedLog.status_code >= 400 ? 'bg-rose-900 shadow-[0_20px_40px_rgba(225,29,72,0.2)]' : 'bg-rose-600'))
                }`}>
                <ShieldAlert className="absolute -bottom-4 -right-4 w-32 h-32 opacity-10 group-hover:scale-125 transition-transform" />
                <h4 className="font-black uppercase text-xs tracking-widest mb-1">Source Governance</h4>
                <p className="text-[10px] font-medium opacity-80 mb-6 flex items-center gap-2">
                  IP: {selectedLog.client_ip} 
                  {selectedLog.client_ip === currentUserIp && <span className="bg-white/20 px-2 py-0.5 rounded-lg border border-white/10 font-bold uppercase tracking-wider text-[8px]">(Current Session)</span>}
                </p>
                
                <button 
                  onClick={() => handleBlockIp(selectedLog.client_ip, selectedLog.geo_info?.is_internal)}
                  disabled={project?.blocklist?.includes(selectedLog.client_ip) || selectedLog.geo_info?.is_internal}
                  className="w-full bg-white text-slate-900 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-3 shadow-2xl hover:bg-slate-50 transition-all active:scale-95 disabled:opacity-50"
                >
                  {selectedLog.geo_info?.is_internal ? (
                    <><Lock size={14}/> IP INTERNO PROTEGIDO</>
                  ) : project?.blocklist?.includes(selectedLog.client_ip) ? (
                    <><Lock size={14}/> IP JÁ BLOQUEADO</>
                  ) : (
                    <><ShieldAlert size={14} className="text-rose-600"/> BLOQUEAR ORIGEM</>
                  )}
                </button>
              </div>

              {/* Rich Metadata Sections */}
              <div className="space-y-8">
                <DetailSection icon={<HardDrive size={16}/>} label="Data Transfer">
                   <div className="grid grid-cols-2 gap-4">
                     <InfoBox label="Response Size" value={formatBytes(selectedLog.response_size)} />
                     <InfoBox label="Latency" value={`${selectedLog.duration_ms}ms`} />
                   </div>
                </DetailSection>

                <DetailSection icon={<Globe2 size={16}/>} label="Security Context">
                   <div className="grid grid-cols-2 gap-4">
                     <InfoBox label="Auth Result" value={selectedLog.status_code >= 400 ? 'DENIED' : 'GRANTED'} />
                     <InfoBox label="Resolved Role" value={selectedLog.user_role || 'NONE'} />
                   </div>
                </DetailSection>

                <DetailSection icon={<Code size={16}/>} label="Request Payload">
                   <pre className="bg-slate-950 text-emerald-400 p-6 rounded-[2rem] font-mono text-[11px] overflow-auto max-h-60 shadow-inner">
                     {JSON.stringify(selectedLog.payload, null, 2)}
                   </pre>
                </DetailSection>

                <DetailSection icon={<Lock size={16}/>} label="System Headers">
                   <pre className="bg-slate-50 border border-slate-100 p-6 rounded-[2rem] font-mono text-[11px] text-slate-600 overflow-auto">
                     {JSON.stringify(selectedLog.headers, null, 2)}
                   </pre>
                </DetailSection>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* SETTINGS / CLEANUP MODAL */}
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
                     
                     {/* Cloud Backup (Implemented) */}
                     <div className="bg-slate-50 border border-slate-200 p-6 rounded-[2.5rem] flex items-center justify-between">
                        <div className="flex items-center gap-4">
                           <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-sm text-indigo-600"><Cloud size={20}/></div>
                           <div>
                              <h4 className="text-sm font-black text-slate-900 flex items-center gap-2">Cloud Log Export</h4>
                              <p className="text-[10px] text-slate-500 font-bold mt-1">Exportar logs (CSV) para o provedor de backup configurado.</p>
                           </div>
                        </div>
                        <button 
                            onClick={handleCloudBackup}
                            disabled={exportingCloud}
                            className="bg-indigo-600 text-white px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 hover:bg-indigo-700 transition-all shadow-lg disabled:opacity-50"
                        >
                            {exportingCloud ? <Loader2 size={14} className="animate-spin"/> : <Download size={14}/>} 
                            Exportar
                        </button>
                     </div>

                     {/* Auto Block Toggle */}
                     <div className="bg-slate-50 border border-slate-200 p-6 rounded-[2.5rem] flex items-center justify-between">
                        <div className="flex items-center gap-4">
                           <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-sm text-indigo-600"><Zap size={20}/></div>
                           <div>
                              <h4 className="text-sm font-black text-slate-900">Auto-Ban Suspicious Origins</h4>
                              <p className="text-[10px] text-slate-500 font-bold mt-1">Automatically add IP to firewall if 401 Unauthorized occurs.</p>
                           </div>
                        </div>
                        <button 
                            onClick={toggleAutoBlock}
                            className={`w-16 h-8 rounded-full p-1 transition-colors ${project?.metadata?.security?.auto_block_401 ? 'bg-indigo-600' : 'bg-slate-200'}`}
                        >
                            <div className={`w-6 h-6 bg-white rounded-full shadow-md transition-transform ${project?.metadata?.security?.auto_block_401 ? 'translate-x-8' : ''}`}></div>
                        </button>
                     </div>

                     <div className="space-y-4">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Manual Purge Controls (Apagar Antes de...)</label>
                        <div className="grid grid-cols-3 gap-3">
                           {[3, 7, 15, 30, 60, 90].map(days => (
                             <button 
                               key={days} 
                               onClick={() => handleClearLogs(days)}
                               className="py-4 border border-slate-100 rounded-2xl text-[10px] font-black uppercase tracking-widest text-slate-500 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition-all flex flex-col items-center gap-1 group"
                             >
                               <Trash2 size={14} className="group-hover:animate-bounce" />
                               {days} Dias Atrás
                             </button>
                           ))}
                        </div>
                     </div>

                     <div className="p-8 bg-slate-50 border border-slate-100 rounded-[2.5rem] space-y-4">
                        <div className="flex items-center justify-between">
                           <div className="flex items-center gap-3">
                              <Calendar size={18} className="text-indigo-600" />
                              <span className="text-sm font-bold text-slate-800">Retention Strategy</span>
                           </div>
                           <select 
                            value={project?.log_retention_days || 30}
                            onChange={(e) => updateRetention(parseInt(e.target.value))}
                            className="bg-white border-none rounded-xl px-4 py-2 text-xs font-black text-indigo-600 outline-none shadow-sm cursor-pointer"
                           >
                              <option value="7">7 Dias</option>
                              <option value="30">30 Dias</option>
                              <option value="90">90 Dias</option>
                              <option value="365">1 Ano</option>
                           </select>
                        </div>
                     </div>
                  </div>
              )}

              {settingsTab === 'firewall' && (
                  <div className="space-y-6">
                      <div className="bg-rose-50 border border-rose-100 p-6 rounded-[2.5rem]">
                          <h4 className="text-rose-700 font-black text-sm mb-2 flex items-center gap-2"><ShieldAlert size={16}/> Active Blocklist</h4>
                          <p className="text-[10px] text-rose-500 font-medium">IPs listed here are completely blocked from accessing the API.</p>
                      </div>
                      <div className="space-y-2">
                          {project?.blocklist?.length === 0 && <p className="text-center text-slate-400 text-xs py-8">Nenhum IP bloqueado.</p>}
                          {project?.blocklist?.map((ip: string) => (
                              <div key={ip} className="flex items-center justify-between bg-white border border-slate-200 p-4 rounded-2xl">
                                  <span className="text-xs font-mono font-bold text-slate-700">{ip}</span>
                                  <button onClick={() => handleUnblockIp(ip)} className="text-[10px] font-black bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-xl hover:bg-emerald-200 transition-colors">DESBLOQUEAR</button>
                              </div>
                          ))}
                      </div>
                  </div>
              )}
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

export default ProjectLogs;
