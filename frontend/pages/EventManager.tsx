
import React, { useState, useEffect } from 'react';
import { 
  Zap, Globe, Plus, Trash2, Send, Activity, 
  CheckCircle2, AlertCircle, Loader2, ShieldCheck, 
  Settings, ExternalLink, RefreshCcw, X 
} from 'lucide-react';

const EventManager: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newHook, setNewHook] = useState({ target_url: '', event_type: 'INSERT', table_name: '*' });
  const [submitting, setSubmitting] = useState(false);

  const fetchHooks = async () => {
    try {
      const res = await fetch(`/api/control/projects/${projectId}/webhooks`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      setWebhooks(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Webhooks fetch error");
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
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
      fetchHooks();
    } catch (e) {
      alert("Erro ao salvar webhook");
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => { fetchHooks(); }, [projectId]);

  return (
    <div className="p-8 lg:p-12 max-w-6xl mx-auto w-full space-y-12 pb-40">
      <header className="flex items-end justify-between gap-8">
        <div>
          <h2 className="text-4xl font-black text-slate-900 tracking-tighter">Event Pipeline</h2>
          <p className="text-slate-500 mt-2 text-lg">Conecte o Cascata a serviços externos via Webhooks nativos.</p>
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
              <div key={hook.id} className="bg-white border border-slate-200 rounded-[2.5rem] p-8 hover:shadow-2xl transition-all group">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-inner ${hook.is_active ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                      <Zap size={20} />
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-slate-900 truncate max-w-md">{hook.target_url}</h4>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[9px] font-black bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full uppercase">{hook.event_type}</span>
                        <span className="text-[9px] font-black bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full uppercase">Table: {hook.table_name}</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="pt-6 border-t border-slate-50 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${hook.is_active ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`}></div>
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{hook.is_active ? 'Ativo' : 'Pausado'}</span>
                  </div>
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
                  Cada webhook enviado inclui um header <code>X-Cascata-Signature</code>. Use este segredo para validar que a requisição partiu da sua instância oficial.
                </p>
            </div>
          </aside>
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
           <div className="bg-white rounded-[3.5rem] w-full max-w-xl p-12 shadow-2xl border border-slate-100 relative">
              <button onClick={() => setShowAdd(false)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900 transition-colors"><X size={24} /></button>
              <h3 className="text-3xl font-black text-slate-900 tracking-tighter mb-8">Novo Webhook</h3>
              <div className="space-y-6">
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">URL de Destino</label>
                    <input 
                      value={newHook.target_url}
                      onChange={(e) => setNewHook({...newHook, target_url: e.target.value})}
                      placeholder="https://sua-api.com/hooks" 
                      className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-bold text-slate-800 outline-none" 
                    />
                 </div>
                 <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                       <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Evento</label>
                       <select 
                        value={newHook.event_type}
                        onChange={(e) => setNewHook({...newHook, event_type: e.target.value})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-black text-indigo-600 outline-none">
                          <option value="INSERT">INSERT</option>
                          <option value="UPDATE">UPDATE</option>
                          <option value="DELETE">DELETE</option>
                          <option value="*">TODOS</option>
                       </select>
                    </div>
                    <div className="space-y-2">
                       <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Tabela</label>
                       <input 
                        value={newHook.table_name}
                        onChange={(e) => setNewHook({...newHook, table_name: e.target.value})}
                        placeholder="users" className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-sm font-bold text-slate-800 outline-none" />
                    </div>
                 </div>
                 <button 
                  onClick={handleCreate}
                  disabled={submitting}
                  className="w-full bg-indigo-600 text-white py-5 rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl flex items-center justify-center gap-2">
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
