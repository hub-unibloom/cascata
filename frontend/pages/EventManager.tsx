
import React, { useState, useEffect } from 'react';
import { 
  Zap, Globe, Plus, Trash2, Send, Activity, 
  CheckCircle2, AlertCircle, Loader2, ShieldCheck, 
  Settings, ExternalLink, RefreshCcw, X, Eye, EyeOff, Copy, Play, Filter,
  Siren, ShieldAlert, AlertTriangle
} from 'lucide-react';

interface FilterRule {
    field: string;
    operator: string;
    value: string;
}

const EventManager: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [tableColumns, setTableColumns] = useState<string[]>([]); // New for Filter UI
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  
  // FORM STATE
  const [newHook, setNewHook] = useState({ 
      target_url: '', 
      event_type: 'INSERT', 
      table_name: '*', 
      filters: [] as FilterRule[],
      fallback_url: '',
      retry_policy: 'standard' // 'standard', 'none', 'linear'
  });
  
  const [submitting, setSubmitting] = useState(false);
  const [testLoading, setTestLoading] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchHooks = async () => {
    try {
      const res = await fetch(`/api/control/projects/${projectId}/webhooks`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      setWebhooks(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Webhooks fetch error");
    }
  };

  const fetchTables = async () => {
      try {
          const res = await fetch(`/api/data/${projectId}/tables`, {
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          const data = await res.json();
          setTables(data.map((t: any) => t.name));
      } catch (e) { console.error("Table fetch error"); }
  };

  const fetchColumns = async (tableName: string) => {
      if (tableName === '*') {
          setTableColumns([]);
          return;
      }
      try {
          const res = await fetch(`/api/data/${projectId}/tables/${tableName}/columns`, {
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          const data = await res.json();
          setTableColumns(data.map((c: any) => c.name));
      } catch(e) {}
  };

  useEffect(() => { 
      Promise.all([fetchHooks(), fetchTables()]).then(() => setLoading(false)); 
  }, [projectId]);

  // Effect to load columns when table changes in form
  useEffect(() => {
      if (showAdd && newHook.table_name) {
          fetchColumns(newHook.table_name);
      }
  }, [newHook.table_name, showAdd]);

  const handleCreate = async () => {
    if (!newHook.target_url) { setError("URL é obrigatória."); return; }
    setSubmitting(true);
    try {
      await fetch(`/api/control/projects/${projectId}/webhooks`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify(newHook)
      });
      setShowAdd(false);
      setNewHook({ target_url: '', event_type: 'INSERT', table_name: '*', filters: [], fallback_url: '', retry_policy: 'standard' });
      fetchHooks();
      setSuccess("Webhook criado com sucesso.");
    } catch (e) {
      setError("Erro ao salvar webhook.");
    } finally {
      setSubmitting(false);
      setTimeout(() => setSuccess(null), 3000);
      setTimeout(() => setError(null), 3000);
    }
  };

  const handleDelete = async (id: string) => {
      if(!confirm("Tem certeza? Esta ação é irreversível.")) return;
      try {
          await fetch(`/api/control/projects/${projectId}/webhooks/${id}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          fetchHooks();
          setSuccess("Webhook removido.");
      } catch(e) { setError("Falha ao remover."); }
      setTimeout(() => setSuccess(null), 3000);
  };

  const handleToggle = async (hook: any) => {
      try {
          await fetch(`/api/control/projects/${projectId}/webhooks/${hook.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ is_active: !hook.is_active })
          });
          fetchHooks();
      } catch(e) { setError("Erro ao atualizar status."); }
  };

  const handleTest = async (id: string) => {
      setTestLoading(id);
      try {
          const res = await fetch(`/api/control/system/webhooks/${id}/test`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ payload: { message: "Hello from Cascata Ping Test", timestamp: new Date() } })
          });
          if(res.ok) setSuccess("Ping enviado com sucesso!");
          else setError("O endpoint retornou erro.");
      } catch(e) { setError("Falha no teste."); }
      finally { 
          setTestLoading(null); 
          setTimeout(() => setSuccess(null), 3000);
          setTimeout(() => setError(null), 3000);
      }
  };

  const copySecret = (text: string) => {
      navigator.clipboard.writeText(text);
      setSuccess("Segredo copiado!");
      setTimeout(() => setSuccess(null), 2000);
  };

  const addFilter = () => {
      setNewHook(prev => ({
          ...prev,
          filters: [...prev.filters, { field: tableColumns[0] || '', operator: 'eq', value: '' }]
      }));
  };

  const removeFilter = (idx: number) => {
      setNewHook(prev => ({
          ...prev,
          filters: prev.filters.filter((_, i) => i !== idx)
      }));
  };

  const updateFilter = (idx: number, field: string, val: any) => {
      const updated = [...newHook.filters];
      updated[idx] = { ...updated[idx], [field]: val };
      setNewHook(prev => ({ ...prev, filters: updated }));
  };

  return (
    <div className="p-8 lg:p-12 max-w-6xl mx-auto w-full space-y-12 pb-40">
      
      {/* Toast */}
      {(success || error) && (
          <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[600] px-6 py-3 rounded-full shadow-xl flex items-center gap-3 animate-in slide-in-from-top-4 ${error ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`}>
              {error ? <AlertCircle size={18}/> : <CheckCircle2 size={18}/>}
              <span className="text-xs font-bold">{success || error}</span>
          </div>
      )}

      <header className="flex items-end justify-between gap-8">
        <div>
          <h2 className="text-4xl font-black text-slate-900 tracking-tighter">Event Pipeline</h2>
          <p className="text-slate-500 mt-2 text-lg">Conecte o Cascata a serviços externos (n8n, Zapier) via Webhooks nativos.</p>
        </div>
        <button 
          onClick={() => setShowAdd(true)}
          className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center gap-2 hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100"
        >
          <Plus size={20} /> Adicionar Webhook
        </button>
      </header>

      {loading ? (
        <div className="py-40 flex flex-col items-center justify-center text-slate-300">
          <Loader2 size={60} className="animate-spin mb-6" />
          <p className="text-sm font-black uppercase tracking-widest">Sincronizando endpoints...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
          <div className="lg:col-span-2 space-y-6">
            {webhooks.length === 0 && (
              <div className="py-40 border-4 border-dashed border-slate-100 rounded-[3rem] flex flex-col items-center justify-center text-slate-300">
                <Zap size={60} className="mb-4 opacity-10" />
                <p className="text-[10px] font-black uppercase tracking-widest">Nenhum evento configurado</p>
              </div>
            )}
            {webhooks.map(hook => (
              <div key={hook.id} className={`bg-white border rounded-[2.5rem] p-8 shadow-sm hover:shadow-xl transition-all group relative ${hook.is_active ? 'border-slate-200' : 'border-slate-100 opacity-75 grayscale-[0.5]'}`}>
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-inner ${hook.is_active ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                      <Zap size={20} />
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-slate-900 truncate max-w-md" title={hook.target_url}>{hook.target_url}</h4>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase ${hook.event_type === 'DELETE' ? 'bg-rose-50 text-rose-600' : hook.event_type === 'INSERT' ? 'bg-emerald-50 text-emerald-600' : 'bg-indigo-50 text-indigo-600'}`}>{hook.event_type === '*' ? 'ALL EVENTS' : hook.event_type}</span>
                        <span className="text-[9px] font-black bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full uppercase">Table: {hook.table_name === '*' ? 'ALL TABLES' : hook.table_name}</span>
                        {hook.retry_policy === 'none' && <span className="text-[9px] font-black bg-rose-50 text-rose-600 px-2 py-0.5 rounded-full uppercase border border-rose-100 flex items-center gap-1"><AlertTriangle size={8}/> NO RETRY</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                      <button onClick={() => handleTest(hook.id)} disabled={testLoading === hook.id} className="p-2 bg-slate-50 hover:bg-indigo-50 text-slate-400 hover:text-indigo-600 rounded-xl transition-all" title="Test Payload">
                          {testLoading === hook.id ? <Loader2 size={18} className="animate-spin"/> : <Play size={18}/>}
                      </button>
                      <button onClick={() => handleDelete(hook.id)} className="p-2 bg-slate-50 hover:bg-rose-50 text-slate-400 hover:text-rose-600 rounded-xl transition-all" title="Delete">
                          <Trash2 size={18}/>
                      </button>
                  </div>
                </div>
                
                {/* Active Filters Display */}
                {hook.filters && hook.filters.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-4 pl-16">
                        {hook.filters.map((f: any, i: number) => (
                            <span key={i} className="text-[9px] bg-indigo-50 text-indigo-700 px-2 py-1 rounded border border-indigo-100 font-mono">
                                {f.field} {f.operator} {f.value}
                            </span>
                        ))}
                    </div>
                )}

                {/* Fallback Display */}
                {hook.fallback_url && (
                    <div className="mb-4 pl-16 flex items-center gap-2 text-[10px] text-rose-500 font-bold">
                        <Siren size={12}/>
                        <span>Alert on Failure:</span>
                        <code className="bg-rose-50 px-2 py-0.5 rounded text-rose-700 font-mono">{hook.fallback_url}</code>
                    </div>
                )}

                {/* Secret Section */}
                <div className="bg-slate-50 rounded-xl p-3 flex items-center justify-between mb-4 border border-slate-100">
                    <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500">
                        <ShieldCheck size={12} className="text-indigo-400"/>
                        <span>Secret:</span>
                        <span className="bg-white px-2 py-0.5 rounded border border-slate-200">
                            {revealedSecret === hook.id ? (hook.secret_header || 'default_jwt_secret') : '••••••••••••••••••••••••'}
                        </span>
                    </div>
                    <div className="flex gap-1">
                        <button onClick={() => setRevealedSecret(revealedSecret === hook.id ? null : hook.id)} className="p-1.5 hover:bg-white rounded-lg text-slate-400 hover:text-indigo-600 transition-all">
                            {revealedSecret === hook.id ? <EyeOff size={14}/> : <Eye size={14}/>}
                        </button>
                        <button onClick={() => copySecret(hook.secret_header || 'default_jwt_secret')} className="p-1.5 hover:bg-white rounded-lg text-slate-400 hover:text-indigo-600 transition-all">
                            <Copy size={14}/>
                        </button>
                    </div>
                </div>

                <div className="pt-4 border-t border-slate-50 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${hook.is_active ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`}></div>
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{hook.is_active ? 'Active Pipeline' : 'Paused'}</span>
                  </div>
                  <button onClick={() => handleToggle(hook)} className={`text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-lg transition-all ${hook.is_active ? 'bg-slate-100 text-slate-500 hover:bg-amber-50 hover:text-amber-600' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}>
                      {hook.is_active ? 'Pause' : 'Resume'}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <aside className="space-y-8">
            <div className="bg-slate-900 rounded-[2.5rem] p-8 text-white relative overflow-hidden shadow-2xl">
                <Activity className="absolute -bottom-4 -right-4 text-white/5 w-40 h-40" />
                <h3 className="text-lg font-black uppercase tracking-tight mb-4 flex items-center gap-2">
                  <ShieldCheck className="text-indigo-400" size={20} /> Segurança de Eventos
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-6 font-medium">
                  Cada webhook enviado inclui um header <code>X-Cascata-Signature</code>. Use o segredo exibido ao lado para validar a autenticidade (HMAC SHA256).
                </p>
                <div className="bg-white/10 p-4 rounded-xl border border-white/5 font-mono text-[10px] text-emerald-300">
                    verify_signature(payload, secret, header_sig)
                </div>
            </div>
          </aside>
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
           <div className="bg-white rounded-[3.5rem] w-full max-w-xl p-12 shadow-2xl border border-slate-100 relative max-h-[90vh] overflow-y-auto custom-scrollbar">
              <button onClick={() => setShowAdd(false)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900 transition-colors"><X size={24} /></button>
              <h3 className="text-3xl font-black text-slate-900 tracking-tighter mb-8">Novo Webhook</h3>
              <div className="space-y-6">
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">URL de Destino</label>
                    <input 
                      value={newHook.target_url}
                      onChange={(e) => setNewHook({...newHook, target_url: e.target.value})}
                      placeholder="https://api.seusistema.com/hooks" 
                      className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-bold text-slate-800 outline-none focus:ring-4 focus:ring-indigo-500/10" 
                      autoFocus
                    />
                 </div>
                 <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                       <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Evento Gatilho</label>
                       <select 
                        value={newHook.event_type}
                        onChange={(e) => setNewHook({...newHook, event_type: e.target.value})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-black text-indigo-600 outline-none cursor-pointer">
                          <option value="INSERT">INSERT (Create)</option>
                          <option value="UPDATE">UPDATE (Edit)</option>
                          <option value="DELETE">DELETE (Remove)</option>
                          <option value="*">ALL EVENTS</option>
                       </select>
                    </div>
                    <div className="space-y-2">
                       <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Tabela Alvo</label>
                       <select 
                        value={newHook.table_name}
                        onChange={(e) => setNewHook({...newHook, table_name: e.target.value})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-bold text-slate-800 outline-none cursor-pointer">
                          <option value="*">* (Todas as Tabelas)</option>
                          {tables.map(t => <option key={t} value={t}>{t}</option>)}
                       </select>
                    </div>
                 </div>

                 {/* Trigger Conditions UI */}
                 <div className="bg-slate-50 rounded-3xl p-6 border border-slate-100">
                     <div className="flex justify-between items-center mb-4">
                         <h4 className="text-xs font-black text-slate-600 uppercase tracking-widest flex items-center gap-2"><Filter size={12}/> Trigger Conditions (Optional)</h4>
                         <button onClick={addFilter} disabled={newHook.table_name === '*'} className="text-[10px] bg-white border border-slate-200 px-3 py-1.5 rounded-lg font-bold text-indigo-600 hover:bg-indigo-50 disabled:opacity-50">+ Add Condition</button>
                     </div>
                     
                     {newHook.table_name === '*' && <p className="text-[10px] text-amber-600 font-bold mb-2">Select a specific table to enable filters.</p>}

                     <div className="space-y-3">
                         {newHook.filters.map((filter, idx) => (
                             <div key={idx} className="flex gap-2 items-center animate-in slide-in-from-left-2">
                                 <select value={filter.field} onChange={(e) => updateFilter(idx, 'field', e.target.value)} className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold outline-none flex-1">
                                     {tableColumns.map(c => <option key={c} value={c}>{c}</option>)}
                                 </select>
                                 <select value={filter.operator} onChange={(e) => updateFilter(idx, 'operator', e.target.value)} className="bg-white border border-slate-200 rounded-xl px-2 py-2 text-xs font-bold outline-none w-20">
                                     <option value="eq">=</option>
                                     <option value="neq">!=</option>
                                     <option value="gt">&gt;</option>
                                     <option value="lt">&lt;</option>
                                     <option value="contains">has</option>
                                     <option value="starts_with">starts</option>
                                 </select>
                                 <input value={filter.value} onChange={(e) => updateFilter(idx, 'value', e.target.value)} className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold outline-none flex-1" placeholder="Value..."/>
                                 <button onClick={() => removeFilter(idx)} className="p-2 text-slate-300 hover:text-rose-500"><X size={14}/></button>
                             </div>
                         ))}
                         {newHook.filters.length === 0 && newHook.table_name !== '*' && <p className="text-center text-[10px] text-slate-400 italic py-2">No filters defined. Trigger on all events.</p>}
                     </div>
                 </div>

                 {/* Reliability & Alerts Section */}
                 <div className="bg-rose-50/50 rounded-3xl p-6 border border-rose-100">
                     <div className="flex justify-between items-center mb-4">
                         <h4 className="text-xs font-black text-rose-800 uppercase tracking-widest flex items-center gap-2"><Siren size={12}/> Reliability & Alerts</h4>
                     </div>
                     
                     <div className="space-y-4">
                         <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Retry Policy</label>
                            <div className="grid grid-cols-3 gap-3">
                                <button onClick={() => setNewHook({...newHook, retry_policy: 'standard'})} className={`py-2 rounded-xl text-[10px] font-bold border transition-all ${newHook.retry_policy === 'standard' ? 'bg-white border-rose-200 text-rose-700 shadow-sm' : 'border-transparent text-slate-400 hover:bg-white/50'}`}>Standard (10x Exp)</button>
                                <button onClick={() => setNewHook({...newHook, retry_policy: 'linear'})} className={`py-2 rounded-xl text-[10px] font-bold border transition-all ${newHook.retry_policy === 'linear' ? 'bg-white border-rose-200 text-rose-700 shadow-sm' : 'border-transparent text-slate-400 hover:bg-white/50'}`}>Linear (5x 5s)</button>
                                <button onClick={() => setNewHook({...newHook, retry_policy: 'none'})} className={`py-2 rounded-xl text-[10px] font-bold border transition-all ${newHook.retry_policy === 'none' ? 'bg-rose-600 border-rose-600 text-white shadow-sm' : 'border-transparent text-slate-400 hover:bg-white/50'}`}>Strict (No Retry)</button>
                            </div>
                            <p className="text-[9px] text-slate-400 px-2 mt-1">Use 'Strict' for payments to avoid double-charging if your system isn't idempotent.</p>
                         </div>

                         <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Fallback Alert URL (Optional)</label>
                            <input 
                              value={newHook.fallback_url}
                              onChange={(e) => setNewHook({...newHook, fallback_url: e.target.value})}
                              placeholder="https://n8n.webhook/alert-whatsapp" 
                              className="w-full bg-white border border-rose-200 rounded-2xl py-3 px-4 text-xs font-bold text-slate-800 outline-none focus:ring-4 focus:ring-rose-500/10 placeholder:text-rose-300/50" 
                            />
                            <p className="text-[9px] text-slate-400 px-2">Triggered ONLY if main webhook fails completely (Dead Letter).</p>
                         </div>
                     </div>
                 </div>

                 <button 
                  onClick={handleCreate}
                  disabled={submitting}
                  className="w-full bg-indigo-600 text-white py-5 rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl flex items-center justify-center gap-2 hover:bg-indigo-700 transition-all">
                    {submitting ? <Loader2 className="animate-spin" size={18} /> : 'Criar Endpoint'}
                 </button>
              </div>
           </div>
        </div>
      )}
    </div>
  );
};

export default EventManager;
