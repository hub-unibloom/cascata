
import React, { useState, useEffect } from 'react';
import { 
  Zap, Plus, Trash2, Activity, Play, 
  CheckCircle2, AlertCircle, Loader2, 
  Settings, X, Filter, GitBranch, Terminal,
  History, ToggleLeft as Toggle, Layout, Workflow,
  ChevronRight, Save, Database, Globe
} from 'lucide-react';

const AutomationManager: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [automations, setAutomations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [activeTab, setActiveTab] = useState<'workflows' | 'runs'>('workflows');
  const [runs, setRuns] = useState<any[]>([]);
  
  // FORM STATE
  const [newAutomation, setNewAutomation] = useState({ 
      name: '', 
      description: '',
      trigger_type: 'API_INTERCEPT', 
      trigger_config: { table: '*', event: '*' }, 
      nodes: [] as any[],
      is_active: true
  });
  
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
    } catch (e) {
      console.error("Automations fetch error");
    }
  };

  const fetchRuns = async () => {
    try {
      const res = await fetch(`/api/data/${projectId}/automations/runs`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await res.json();
      setRuns(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Runs fetch error");
    }
  };

  useEffect(() => { 
      Promise.all([fetchAutomations(), fetchRuns()]).then(() => setLoading(false)); 
  }, [projectId]);

  const handleCreate = async () => {
    if (!newAutomation.name) { setError("Nome é obrigatório."); return; }
    setSubmitting(true);
    try {
      await fetch(`/api/data/${projectId}/automations`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify(newAutomation)
      });
      setShowAdd(false);
      setNewAutomation({ 
          name: '', 
          description: '',
          trigger_type: 'API_INTERCEPT', 
          trigger_config: { table: '*', event: '*' }, 
          nodes: [],
          is_active: true
      });
      fetchAutomations();
      setSuccess("Automação criada com sucesso.");
    } catch (e) {
      setError("Erro ao salvar automação.");
    } finally {
      setSubmitting(false);
      setTimeout(() => setSuccess(null), 3000);
      setTimeout(() => setError(null), 3000);
    }
  };

  const handleDelete = async (id: string) => {
      if(!confirm("Tem certeza? Esta ação removerá permanentemente o fluxo.")) return;
      try {
          await fetch(`/api/data/${projectId}/automations/${id}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          fetchAutomations();
          setSuccess("Automação removida.");
      } catch(e) { setError("Falha ao remover."); }
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
      } catch(e) { setError("Erro ao atualizar status."); }
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      
      {/* Notifications */}
      {(success || error) && (
          <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[600] px-6 py-3 rounded-full shadow-xl flex items-center gap-3 ${error ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`}>
              {error ? <AlertCircle size={18}/> : <CheckCircle2 size={18}/>}
              <span className="text-xs font-bold">{success || error}</span>
          </div>
      )}

      <header className="flex items-center justify-between">
        <div className="flex bg-slate-100 p-1 rounded-2xl">
           <button 
             onClick={() => setActiveTab('workflows')}
             className={`px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'workflows' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
             Fluxos de Trabalho
           </button>
           <button 
             onClick={() => setActiveTab('runs')}
             className={`px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'runs' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>
             Histórico (Runs)
           </button>
        </div>
        <button 
          onClick={() => setShowAdd(true)}
          className="bg-slate-900 text-white px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-2 hover:bg-black transition-all shadow-xl"
        >
          <Plus size={16} /> Nova Automação
        </button>
      </header>

      {loading ? (
        <div className="py-40 flex flex-col items-center justify-center text-slate-300">
          <Loader2 size={60} className="animate-spin mb-6" />
          <p className="text-xs font-black uppercase tracking-widest">Iniciando Orchestrator...</p>
        </div>
      ) : activeTab === 'workflows' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {automations.length === 0 && (
            <div className="col-span-full py-40 border-4 border-dashed border-slate-100 rounded-[3rem] flex flex-col items-center justify-center text-slate-300">
              <Workflow size={60} className="mb-4 opacity-10" />
              <p className="text-[10px] font-black uppercase tracking-widest">Nenhuma automação configurada</p>
            </div>
          )}
          {automations.map(auto => (
            <div key={auto.id} className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm hover:shadow-2xl transition-all group relative overflow-hidden">
               <div className={`absolute top-0 right-0 w-24 h-24 -mr-8 -mt-8 rounded-full blur-3xl opacity-10 transition-colors ${auto.is_active ? 'bg-emerald-500' : 'bg-slate-500'}`}></div>
               
               <div className="flex items-start justify-between mb-8">
                 <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-inner ${auto.is_active ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-100 text-slate-400'}`}>
                   <GitBranch size={24} />
                 </div>
                 <div className="flex items-center gap-1">
                   <button className="p-2 hover:bg-slate-50 rounded-xl text-slate-400 hover:text-indigo-600 transition-all"><Settings size={18}/></button>
                   <button onClick={() => handleDelete(auto.id)} className="p-2 hover:bg-slate-50 rounded-xl text-slate-400 hover:text-rose-600 transition-all"><Trash2 size={18}/></button>
                 </div>
               </div>

               <h4 className="text-lg font-black text-slate-900 mb-2">{auto.name}</h4>
               <p className="text-xs text-slate-500 font-medium mb-6 line-clamp-2">{auto.description || 'Nenhuma descrição fornecida para este fluxo.'}</p>

               <div className="flex flex-wrap gap-2 mb-8">
                 <span className="text-[9px] font-black bg-indigo-50 text-indigo-600 px-2 py-1 rounded-full uppercase border border-indigo-100">{auto.trigger_type}</span>
                 <span className="text-[9px] font-black bg-slate-100 text-slate-500 px-2 py-1 rounded-full uppercase border border-slate-200">Table: {auto.trigger_config?.table || '*'}</span>
               </div>

               <div className="flex items-center justify-between pt-6 border-t border-slate-50">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${auto.is_active ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`}></div>
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{auto.is_active ? 'Running' : 'Paused'}</span>
                  </div>
                  <button 
                    onClick={() => handleToggle(auto)}
                    className={`text-[9px] font-black uppercase tracking-widest px-4 py-2 rounded-xl transition-all ${auto.is_active ? 'bg-slate-100 text-slate-500 hover:bg-amber-50 hover:text-amber-600' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-500 hover:text-white'}`}>
                    {auto.is_active ? 'Pause' : 'Resume'}
                  </button>
               </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-[3rem] overflow-hidden shadow-sm">
           <table className="w-full text-left border-collapse">
             <thead>
               <tr className="bg-slate-50 border-b border-slate-100">
                 <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                 <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Timestamp</th>
                 <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Execution Time</th>
                 <th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
               </tr>
             </thead>
             <tbody className="divide-y divide-slate-100">
               {runs.map(run => (
                 <tr key={run.id} className="hover:bg-slate-50/50 transition-all">
                   <td className="px-8 py-6">
                     <div className="flex items-center gap-2">
                       {run.status === 'success' ? <CheckCircle2 size={16} className="text-emerald-500"/> : <AlertCircle size={16} className="text-rose-500"/>}
                       <span className={`text-[10px] font-black uppercase tracking-widest ${run.status === 'success' ? 'text-emerald-600' : 'text-rose-600'}`}>{run.status}</span>
                     </div>
                   </td>
                   <td className="px-8 py-6 font-mono text-[10px] text-slate-500">{new Date(run.created_at).toLocaleString()}</td>
                   <td className="px-8 py-6 font-mono text-[10px] text-slate-500">{run.execution_time_ms}ms</td>
                   <td className="px-8 py-6 text-right">
                      <button className="text-[10px] font-black text-indigo-600 hover:text-indigo-800 uppercase tracking-widest">View Details</button>
                   </td>
                 </tr>
               ))}
               {runs.length === 0 && (
                 <tr>
                   <td colSpan={4} className="px-8 py-20 text-center text-slate-300 text-[10px] font-black uppercase tracking-widest italic">Nenhum log disponível</td>
                 </tr>
               )}
             </tbody>
           </table>
        </div>
      )}

      {/* Modal Criar Automação */}
      {showAdd && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
           <div className="bg-white rounded-[3.5rem] w-full max-w-2xl p-12 shadow-2xl border border-slate-100 relative max-h-[90vh] overflow-y-auto custom-scrollbar">
              <button onClick={() => setShowAdd(false)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900 transition-colors"><X size={24} /></button>
              
              <div className="flex items-center gap-4 mb-10">
                 <div className="w-16 h-16 bg-slate-900 text-white rounded-[1.5rem] flex items-center justify-center">
                    <Zap size={30} />
                 </div>
                 <div>
                    <h3 className="text-3xl font-black text-slate-900 tracking-tighter">Novo Fluxo Interno</h3>
                    <p className="text-xs text-slate-400 font-bold uppercase tracking-widest mt-1">Crie lógicas e automações no-code</p>
                 </div>
              </div>

              <div className="space-y-8">
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Nome do Fluxo</label>
                    <input 
                      value={newAutomation.name}
                      onChange={(e) => setNewAutomation({...newAutomation, name: e.target.value})}
                      placeholder="Ex: Gerador de PIX Dinâmico" 
                      className="w-full bg-slate-50 border border-slate-200 rounded-3xl py-5 px-8 text-sm font-bold text-slate-800 outline-none focus:ring-4 focus:ring-indigo-500/10" 
                      autoFocus
                    />
                 </div>

                 <div className="grid grid-cols-2 gap-8">
                    <div className="space-y-2">
                       <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Gatilho (Trigger)</label>
                       <select 
                        value={newAutomation.trigger_type}
                        onChange={(e) => setNewAutomation({...newAutomation, trigger_type: e.target.value})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-3xl py-5 px-8 text-sm font-black text-indigo-600 outline-none cursor-pointer appearance-none">
                          <option value="API_INTERCEPT">API Interceptor (Rest V1)</option>
                          <option value="DB_EVENT">DB Event (Background)</option>
                          <option value="CRON">Cron Job (Schedule)</option>
                       </select>
                    </div>
                    <div className="space-y-2">
                       <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Tabela</label>
                       <input 
                         value={newAutomation.trigger_config.table}
                         onChange={(e) => setNewAutomation({...newAutomation, trigger_config: {...newAutomation.trigger_config, table: e.target.value}})}
                         className="w-full bg-slate-50 border border-slate-200 rounded-3xl py-5 px-8 text-sm font-bold text-slate-800 outline-none"
                         placeholder="* para todas"
                       />
                    </div>
                 </div>

                 <div className="bg-slate-900 rounded-[2.5rem] p-10 text-white relative overflow-hidden group">
                    <Terminal className="absolute -bottom-6 -right-6 text-white/5 w-40 h-40 group-hover:scale-110 transition-transform duration-700" />
                    <h4 className="text-xs font-black uppercase tracking-widest mb-6 flex items-center gap-2">
                      <Layout size={16} className="text-indigo-400" /> Visual Workflow Composer
                    </h4>
                    <p className="text-[10px] text-slate-400 font-medium leading-relaxed mb-8">
                      Em breve: Canvas interativo para arrastar e soltar nós (n8n style). <br/>
                      No momento, os fluxos são definidos via JSON estruturado.
                    </p>
                    <button className="bg-white/10 hover:bg-white/20 text-white px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest border border-white/5 transition-all">
                       Abrir Editor Experimental
                    </button>
                 </div>

                 <button 
                  onClick={handleCreate}
                  disabled={submitting}
                  className="w-full bg-indigo-600 text-white py-6 rounded-3xl text-sm font-black uppercase tracking-widest shadow-2xl flex items-center justify-center gap-3 hover:bg-indigo-700 transition-all">
                    {submitting ? <Loader2 className="animate-spin" size={20} /> : <><Save size={20}/> Salvar e Ativar</>}
                 </button>
              </div>
           </div>
        </div>
      )}

    </div>
  );
};

export default AutomationManager;
