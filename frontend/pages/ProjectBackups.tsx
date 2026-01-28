
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Clock, Plus, HardDrive, Play, CheckCircle2, AlertTriangle, 
  Trash2, Loader2, Copy, FileJson, Check, FolderKey, Calendar, 
  RefreshCw, Download, ArrowRight, ShieldCheck, HelpCircle, X,
  Database, Cloud, Server, Box, Info, Zap, CalendarDays, Repeat, 
  History, Layers, AlertCircle, RotateCcw, Settings, Edit3, Lock,
  Infinity as InfinityIcon
} from 'lucide-react';

// Provider Definitions for UI
const PROVIDERS = [
    { id: 'gdrive', name: 'Google Drive', icon: HardDrive, color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200', desc: '15GB Free. Requer Service Account.' },
    { id: 'b2', name: 'Backblaze B2', icon: Database, color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200', desc: '10GB Grátis. API S3 Compatible.' },
    { id: 'r2', name: 'Cloudflare R2', icon: Cloud, color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-200', desc: '10GB Grátis. Zero taxa de saída.' },
    { id: 'aws', name: 'AWS S3', icon: Box, color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200', desc: 'Standard da indústria. Free Tier 5GB.' },
    { id: 'wasabi', name: 'Wasabi', icon: Server, color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200', desc: 'Econômico ($6/TB). Sem tier grátis.' }
];

const ProjectBackups: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [policies, setPolicies] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Wizard State
  const [showWizard, setShowWizard] = useState(false);
  const [step, setStep] = useState(0); 
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);

  const [wizardData, setWizardData] = useState<any>({
      name: '',
      provider: '',
      // Detailed Schedule Props
      frequency: 'daily', 
      hour: '03',
      minute: '00',
      dayOfWeek: '1', 
      dayOfMonth: '1',
      smartSchedule: false,
      retention_count: 7,
      // Credentials
      serviceAccount: null, 
      folderId: '',
      endpoint: '',
      region: '',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: ''
  });

  const [jsonError, setJsonError] = useState('');
  const [validating, setValidating] = useState(false);
  const [validationSuccess, setValidationSuccess] = useState(false);
  const [validationMsg, setValidationMsg] = useState('');

  // UI State
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  
  // Restore Modal State
  const [restoreModal, setRestoreModal] = useState<{ active: boolean, id: string }>({ active: false, id: '' });
  const [restorePassword, setRestorePassword] = useState('');
  const [restoring, setRestoring] = useState(false);

  const fetchData = useCallback(async () => {
      setLoading(true);
      try {
          const token = localStorage.getItem('cascata_token');
          const [polRes, hisRes] = await Promise.all([
              fetch(`/api/control/projects/${projectId}/backups/policies`, { headers: { 'Authorization': `Bearer ${token}` } }),
              fetch(`/api/control/projects/${projectId}/backups/history`, { headers: { 'Authorization': `Bearer ${token}` } })
          ]);
          setPolicies(await polRes.json());
          setHistory(await hisRes.json());
      } catch (e) { console.error("Backup sync error"); } 
      finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // --- LOGIC: CRON GENERATION ---
  const generateCronExpression = () => {
      if (wizardData.smartSchedule) {
          const rMin = Math.floor(Math.random() * 59);
          const rHour = Math.floor(Math.random() * 4) + 1; // 01-04 AM
          const rDay = Math.floor(Math.random() * 6); 
          const rDate = Math.floor(Math.random() * 27) + 1; 

          if (wizardData.frequency === 'hourly') return `${rMin} * * * *`;
          if (wizardData.frequency === 'daily') return `${rMin} ${rHour} * * *`;
          if (wizardData.frequency === 'weekly') return `${rMin} ${rHour} * * ${rDay}`;
          if (wizardData.frequency === 'monthly') return `${rMin} ${rHour} ${rDate} * *`;
      }
      
      const { minute, hour, dayOfWeek, dayOfMonth } = wizardData;
      
      if (wizardData.frequency === 'hourly') return `${minute} * * * *`;
      if (wizardData.frequency === 'daily') return `${minute} ${hour} * * *`;
      if (wizardData.frequency === 'weekly') return `${minute} ${hour} * * ${dayOfWeek}`;
      if (wizardData.frequency === 'monthly') return `${minute} ${hour} ${dayOfMonth} * *`;
      
      return '0 0 * * *'; 
  };

  const getProviderStyle = (pid: string) => {
      return PROVIDERS.find(p => p.id === pid) || { color: 'text-slate-600', bg: 'bg-slate-50', icon: Database, name: 'Unknown' };
  };

  // --- HELPER LOGIC FOR WIZARD ---
  const existingAccounts = useMemo(() => {
      if (!wizardData.provider) return [];
      const seen = new Set();
      return policies.filter(p => {
          if (p.provider !== wizardData.provider) return false;
          // Identify unique credentials
          const key = p.provider === 'gdrive' ? p.config?.client_email : p.config?.accessKeyId;
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
      });
  }, [policies, wizardData.provider]);

  const handleUseExistingAccount = (e: React.ChangeEvent<HTMLSelectElement>) => {
      const policyId = e.target.value;
      if (!policyId) return;
      const policy = policies.find(p => p.id === policyId);
      if (policy && policy.config) {
          if (wizardData.provider === 'gdrive') {
              setWizardData((prev: any) => ({
                  ...prev,
                  serviceAccount: {
                      client_email: policy.config.client_email,
                      private_key: policy.config.private_key
                  }
              }));
          } else {
              setWizardData((prev: any) => ({
                  ...prev,
                  endpoint: policy.config.endpoint || '',
                  region: policy.config.region || '',
                  bucket: policy.config.bucket || '',
                  accessKeyId: policy.config.accessKeyId || '',
                  secretAccessKey: policy.config.secretAccessKey || ''
              }));
          }
      }
  };

  const copyEmail = () => {
      if (wizardData.serviceAccount?.client_email) {
          navigator.clipboard.writeText(wizardData.serviceAccount.client_email);
          setSuccess("Email copiado!");
          setTimeout(() => setSuccess(null), 2000);
      }
  };

  // --- ACTIONS ---

  const handleProviderSelect = (providerId: string) => {
      let defaults: any = { provider: providerId, name: editingPolicyId ? wizardData.name : `${PROVIDERS.find(p => p.id === providerId)?.name} Backup` };
      if (providerId === 'wasabi') defaults.region = 'us-east-1'; 
      if (providerId === 'aws') defaults.endpoint = ''; 
      setWizardData(prev => ({ ...prev, ...defaults }));
      setStep(1);
  };

  const handleEditPolicy = (policy: any) => {
      setEditingPolicyId(policy.id);
      // Try to parse cron
      const parts = policy.schedule_cron.split(' ');
      let freq = 'daily';
      if (parts[1] === '*') freq = 'hourly';
      if (parts[4] !== '*') freq = 'weekly';
      if (parts[2] !== '*') freq = 'monthly';

      let newData = {
          name: policy.name,
          provider: policy.provider,
          retention_count: policy.retention_count,
          frequency: freq,
          minute: parts[0] || '00',
          hour: parts[1] === '*' ? '00' : parts[1],
          dayOfMonth: parts[2] === '*' ? '1' : parts[2],
          dayOfWeek: parts[4] === '*' ? '1' : parts[4],
          smartSchedule: false,
          // Extract config
          serviceAccount: policy.provider === 'gdrive' ? { client_email: policy.config.client_email, private_key: policy.config.private_key } : null,
          folderId: policy.config.root_folder_id || '',
          endpoint: policy.config.endpoint || '',
          region: policy.config.region || '',
          bucket: policy.config.bucket || '',
          accessKeyId: policy.config.accessKeyId || '',
          secretAccessKey: policy.config.secretAccessKey || ''
      };
      setWizardData(prev => ({ ...prev, ...newData }));
      setShowWizard(true);
      setStep(0);
      setValidationSuccess(true); 
  };

  const handleSavePolicy = async () => {
      try {
          let finalConfig: any = {};
          if (wizardData.provider === 'gdrive') {
              finalConfig = {
                  client_email: wizardData.serviceAccount.client_email,
                  private_key: wizardData.serviceAccount.private_key,
                  root_folder_id: wizardData.folderId || undefined
              };
          } else {
              finalConfig = {
                  endpoint: wizardData.endpoint,
                  region: wizardData.region,
                  bucket: wizardData.bucket,
                  accessKeyId: wizardData.accessKeyId,
                  secretAccessKey: wizardData.secretAccessKey
              };
          }

          const cron = generateCronExpression();
          const url = editingPolicyId 
              ? `/api/control/projects/${projectId}/backups/policies/${editingPolicyId}` 
              : `/api/control/projects/${projectId}/backups/policies`;

          await fetch(url, {
              method: editingPolicyId ? 'PATCH' : 'POST',
              headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
              },
              body: JSON.stringify({
                  name: wizardData.name,
                  provider: wizardData.provider,
                  schedule_cron: cron,
                  retention_count: wizardData.retention_count,
                  config: finalConfig
              })
          });
          setSuccess("Política de Backup salva com sucesso!");
          setShowWizard(false);
          setEditingPolicyId(null);
          fetchData();
      } catch (e) { alert("Erro ao salvar."); }
  };

  const handleRename = async (id: string, newName: string) => {
      if (!newName.trim()) return;
      try {
          await fetch(`/api/control/projects/${projectId}/backups/policies/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ name: newName })
          });
          fetchData();
          setRenamingId(null);
      } catch(e) {}
  };

  const handleDownload = async (historyId: string) => {
      try {
          const res = await fetch(`/api/control/projects/${projectId}/backups/history/${historyId}/download`, {
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          const data = await res.json();
          if (data.url) {
              window.open(data.url, '_blank');
          } else {
              alert("Erro ao gerar link de download.");
          }
      } catch (e) { alert("Falha ao baixar."); }
  };

  const handleRestore = async () => {
      if (!restorePassword) return;
      setRestoring(true);
      try {
          const res = await fetch(`/api/control/projects/${projectId}/backups/history/${restoreModal.id}/restore`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ password: restorePassword })
          });
          const data = await res.json();
          if (res.ok) {
              setSuccess("Sistema restaurado! Reiniciando serviços...");
              setRestoreModal({ active: false, id: '' });
              setRestorePassword('');
          } else {
              alert("Erro: " + data.error);
          }
      } catch (e) { alert("Falha catastrófica no restore."); }
      finally { setRestoring(false); }
  };

  const handleJsonUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
          try {
              const json = JSON.parse(ev.target?.result as string);
              setWizardData((prev:any) => ({ ...prev, serviceAccount: json }));
              setJsonError('');
          } catch (err: any) { setJsonError(err.message); }
      };
      reader.readAsText(file);
  };

  const handleTestConnection = async () => {
      setValidating(true); setValidationMsg('');
      try {
          let configToTest: any = {};
          if (wizardData.provider === 'gdrive') {
              configToTest = { client_email: wizardData.serviceAccount.client_email, private_key: wizardData.serviceAccount.private_key, root_folder_id: wizardData.folderId || undefined };
          } else {
              configToTest = { endpoint: wizardData.endpoint, region: wizardData.region, bucket: wizardData.bucket, accessKeyId: wizardData.accessKeyId, secretAccessKey: wizardData.secretAccessKey };
          }
          const res = await fetch(`/api/control/projects/${projectId}/backups/validate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ config: configToTest, provider: wizardData.provider })
          });
          const data = await res.json();
          if (res.ok) { setValidationSuccess(true); setValidationMsg("Conexão bem sucedida!"); } 
          else { setValidationSuccess(false); setValidationMsg(data.error || "Erro na validação."); }
      } catch (e) { setValidationMsg("Erro de rede."); } finally { setValidating(false); }
  };

  const handleDeletePolicy = async (id: string) => {
      if (!confirm("Deletar política?")) return;
      try {
          await fetch(`/api/control/projects/${projectId}/backups/policies/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
          fetchData();
      } catch(e) {}
  };

  const handleTrigger = async (id: string) => {
      try {
          await fetch(`/api/control/projects/${projectId}/backups/policies/${id}/run`, { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
          setSuccess("Backup iniciado."); setTimeout(() => setSuccess(null), 3000); fetchData();
      } catch(e) {}
  };

  return (
    <div className="p-8 lg:p-12 max-w-[1600px] mx-auto w-full space-y-12 pb-40">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-8">
            <div>
                <h1 className="text-5xl font-black text-slate-900 tracking-tighter mb-2">Time Capsule</h1>
                <p className="text-slate-400 text-lg font-medium max-w-2xl leading-relaxed">Snapshot Engine & Disaster Recovery</p>
            </div>
            {policies.length === 0 && (
                <button onClick={() => { setShowWizard(true); setEditingPolicyId(null); setStep(0); setWizardData(d => ({...d, name: ''})); }} className="bg-indigo-600 text-white px-8 py-4 rounded-[2rem] font-black text-sm uppercase tracking-widest hover:bg-indigo-700 transition-all flex items-center gap-3 shadow-xl active:scale-95">
                    <Plus size={18}/> Novo Backup
                </button>
            )}
        </div>

        {success && <div className="bg-emerald-100 border border-emerald-200 text-emerald-800 px-6 py-4 rounded-2xl flex items-center gap-3 font-bold animate-in slide-in-from-top-4"><CheckCircle2 size={20}/> {success}</div>}

        {policies.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Active Policies Card */}
                <div className="lg:col-span-1 space-y-6">
                    {policies.map(p => {
                        const style = getProviderStyle(p.provider);
                        const isRenaming = renamingId === p.id;
                        return (
                            <div key={p.id} className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm relative overflow-hidden transition-all hover:shadow-md group">
                                <div className="flex justify-between items-start mb-6">
                                    <div className="flex items-center gap-4 w-full">
                                        <div className={`w-12 h-12 ${style.bg} ${style.color} rounded-2xl flex items-center justify-center shadow-inner shrink-0`}>
                                            <style.icon size={24}/>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            {isRenaming ? (
                                                <input 
                                                    autoFocus
                                                    defaultValue={p.name}
                                                    onBlur={(e) => handleRename(p.id, e.target.value)}
                                                    onKeyDown={(e) => e.key === 'Enter' && handleRename(p.id, (e.target as any).value)}
                                                    className="font-black text-lg bg-slate-50 w-full rounded px-2 outline-none border border-slate-200"
                                                />
                                            ) : (
                                                <h3 onDoubleClick={() => setRenamingId(p.id)} className="text-lg font-black text-slate-900 truncate cursor-pointer hover:text-indigo-600 transition-colors" title="Double click to rename">{p.name}</h3>
                                            )}
                                            <div className="flex items-center gap-2 mt-1">
                                                <span className="text-[10px] font-bold text-slate-400 uppercase">{p.provider}</span>
                                                <span className="text-[9px] bg-slate-100 px-2 py-0.5 rounded text-slate-500 font-mono">{p.schedule_cron}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button onClick={() => handleEditPolicy(p)} className="p-2 text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"><Settings size={16}/></button>
                                        <button onClick={() => handleDeletePolicy(p.id)} className="p-2 text-slate-300 hover:text-rose-500 hover:bg-rose-50 rounded-xl transition-all"><Trash2 size={16}/></button>
                                    </div>
                                </div>
                                
                                <div className="space-y-4">
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 text-center">
                                            <span className="block text-[9px] font-black text-slate-400 uppercase">Retenção</span>
                                            <span className="block text-sm font-bold text-slate-700">{p.retention_count > 1000 ? 'Ilimitado' : `${p.retention_count} snaps`}</span>
                                        </div>
                                        <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 text-center">
                                            <span className="block text-[9px] font-black text-slate-400 uppercase">Status</span>
                                            <span className={`block text-xs font-black uppercase ${p.last_status === 'success' ? 'text-emerald-600' : p.last_status === 'failed' ? 'text-rose-600' : 'text-slate-400'}`}>{p.last_status || 'IDLE'}</span>
                                        </div>
                                    </div>
                                    <button onClick={() => handleTrigger(p.id)} className="w-full py-4 bg-slate-900 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-indigo-600 transition-all shadow-lg flex items-center justify-center gap-2">
                                        <Play size={14}/> Executar Agora
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                    
                    <button onClick={() => { setShowWizard(true); setEditingPolicyId(null); setStep(0); setWizardData(d => ({...d, name: ''})); }} className="w-full py-6 border-2 border-dashed border-slate-200 rounded-[2.5rem] text-slate-400 font-bold uppercase tracking-widest hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/30 transition-all flex items-center justify-center gap-2">
                        <Plus size={16}/> Nova Política
                    </button>
                </div>

                {/* History Table */}
                <div className="lg:col-span-2 bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm flex flex-col h-[600px]">
                    <div className="flex items-center justify-between mb-6 px-2">
                        <h3 className="text-xl font-black text-slate-900 flex items-center gap-3"><Clock size={24} className="text-amber-500"/> Timeline</h3>
                        <button onClick={fetchData} className="p-2 hover:bg-slate-50 rounded-full text-slate-400"><RefreshCw size={18}/></button>
                    </div>
                    <div className="flex-1 overflow-auto custom-scrollbar">
                        <table className="w-full text-left border-collapse">
                            <thead className="sticky top-0 bg-white z-10">
                                <tr className="border-b border-slate-100 text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                    <th className="px-6 py-4">Data</th>
                                    <th className="px-6 py-4">Política / Origem</th>
                                    <th className="px-6 py-4 text-center">Status</th>
                                    <th className="px-6 py-4 text-right">Tamanho</th>
                                    <th className="px-6 py-4"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {history.length === 0 && <tr><td colSpan={5} className="py-20 text-center text-slate-300 text-xs font-bold italic">Nenhum snapshot registrado.</td></tr>}
                                {history.map(h => (
                                    <tr key={h.id} className="group hover:bg-slate-50 transition-colors">
                                        <td className="px-6 py-4">
                                            <div className="flex flex-col">
                                                <span className="text-xs font-bold text-slate-700">{new Date(h.started_at).toLocaleDateString()}</span>
                                                <span className="text-[10px] text-slate-400 font-medium">{new Date(h.started_at).toLocaleTimeString()}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex flex-col">
                                                <span className="text-xs font-bold text-indigo-900">{h.policy_name || 'Manual Backup'}</span>
                                                <div className="flex items-center gap-1 text-[10px] text-slate-400 font-medium uppercase">
                                                    {h.policy_provider || 'System'}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-center">
                                            <span className={`px-2 py-1 rounded text-[9px] font-black uppercase inline-flex items-center gap-1 ${h.status === 'completed' ? 'bg-emerald-50 text-emerald-600' : h.status === 'failed' ? 'bg-rose-50 text-rose-600' : 'bg-amber-50 text-amber-600 animate-pulse'}`}>
                                                {h.status === 'completed' ? <CheckCircle2 size={10}/> : h.status === 'failed' ? <AlertTriangle size={10}/> : <Loader2 size={10} className="animate-spin"/>} {h.status}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right text-xs font-bold text-slate-600">{h.file_size ? (h.file_size / 1024 / 1024).toFixed(2) + ' MB' : '-'}</td>
                                        <td className="px-6 py-4 text-right">
                                            {h.status === 'completed' && (
                                                <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <button onClick={() => handleDownload(h.id)} className="p-2 text-indigo-600 hover:bg-indigo-100 rounded-lg" title="Download">
                                                        <Download size={16}/>
                                                    </button>
                                                    <button onClick={() => setRestoreModal({ active: true, id: h.id })} className="p-2 text-rose-600 hover:bg-rose-100 rounded-lg" title="Restore System">
                                                        <RotateCcw size={16}/>
                                                    </button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        ) : (
            // EMPTY STATE
            <div className="flex flex-col items-center justify-center py-20 bg-white border border-slate-200 rounded-[3rem] shadow-sm">
                <div className="w-32 h-32 bg-slate-50 rounded-full flex items-center justify-center mb-8 border-4 border-white shadow-xl">
                    <ShieldCheck size={64} className="text-slate-300"/>
                </div>
                <h2 className="text-2xl font-black text-slate-900 mb-2">Proteja seus Dados</h2>
                <p className="text-slate-500 font-medium max-w-md text-center mb-10 leading-relaxed">
                    Configure backups automáticos em nuvem. Suporte nativo para S3, Google Drive e compatíveis.
                </p>
                <button onClick={() => { setShowWizard(true); setStep(0); setEditingPolicyId(null); setWizardData(d => ({...d, name: ''})); }} className="bg-indigo-600 text-white px-10 py-5 rounded-[2rem] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-2xl hover:-translate-y-1 active:translate-y-0">
                    Iniciar Configuração
                </button>
            </div>
        )}

        {/* RESTORE MODAL */}
        {restoreModal.active && (
            <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-[600] flex items-center justify-center p-8 animate-in zoom-in-95">
                <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl text-center border border-rose-100">
                    <div className="w-16 h-16 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center mx-auto mb-6"><AlertCircle size={32}/></div>
                    <h3 className="text-xl font-black text-slate-900 mb-2">Restauração de Sistema</h3>
                    <p className="text-xs text-slate-500 font-medium mb-6 leading-relaxed">
                        Atenção: Esta ação irá <b>sobrescrever</b> o banco de dados atual com a versão do backup selecionado. Todos os dados recentes serão perdidos.
                    </p>
                    <input 
                        type="password" 
                        autoFocus
                        value={restorePassword}
                        onChange={e => setRestorePassword(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-center font-bold text-slate-900 outline-none mb-6 focus:ring-4 focus:ring-rose-500/10"
                        placeholder="Senha de Admin"
                    />
                    <button onClick={handleRestore} disabled={restoring || !restorePassword} className="w-full bg-rose-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-rose-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                        {restoring ? <Loader2 className="animate-spin"/> : <RotateCcw size={16}/>} Confirmar Regressão
                    </button>
                    <button onClick={() => { setRestoreModal({ active: false, id: '' }); setRestorePassword(''); }} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600">Cancelar</button>
                </div>
            </div>
        )}

        {/* WIZARD MODAL */}
        {showWizard && (
            <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in fade-in zoom-in-95 duration-300">
                <div className="bg-white rounded-[3rem] w-full max-w-3xl flex flex-col shadow-2xl overflow-hidden max-h-[90vh]">
                    <div className="p-10 pb-6 bg-slate-50 border-b border-slate-100">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-3xl font-black text-slate-900 tracking-tighter">
                                {editingPolicyId ? 'Editar Política' : (step === 0 ? 'Escolha o Provedor' : `Configurar ${PROVIDERS.find(p => p.id === wizardData.provider)?.name}`)}
                            </h3>
                            <button onClick={() => setShowWizard(false)} className="p-3 bg-white hover:bg-slate-200 rounded-full text-slate-400 transition-colors"><X size={20}/></button>
                        </div>
                        <div className="flex items-center gap-2">
                            {[0, 1, 2, 3, 4].map(idx => (
                                <div key={idx} className={`h-2 flex-1 rounded-full transition-all ${step >= idx ? 'bg-indigo-600' : 'bg-slate-200'}`}></div>
                            ))}
                        </div>
                        {/* WIZARD LABELS */}
                        <div className="flex justify-between mt-2 text-[10px] font-black uppercase text-slate-400 tracking-widest px-1">
                            <span className={step >= 0 ? 'text-indigo-600' : ''}>Provedor</span>
                            <span className={step >= 1 ? 'text-indigo-600' : ''}>Credenciais</span>
                            <span className={step >= 2 ? 'text-indigo-600' : ''}>Validação</span>
                            <span className={step >= 3 ? 'text-indigo-600' : ''}>Agendamento</span>
                            <span className={step >= 4 ? 'text-indigo-600' : ''}>Retenção</span>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-10">
                        {step === 0 && (
                            <div className="space-y-6 animate-in slide-in-from-right-4">
                                {!editingPolicyId && (
                                    <div className="mb-6">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Nome da Política</label>
                                        <input value={wizardData.name} onChange={e => setWizardData((d:any) => ({...d, name: e.target.value}))} className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-4 text-lg font-bold outline-none" placeholder="Ex: Backup Diário AWS"/>
                                    </div>
                                )}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {PROVIDERS.map(prov => (
                                        <button 
                                            key={prov.id}
                                            onClick={() => handleProviderSelect(prov.id)}
                                            className={`p-6 rounded-[2rem] border hover:shadow-lg transition-all text-left group bg-white ${prov.border} hover:border-indigo-300 ${wizardData.provider === prov.id ? 'ring-2 ring-indigo-500' : ''}`}
                                        >
                                            <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${prov.bg} ${prov.color}`}>
                                                <prov.icon size={24}/>
                                            </div>
                                            <h4 className="text-lg font-black text-slate-900 group-hover:text-indigo-600 transition-colors">{prov.name}</h4>
                                            <p className="text-xs text-slate-500 mt-1">{prov.desc}</p>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {step === 1 && (
                            <div className="space-y-8 animate-in slide-in-from-right-4">
                                {existingAccounts.length > 0 && !editingPolicyId && (
                                    <div className="bg-indigo-50 border border-indigo-100 p-4 rounded-xl mb-6">
                                        <label className="text-[10px] font-black text-indigo-800 uppercase tracking-widest block mb-2">Usar conta salva</label>
                                        <select onChange={handleUseExistingAccount} className="w-full bg-white border border-indigo-200 rounded-xl px-4 py-2 text-xs font-bold outline-none">
                                            <option value="">-- Selecione uma conta existente --</option>
                                            {existingAccounts.map(p => (<option key={p.id} value={p.id}>{p.name} ({p.provider})</option>))}
                                        </select>
                                    </div>
                                )}
                                {wizardData.provider === 'gdrive' ? (
                                    <div className="text-center space-y-6">
                                        <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mx-auto"><FileJson size={32}/></div>
                                        <h4 className="text-xl font-bold text-slate-900">Service Account Key</h4>
                                        <div className="border-4 border-dashed border-slate-200 rounded-[2rem] p-10 text-center hover:bg-slate-50 hover:border-indigo-300 transition-all cursor-pointer relative group">
                                            <input type="file" accept=".json" onChange={handleJsonUpload} className="absolute inset-0 opacity-0 cursor-pointer z-10" />
                                            {wizardData.serviceAccount ? <div className="flex flex-col items-center gap-2"><CheckCircle2 size={40} className="text-emerald-500 mb-2"/><span className="font-bold text-slate-900 text-lg">Arquivo Carregado!</span></div> : <div className="text-slate-400 group-hover:text-indigo-500 transition-colors"><span className="block font-bold mb-1">Clique ou Arraste aqui</span><span className="text-xs">service-account-key.json</span></div>}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="space-y-4">
                                        <div className="grid grid-cols-2 gap-4">
                                            <div className="space-y-1"><label className="text-[10px] font-black uppercase text-slate-400 ml-1">Endpoint (URL)</label><input value={wizardData.endpoint} onChange={e => setWizardData((d:any) => ({...d, endpoint: e.target.value}))} className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none"/></div>
                                            <div className="space-y-1"><label className="text-[10px] font-black uppercase text-slate-400 ml-1">Region</label><input value={wizardData.region} onChange={e => setWizardData((d:any) => ({...d, region: e.target.value}))} className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none"/></div>
                                        </div>
                                        <div className="space-y-1"><label className="text-[10px] font-black uppercase text-slate-400 ml-1">Bucket Name</label><input value={wizardData.bucket} onChange={e => setWizardData((d:any) => ({...d, bucket: e.target.value}))} className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold outline-none"/></div>
                                        <div className="space-y-1"><label className="text-[10px] font-black uppercase text-slate-400 ml-1">Access Key ID</label><input value={wizardData.accessKeyId} onChange={e => setWizardData((d:any) => ({...d, accessKeyId: e.target.value}))} className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono outline-none"/></div>
                                        <div className="space-y-1"><label className="text-[10px] font-black uppercase text-slate-400 ml-1">Secret Access Key</label><input type="password" value={wizardData.secretAccessKey} onChange={e => setWizardData((d:any) => ({...d, secretAccessKey: e.target.value}))} className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono outline-none"/></div>
                                    </div>
                                )}
                                <div className="flex justify-between pt-4"><button onClick={() => setStep(0)} className="text-slate-400 font-bold text-xs px-4">Voltar</button><button disabled={wizardData.provider === 'gdrive' ? !wizardData.serviceAccount : (!wizardData.bucket || !wizardData.accessKeyId)} onClick={() => setStep(2)} className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl flex items-center gap-2">Próximo <ArrowRight size={14}/></button></div>
                            </div>
                        )}

                        {step === 2 && (
                            <div className="space-y-8 animate-in slide-in-from-right-4">
                                {wizardData.provider === 'gdrive' && (
                                    <div className="bg-indigo-50 border border-indigo-100 p-6 rounded-[2rem] text-center space-y-4">
                                        <p className="text-xs font-bold text-indigo-800 uppercase tracking-widest">Compartilhe sua pasta com este e-mail:</p>
                                        <div className="flex items-center gap-2 bg-white p-3 rounded-xl cursor-pointer" onClick={copyEmail}><code className="flex-1 text-center font-mono text-xs font-bold text-slate-700 truncate">{wizardData.serviceAccount.client_email}</code><Copy size={14} className="text-indigo-400"/></div>
                                        <div className="space-y-1"><label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">ID da Pasta</label><input value={wizardData.folderId} onChange={(e) => setWizardData((d:any) => ({...d, folderId: e.target.value}))} className="w-full bg-white border border-indigo-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none text-center"/></div>
                                    </div>
                                )}
                                <div className="text-center"><button onClick={handleTestConnection} disabled={validating} className="px-8 py-3 rounded-2xl bg-slate-900 text-white font-bold text-xs uppercase tracking-widest hover:bg-indigo-600 transition-all shadow-lg">{validating ? <Loader2 size={16} className="animate-spin"/> : 'Testar Conexão'}</button>{validationMsg && <div className={`mt-4 p-4 rounded-xl text-xs font-bold ${validationSuccess ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{validationMsg}</div>}</div>
                                <div className="flex justify-between pt-4"><button onClick={() => setStep(1)} className="text-slate-400 font-bold text-xs px-4">Voltar</button><button onClick={() => setStep(3)} disabled={!validationSuccess} className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl flex items-center gap-2">Próximo <ArrowRight size={14}/></button></div>
                            </div>
                        )}

                        {step === 3 && (
                            <div className="space-y-8 animate-in slide-in-from-right-4">
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                                    {['monthly', 'weekly', 'daily', 'hourly'].map(freq => (
                                        <button key={freq} onClick={() => setWizardData((d:any) => ({...d, frequency: freq}))} className={`py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${wizardData.frequency === freq ? 'bg-indigo-600 text-white shadow-lg' : 'bg-slate-50 text-slate-400 hover:bg-slate-100'}`}>{freq}</button>
                                    ))}
                                </div>
                                <div className="bg-slate-50 border border-slate-200 rounded-[2rem] p-6 space-y-6">
                                    {/* Granular Schedule Selectors */}
                                    {wizardData.frequency === 'monthly' && (
                                        <div className="space-y-1">
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Dia do Mês</label>
                                            <div className="flex items-center gap-2">
                                                <CalendarDays size={16} className="text-slate-400"/>
                                                <select 
                                                    value={wizardData.dayOfMonth} 
                                                    onChange={e => setWizardData({...wizardData, dayOfMonth: e.target.value})}
                                                    className="bg-white border border-slate-200 rounded-xl px-4 py-2 text-sm font-bold outline-none flex-1"
                                                >
                                                    {Array.from({length: 28}, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
                                                </select>
                                            </div>
                                        </div>
                                    )}

                                    {wizardData.frequency === 'weekly' && (
                                        <div className="space-y-1">
                                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Dia da Semana</label>
                                            <div className="flex gap-1 overflow-x-auto pb-1">
                                                {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'].map((d, i) => (
                                                    <button 
                                                        key={i} 
                                                        onClick={() => setWizardData({...wizardData, dayOfWeek: i.toString()})}
                                                        className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold transition-all ${wizardData.dayOfWeek === i.toString() ? 'bg-indigo-100 text-indigo-700' : 'bg-white border border-slate-100 text-slate-400'}`}
                                                    >
                                                        {d}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {wizardData.frequency !== 'hourly' && (
                                        <div className="flex gap-4">
                                            <div className="flex-1 space-y-1"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Hora</label><select value={wizardData.hour} onChange={e => setWizardData((d:any) => ({...d, hour: e.target.value}))} className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none">{Array.from({length: 24}, (_, i) => i).map(h => <option key={h} value={h.toString().padStart(2, '0')}>{h.toString().padStart(2, '0')}:00</option>)}</select></div>
                                            <div className="flex-1 space-y-1">
                                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Minuto</label>
                                                <select value={wizardData.minute} onChange={e => setWizardData({...wizardData, minute: e.target.value})} className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm font-bold outline-none">
                                                    {['00', '15', '30', '45'].map(m => <option key={m} value={m}>{m}</option>)}
                                                </select>
                                            </div>
                                        </div>
                                    )}

                                    {/* Smart Schedule Toggle */}
                                    <div 
                                        className={`p-4 rounded-2xl border cursor-pointer transition-all flex items-start gap-4 ${wizardData.smartSchedule ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200 hover:border-indigo-300'}`}
                                        onClick={() => setWizardData((prev:any) => ({ ...prev, smartSchedule: !prev.smartSchedule }))}
                                    >
                                        <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${wizardData.smartSchedule ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400'}`}>
                                            <Zap size={20}/>
                                        </div>
                                        <div>
                                            <h4 className={`font-bold text-sm ${wizardData.smartSchedule ? 'text-emerald-900' : 'text-slate-700'}`}>Smart Traffic Shaping</h4>
                                            <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
                                                Permitir que o sistema ajuste automaticamente o horário (dentro de janelas de baixa atividade) para evitar sobrecarga no servidor.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex justify-between pt-4"><button onClick={() => setStep(2)} className="text-slate-400 font-bold text-xs px-4">Voltar</button><button onClick={() => setStep(4)} className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl flex items-center gap-2">Próximo <ArrowRight size={14}/></button></div>
                            </div>
                        )}

                        {step === 4 && (
                            <div className="space-y-8 animate-in slide-in-from-right-4">
                                <div className="bg-indigo-50 border border-indigo-100 p-6 rounded-[2rem]">
                                    <div className="flex items-center gap-3 mb-4">
                                        <div className="w-10 h-10 bg-indigo-200 rounded-xl flex items-center justify-center text-indigo-700"><Layers size={20}/></div>
                                        <h4 className="font-bold text-indigo-900">Política de Retenção (FIFO)</h4>
                                    </div>

                                    <div className="flex items-center gap-4 bg-white p-4 rounded-2xl border border-indigo-100 mb-4">
                                        <input type="range" min="3" max="35" value={wizardData.retention_count > 30 ? 35 : wizardData.retention_count} onChange={(e) => {
                                            const val = parseInt(e.target.value);
                                            setWizardData((d:any) => ({...d, retention_count: val > 30 ? 999999 : val}))
                                        }} className="flex-1 accent-indigo-600 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer"/>
                                        <span className="font-black text-indigo-600 bg-indigo-50 px-3 py-1 rounded-lg border border-indigo-100 flex items-center gap-1">
                                            {wizardData.retention_count > 30 ? <><InfinityIcon size={14}/> Ilimitado</> : `${wizardData.retention_count} backups`}
                                        </span>
                                    </div>
                                    
                                    <p className="text-center text-[10px] text-indigo-700 mt-4 font-medium px-4">
                                        {wizardData.retention_count > 30 
                                            ? "Backups antigos NUNCA serão apagados automaticamente. Gerencie o armazenamento manualmente." 
                                            : `Quando o backup #${wizardData.retention_count + 1} for criado, o backup mais antigo será automaticamente removido.`
                                        }
                                    </p>
                                </div>
                                <div className="flex justify-between pt-4"><button onClick={() => setStep(3)} className="text-slate-400 font-bold text-xs px-4">Voltar</button><button onClick={handleSavePolicy} className="bg-emerald-600 text-white px-10 py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl hover:bg-emerald-700 flex items-center gap-2"><CheckCircle2 size={16}/> {editingPolicyId ? 'Atualizar Política' : 'Confirmar & Ativar'}</button></div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        )}
    </div>
  );
};

export default ProjectBackups;
