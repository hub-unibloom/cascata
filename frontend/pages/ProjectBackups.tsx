
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Clock, Plus, HardDrive, Play, CheckCircle2, AlertTriangle, 
  Trash2, Loader2, Copy, FileJson, Check, FolderKey, Calendar, 
  RefreshCw, Download, ArrowRight, ShieldCheck, HelpCircle, X,
  Database, Cloud, Server, Box, Info, Zap, CalendarDays, Repeat, 
  History, Layers, AlertCircle, RotateCcw, Settings, Edit3, Lock,
  Infinity as InfinityIcon, Upload, Key, GitCompare, GitMerge, FileDiff,
  AlertOctagon, Timer
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
  const [activeTab, setActiveTab] = useState<'timeline' | 'policies'>('timeline');
  const [policies, setPolicies] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  // --- WIZARD STATE (RESTORED) ---
  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(0); 
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

  // --- RESTORE WIZARD (FILE IMPORT) ---
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [restoreStep, setRestoreStep] = useState<'upload' | 'analyze' | 'strategy' | 'execute' | 'done'>('upload');
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [diffReport, setDiffReport] = useState<any>(null);
  const [strategies, setStrategies] = useState<Record<string, string>>({});
  const [tempDbName, setTempDbName] = useState('');
  const [preserveKeys, setPreserveKeys] = useState(true);
  const [rollbackId, setRollbackId] = useState<string | null>(null);

  // --- ROLLBACK WIZARD (SYSTEM SNAPSHOT) ---
  const [showRollbackModal, setShowRollbackModal] = useState(false);
  const [selectedSnapshot, setSelectedSnapshot] = useState<any>(null);
  const [rollbackMode, setRollbackMode] = useState<'hard' | 'smart'>('smart');
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [quarantineDb, setQuarantineDb] = useState('');

  // --- OFFSITE RESTORE MODAL (HISTORY) ---
  const [restoreOffsiteModal, setRestoreOffsiteModal] = useState<{ active: boolean, id: string }>({ active: false, id: '' });
  const [restoreOffsitePassword, setRestoreOffsitePassword] = useState('');
  const [restoringOffsite, setRestoringOffsite] = useState(false);

  // UI State
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
      setLoading(true);
      try {
          const token = localStorage.getItem('cascata_token');
          const headers = { 'Authorization': `Bearer ${token}` };
          
          const [polRes, hisRes, snapRes] = await Promise.all([
              fetch(`/api/control/projects/${projectId}/backups/policies`, { headers }),
              fetch(`/api/control/projects/${projectId}/backups/history`, { headers }),
              fetch(`/api/data/${projectId}/branch/snapshots`, { headers })
          ]);
          
          setPolicies(await polRes.json());
          setHistory(await hisRes.json());
          setSnapshots(await snapRes.json());
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

  // --- POLICY MANAGEMENT ACTIONS ---

  const handleProviderSelect = (providerId: string) => {
      let defaults: any = { provider: providerId, name: editingPolicyId ? wizardData.name : `${PROVIDERS.find(p => p.id === providerId)?.name} Backup` };
      if (providerId === 'wasabi') defaults.region = 'us-east-1'; 
      if (providerId === 'aws') defaults.endpoint = ''; 
      setWizardData(prev => ({ ...prev, ...defaults }));
      setWizardStep(1);
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
      setWizardStep(0);
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

  // --- SYSTEM SNAPSHOT ROLLBACK LOGIC ---
  const handleRollback = async () => {
      if (!selectedSnapshot) return;
      setRollbackLoading(true);
      setError(null);
      try {
          const token = localStorage.getItem('cascata_token');
          const res = await fetch(`/api/data/${projectId}/branch/rollback`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                  snapshot_name: selectedSnapshot.name,
                  mode: rollbackMode
              })
          });
          
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          
          setQuarantineDb(data.quarantine);
          setSuccess("System successfully reverted!");
          setTimeout(() => {
              setShowRollbackModal(false);
              window.location.reload();
          }, 3000);
          
      } catch (e: any) {
          setError(e.message);
      } finally {
          setRollbackLoading(false);
      }
  };

  // --- OFFSITE RESTORE LOGIC (HISTORY ITEM) ---
  const handleDownload = async (historyId: string) => {
      try {
          const token = localStorage.getItem('cascata_token');
          const res = await fetch(`/api/control/projects/${projectId}/backups/history/${historyId}/download`, { headers: { 'Authorization': `Bearer ${token}` } });
          const data = await res.json();
          if (data.url) window.open(data.url, '_blank');
      } catch (e) { alert("Link generation failed."); }
  };

  const handleRestoreOffsite = async () => {
      if (!restoreOffsitePassword) return;
      setRestoringOffsite(true);
      try {
          const res = await fetch(`/api/control/projects/${projectId}/backups/history/${restoreOffsiteModal.id}/restore`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ password: restoreOffsitePassword })
          });
          const data = await res.json();
          if (res.ok) {
              setSuccess("Sistema restaurado! Reiniciando serviços...");
              setRestoreOffsiteModal({ active: false, id: '' });
              setRestoreOffsitePassword('');
          } else {
              alert("Erro: " + data.error);
          }
      } catch (e) { alert("Falha catastrófica no restore."); }
      finally { setRestoringOffsite(false); }
  };

  // --- FILE IMPORT LOGIC (CAF) ---
  const handleUploadAnalyze = async () => {
      if (!restoreFile) return;
      setRestoreStep('analyze');
      
      const formData = new FormData();
      formData.append('file', restoreFile);

      try {
          const token = localStorage.getItem('cascata_token');
          const upRes = await fetch('/api/control/projects/import/upload', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}` },
              body: formData
          });
          const upData = await upRes.json();
          
          const anRes = await fetch('/api/control/projects/import/analyze', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ temp_path: upData.temp_path, slug: projectId })
          });
          const anData = await anRes.json();
          
          setDiffReport(anData.diff);
          setTempDbName(anData.diff.temp_db_name);
          
          const defaults: Record<string, string> = {};
          Object.keys(anData.diff.data_diff).forEach(t => {
              defaults[t] = anData.diff.data_diff[t].strategy_recommendation;
          });
          setStrategies(defaults);
          setRestoreStep('strategy');

      } catch (e: any) { setError(e.message); setRestoreStep('upload'); }
  };

  const handleExecuteMigration = async () => {
      setRestoreStep('execute');
      try {
          const token = localStorage.getItem('cascata_token');
          const res = await fetch('/api/control/projects/import/execute', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ slug: projectId, temp_db_name: tempDbName, strategies, preserve_keys: preserveKeys })
          });
          const data = await res.json();
          setRollbackId(data.operation_id); 
          setRestoreStep('done');
      } catch (e: any) { setError(e.message); setRestoreStep('strategy'); }
  };

  const handleDownloadBackup = async () => {
      setExporting(true);
      try {
          const res = await fetch(`/api/control/projects/${projectId}/export`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
          const blob = await res.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = `${projectId}_backup.caf`; document.body.appendChild(a); a.click(); window.URL.revokeObjectURL(url); document.body.removeChild(a);
      } catch (e) { alert("Download failed."); } finally { setExporting(false); }
  };

  return (
    <div className="p-8 lg:p-12 max-w-[1600px] mx-auto w-full space-y-12 pb-40">
        <div className="flex justify-between items-end">
            <div>
                <h1 className="text-5xl font-black text-slate-900 tracking-tighter mb-2">Time Machine</h1>
                <p className="text-slate-400 text-lg font-medium">Instant Rollback & Disaster Recovery</p>
            </div>
            <div className="flex gap-4">
                <button onClick={() => { setShowRestoreModal(true); setRestoreStep('upload'); setRestoreFile(null); }} className="bg-white border border-slate-200 text-slate-600 px-6 py-4 rounded-[2rem] font-black text-xs uppercase tracking-widest hover:bg-slate-50 transition-all flex items-center gap-3 shadow-sm">
                    <Upload size={18}/> Import .CAF
                </button>
                <button onClick={handleDownloadBackup} disabled={exporting} className="bg-slate-900 text-white px-6 py-4 rounded-[2rem] font-black text-xs uppercase tracking-widest hover:bg-indigo-600 transition-all flex items-center gap-3 shadow-xl active:scale-95 disabled:opacity-70">
                    {exporting ? <Loader2 size={18} className="animate-spin"/> : <Download size={18}/>} Export Now
                </button>
            </div>
        </div>

        <div className="flex bg-slate-100 p-1.5 rounded-2xl w-fit">
            <button onClick={() => setActiveTab('timeline')} className={`px-6 py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${activeTab === 'timeline' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-500'}`}>
                <History size={16}/> Timeline Snapshots
            </button>
            <button onClick={() => setActiveTab('policies')} className={`px-6 py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${activeTab === 'policies' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-500'}`}>
                <CalendarDays size={16}/> Scheduled Exports
            </button>
        </div>

        {activeTab === 'timeline' && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
                 {snapshots.length === 0 ? (
                     <div className="text-center py-20 bg-white rounded-[3rem] border border-slate-200 border-dashed">
                         <Clock size={48} className="mx-auto text-slate-200 mb-4"/>
                         <p className="text-slate-400 font-bold uppercase text-xs">No snapshots available. Deploy to create one.</p>
                     </div>
                 ) : (
                     <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                         {snapshots.map((snap) => (
                             <div key={snap.name} className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm hover:shadow-lg transition-all relative overflow-hidden group">
                                 <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform"><Database size={100}/></div>
                                 <div className="relative z-10">
                                     <div className="flex justify-between items-start mb-6">
                                         <div className="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center shadow-inner">
                                             <History size={24}/>
                                         </div>
                                         <div className="bg-slate-100 px-3 py-1 rounded-full text-[10px] font-black text-slate-500 uppercase tracking-widest">{snap.size}</div>
                                     </div>
                                     <h4 className="text-lg font-black text-slate-900 mb-1">System Snapshot</h4>
                                     <p className="text-xs text-slate-500 font-mono mb-6">{new Date(snap.created_at).toLocaleString()}</p>
                                     <button 
                                        onClick={() => { setSelectedSnapshot(snap); setShowRollbackModal(true); setRollbackMode('smart'); setQuarantineDb(''); setSuccess(null); setError(null); }}
                                        className="w-full py-4 border-2 border-indigo-100 text-indigo-600 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-indigo-600 hover:text-white transition-all flex items-center justify-center gap-2"
                                     >
                                         <RotateCcw size={14}/> Restore
                                     </button>
                                 </div>
                             </div>
                         ))}
                     </div>
                 )}
            </div>
        )}

        {activeTab === 'policies' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 animate-in fade-in slide-in-from-right-4">
                 <div className="lg:col-span-1 space-y-6">
                     {policies.map(p => {
                        const style = getProviderStyle(p.provider);
                        const isRenaming = renamingId === p.id;
                        return (
                         <div key={p.id} className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm transition-all hover:shadow-md group">
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
                     
                     <button onClick={() => { setShowWizard(true); setEditingPolicyId(null); setWizardStep(0); setWizardData(d => ({...d, name: ''})); }} className="w-full py-6 border-2 border-dashed border-slate-200 rounded-[2.5rem] text-slate-400 font-bold uppercase tracking-widest hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/30 transition-all flex items-center justify-center gap-2">
                        <Plus size={16}/> Nova Política
                     </button>
                 </div>
                 
                 <div className="lg:col-span-2 bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm h-[600px] overflow-auto custom-scrollbar">
                     <table className="w-full text-left">
                         <thead><tr className="border-b border-slate-100 text-[10px] uppercase text-slate-400 font-black tracking-widest"><th className="pb-4 pl-4">Date</th><th>Policy</th><th className="text-center">Status</th><th className="text-right">Size</th><th className="text-right pr-4">Action</th></tr></thead>
                         <tbody className="divide-y divide-slate-50">
                             {history.map(h => (
                                 <tr key={h.id} className="hover:bg-slate-50 transition-colors group">
                                     <td className="py-4 pl-4">
                                         <div className="flex flex-col">
                                            <span className="text-xs font-bold text-slate-700">{new Date(h.started_at).toLocaleDateString()}</span>
                                            <span className="text-[10px] text-slate-400 font-medium">{new Date(h.started_at).toLocaleTimeString()}</span>
                                         </div>
                                     </td>
                                     <td className="py-4">
                                        <div className="flex flex-col">
                                            <span className="text-xs font-bold text-indigo-900">{h.policy_name || 'Manual Backup'}</span>
                                            <span className="text-[10px] text-slate-400 font-medium uppercase">{h.policy_provider || 'System'}</span>
                                        </div>
                                     </td>
                                     <td className="py-4 text-center">
                                         <span className={`px-2 py-1 rounded text-[9px] font-black uppercase inline-flex items-center gap-1 ${h.status==='completed'?'bg-emerald-50 text-emerald-600': h.status==='failed' ? 'bg-rose-50 text-rose-600' : 'bg-amber-50 text-amber-600'}`}>
                                            {h.status==='completed' && <CheckCircle2 size={10}/>} {h.status}
                                         </span>
                                     </td>
                                     <td className="py-4 text-right text-xs font-mono text-slate-600">{h.file_size ? (h.file_size/1024/1024).toFixed(2)+' MB' : '-'}</td>
                                     <td className="py-4 pr-4 text-right">
                                        {h.status === 'completed' && (
                                            <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button onClick={() => handleDownload(h.id)} className="text-indigo-600 hover:bg-indigo-50 p-2 rounded-lg transition-colors"><Download size={16}/></button>
                                                <button onClick={() => setRestoreOffsiteModal({ active: true, id: h.id })} className="text-rose-600 hover:bg-rose-50 p-2 rounded-lg transition-colors"><RotateCcw size={16}/></button>
                                            </div>
                                        )}
                                     </td>
                                 </tr>
                             ))}
                         </tbody>
                     </table>
                 </div>
            </div>
        )}

        {/* ROLLBACK MODAL (SYSTEM SNAPSHOT) */}
        {showRollbackModal && (
            <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[900] flex items-center justify-center p-8 animate-in zoom-in-95">
                <div className="bg-white rounded-[3rem] w-full max-w-2xl p-10 shadow-2xl border border-slate-200 relative overflow-hidden">
                    
                    {rollbackLoading ? (
                        <div className="flex flex-col items-center justify-center py-20">
                            <RefreshCw size={64} className="text-indigo-600 animate-spin mb-6"/>
                            <h3 className="text-2xl font-black text-slate-900 mb-2">Restoring System...</h3>
                            <p className="text-slate-400 font-bold uppercase text-xs animate-pulse">
                                {rollbackMode === 'smart' ? 'Salvaging new data & swapping databases' : 'Performing hard reset'}
                            </p>
                        </div>
                    ) : success ? (
                        <div className="text-center py-10">
                            <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-6"><CheckCircle2 size={40}/></div>
                            <h3 className="text-2xl font-black text-slate-900 mb-4">Rollback Complete</h3>
                            <p className="text-slate-500 text-sm max-w-md mx-auto mb-6">
                                The system has been restored to <b>{new Date(selectedSnapshot.created_at).toLocaleString()}</b>.
                            </p>
                            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-left max-w-md mx-auto mb-8">
                                <h4 className="text-xs font-black text-slate-700 uppercase mb-2 flex items-center gap-2"><ShieldCheck size={14}/> Forensics Ready</h4>
                                <p className="text-[10px] text-slate-500 mb-1">The previous broken state was saved to:</p>
                                <code className="bg-white border border-slate-200 px-2 py-1 rounded text-[10px] font-mono block truncate">{quarantineDb}</code>
                            </div>
                        </div>
                    ) : (
                        <>
                            <button onClick={() => setShowRollbackModal(false)} className="absolute top-8 right-8 text-slate-300 hover:text-slate-900"><X size={24}/></button>
                            <div className="text-center mb-8">
                                <div className="w-16 h-16 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-inner"><RotateCcw size={32}/></div>
                                <h3 className="text-3xl font-black text-slate-900 tracking-tight">Confirm Rollback</h3>
                                <p className="text-xs text-slate-500 font-bold uppercase tracking-widest mt-2">Restoring to {new Date(selectedSnapshot.created_at).toLocaleString()}</p>
                            </div>

                            <div className="grid grid-cols-2 gap-4 mb-8">
                                <button 
                                    onClick={() => setRollbackMode('hard')}
                                    className={`p-6 rounded-[2rem] border-2 text-left transition-all relative overflow-hidden ${rollbackMode === 'hard' ? 'border-rose-500 bg-rose-50' : 'border-slate-100 hover:border-slate-200'}`}
                                >
                                    <div className="flex justify-between items-start mb-2">
                                        <Trash2 size={24} className={rollbackMode === 'hard' ? 'text-rose-600' : 'text-slate-400'}/>
                                        {rollbackMode === 'hard' && <CheckCircle2 size={18} className="text-rose-600"/>}
                                    </div>
                                    <h4 className={`font-black text-sm ${rollbackMode === 'hard' ? 'text-rose-900' : 'text-slate-700'}`}>Hard Reset</h4>
                                    <p className={`text-[10px] mt-1 font-medium ${rollbackMode === 'hard' ? 'text-rose-700' : 'text-slate-400'}`}>
                                        Discard any data created after this snapshot. Absolute state revert.
                                    </p>
                                </button>

                                <button 
                                    onClick={() => setRollbackMode('smart')}
                                    className={`p-6 rounded-[2rem] border-2 text-left transition-all relative overflow-hidden ${rollbackMode === 'smart' ? 'border-indigo-500 bg-indigo-50' : 'border-slate-100 hover:border-slate-200'}`}
                                >
                                    <div className="flex justify-between items-start mb-2">
                                        <GitMerge size={24} className={rollbackMode === 'smart' ? 'text-indigo-600' : 'text-slate-400'}/>
                                        {rollbackMode === 'smart' && <CheckCircle2 size={18} className="text-indigo-600"/>}
                                    </div>
                                    <h4 className={`font-black text-sm ${rollbackMode === 'smart' ? 'text-indigo-900' : 'text-slate-700'}`}>Smart Recovery</h4>
                                    <p className={`text-[10px] mt-1 font-medium ${rollbackMode === 'smart' ? 'text-indigo-700' : 'text-slate-400'}`}>
                                        Attempt to salvage new data rows and merge them into the restored version.
                                    </p>
                                </button>
                            </div>

                            {error && (
                                <div className="p-4 bg-rose-100 text-rose-700 rounded-2xl mb-6 text-xs font-bold flex items-center gap-3">
                                    <AlertTriangle size={18}/> {error}
                                </div>
                            )}

                            <div className="flex gap-4">
                                <button onClick={() => setShowRollbackModal(false)} className="flex-1 py-4 text-xs font-black text-slate-400 uppercase tracking-widest hover:bg-slate-50 rounded-2xl">Cancel</button>
                                <button onClick={handleRollback} className="flex-[2] bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-rose-600 transition-all flex items-center justify-center gap-2">
                                    <AlertOctagon size={16}/> Execute Rollback
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        )}

        {/* RESTORE OFFSITE MODAL */}
        {restoreOffsiteModal.active && (
            <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-[600] flex items-center justify-center p-8 animate-in zoom-in-95">
                <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl text-center border border-rose-100">
                    <div className="w-16 h-16 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center mx-auto mb-6"><AlertCircle size={32}/></div>
                    <h3 className="text-xl font-black text-slate-900 mb-2">Restauração de Sistema</h3>
                    <p className="text-xs text-slate-500 font-medium mb-6 leading-relaxed">
                        Atenção: Esta ação irá baixar o backup da nuvem e <b>sobrescrever</b> o banco de dados atual. Todos os dados recentes serão perdidos.
                    </p>
                    <input 
                        type="password" 
                        autoFocus
                        value={restoreOffsitePassword}
                        onChange={e => setRestoreOffsitePassword(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-center font-bold text-slate-900 outline-none mb-6 focus:ring-4 focus:ring-rose-500/10"
                        placeholder="Senha de Admin"
                    />
                    <button onClick={handleRestoreOffsite} disabled={restoringOffsite || !restoreOffsitePassword} className="w-full bg-rose-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-rose-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                        {restoringOffsite ? <Loader2 className="animate-spin"/> : <RotateCcw size={16}/>} Confirmar Regressão
                    </button>
                    <button onClick={() => { setRestoreOffsiteModal({ active: false, id: '' }); setRestoreOffsitePassword(''); }} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600">Cancelar</button>
                </div>
            </div>
        )}

        {/* FILE RESTORE (IMPORT) WIZARD */}
        {showRestoreModal && (
            <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-2xl z-[800] flex items-center justify-center p-8 animate-in fade-in duration-300">
                <div className="bg-white rounded-[3rem] w-full max-w-2xl p-10 shadow-2xl border border-slate-100 relative overflow-hidden flex flex-col max-h-[90vh]">
                    <div className="flex justify-between items-center mb-6">
                        <h3 className="text-2xl font-black text-slate-900 tracking-tight">File Recovery</h3>
                        <button onClick={() => setShowRestoreModal(false)} className="p-2 hover:bg-slate-100 rounded-full"><X size={20}/></button>
                    </div>

                    {restoreStep === 'upload' && (
                        <div className="space-y-6 text-center">
                            <div className="border-4 border-dashed border-slate-100 rounded-[2.5rem] p-12 hover:border-indigo-400 transition-all cursor-pointer relative">
                                <input type="file" onChange={(e) => setRestoreFile(e.target.files?.[0] || null)} className="absolute inset-0 opacity-0 cursor-pointer"/>
                                <Upload size={40} className="mx-auto text-slate-300 mb-4"/>
                                <p className="text-sm font-bold text-slate-600">{restoreFile ? restoreFile.name : 'Drop .CAF File Here'}</p>
                            </div>
                            <button onClick={handleUploadAnalyze} disabled={!restoreFile} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl disabled:opacity-50">
                                Analyze Snapshot
                            </button>
                        </div>
                    )}
                    
                    {restoreStep === 'analyze' && <div className="flex flex-col items-center justify-center py-20"><Loader2 size={60} className="text-indigo-600 animate-spin mb-4"/><h4 className="text-xl font-black text-slate-900">Analyzing...</h4></div>}
                    
                    {restoreStep === 'strategy' && (
                         <div className="flex-1 flex flex-col overflow-hidden">
                             <div className="bg-indigo-50 border border-indigo-100 p-4 rounded-2xl mb-6"><h4 className="text-sm font-bold text-indigo-900">Diff Report Ready</h4></div>
                             <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-4">
                                 {diffReport?.data_diff && Object.keys(diffReport.data_diff).map(table => (
                                     <div key={table} className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center justify-between">
                                         <div><h5 className="font-black text-sm text-slate-700">{table}</h5><div className="text-[10px] text-slate-500 mt-1">Live: {diffReport.data_diff[table].live_count} | Backup: {diffReport.data_diff[table].backup_count}</div></div>
                                         <select value={strategies[table]} onChange={(e) => setStrategies({...strategies, [table]: e.target.value})} className="text-xs font-bold px-3 py-2 rounded-lg outline-none border cursor-pointer bg-white"><option value="overwrite">Overwrite</option><option value="merge">Merge</option><option value="skip">Skip</option></select>
                                     </div>
                                 ))}
                             </div>
                             <div className="pt-6 mt-4"><button onClick={handleExecuteMigration} className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-700">Execute Migration</button></div>
                         </div>
                    )}
                    
                    {restoreStep === 'execute' && <div className="flex flex-col items-center justify-center py-20"><RefreshCw size={60} className="text-emerald-500 animate-spin mb-4"/><h4 className="text-xl font-black text-slate-900">Migrating...</h4></div>}
                    
                    {restoreStep === 'done' && <div className="text-center py-10"><div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-6"><CheckCircle2 size={40}/></div><h3 className="text-2xl font-black text-slate-900 mb-2">Success</h3><button onClick={() => setShowRestoreModal(false)} className="w-full py-4 bg-slate-100 text-slate-600 font-bold rounded-2xl text-xs uppercase tracking-widest hover:bg-slate-200">Close</button></div>}
                </div>
            </div>
        )}

        {/* POLICY CONFIG WIZARD (RESTORED FROM OLD) */}
        {showWizard && (
            <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in fade-in zoom-in-95 duration-300">
                <div className="bg-white rounded-[3rem] w-full max-w-3xl flex flex-col shadow-2xl overflow-hidden max-h-[90vh]">
                    <div className="p-10 pb-6 bg-slate-50 border-b border-slate-100">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-3xl font-black text-slate-900 tracking-tighter">
                                {editingPolicyId ? 'Editar Política' : (wizardStep === 0 ? 'Escolha o Provedor' : `Configurar ${PROVIDERS.find(p => p.id === wizardData.provider)?.name}`)}
                            </h3>
                            <button onClick={() => setShowWizard(false)} className="p-3 bg-white hover:bg-slate-200 rounded-full text-slate-400 transition-colors"><X size={20}/></button>
                        </div>
                        <div className="flex items-center gap-2">
                            {[0, 1, 2, 3, 4].map(idx => (
                                <div key={idx} className={`h-2 flex-1 rounded-full transition-all ${wizardStep >= idx ? 'bg-indigo-600' : 'bg-slate-200'}`}></div>
                            ))}
                        </div>
                        <div className="flex justify-between mt-2 text-[10px] font-black uppercase text-slate-400 tracking-widest px-1">
                            <span className={wizardStep >= 0 ? 'text-indigo-600' : ''}>Provedor</span>
                            <span className={wizardStep >= 1 ? 'text-indigo-600' : ''}>Credenciais</span>
                            <span className={wizardStep >= 2 ? 'text-indigo-600' : ''}>Validação</span>
                            <span className={wizardStep >= 3 ? 'text-indigo-600' : ''}>Agendamento</span>
                            <span className={wizardStep >= 4 ? 'text-indigo-600' : ''}>Retenção</span>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-10">
                        {wizardStep === 0 && (
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

                        {wizardStep === 1 && (
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
                                <div className="flex justify-between pt-4"><button onClick={() => setWizardStep(0)} className="text-slate-400 font-bold text-xs px-4">Voltar</button><button disabled={wizardData.provider === 'gdrive' ? !wizardData.serviceAccount : (!wizardData.bucket || !wizardData.accessKeyId)} onClick={() => setWizardStep(2)} className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl flex items-center gap-2">Próximo <ArrowRight size={14}/></button></div>
                            </div>
                        )}

                        {wizardStep === 2 && (
                            <div className="space-y-8 animate-in slide-in-from-right-4">
                                {wizardData.provider === 'gdrive' && (
                                    <div className="bg-indigo-50 border border-indigo-100 p-6 rounded-[2rem] text-center space-y-4">
                                        <p className="text-xs font-bold text-indigo-800 uppercase tracking-widest">Compartilhe sua pasta com este e-mail:</p>
                                        <div className="flex items-center gap-2 bg-white p-3 rounded-xl cursor-pointer" onClick={copyEmail}><code className="flex-1 text-center font-mono text-xs font-bold text-slate-700 truncate">{wizardData.serviceAccount.client_email}</code><Copy size={14} className="text-indigo-400"/></div>
                                        <div className="space-y-1"><label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">ID da Pasta</label><input value={wizardData.folderId} onChange={(e) => setWizardData((d:any) => ({...d, folderId: e.target.value}))} className="w-full bg-white border border-indigo-200 rounded-2xl py-3 px-4 text-sm font-bold outline-none text-center"/></div>
                                    </div>
                                )}
                                <div className="text-center"><button onClick={handleTestConnection} disabled={validating} className="px-8 py-3 rounded-2xl bg-slate-900 text-white font-bold text-xs uppercase tracking-widest hover:bg-indigo-600 transition-all shadow-lg">{validating ? <Loader2 size={16} className="animate-spin"/> : 'Testar Conexão'}</button>{validationMsg && <div className={`mt-4 p-4 rounded-xl text-xs font-bold ${validationSuccess ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{validationMsg}</div>}</div>
                                <div className="flex justify-between pt-4"><button onClick={() => setWizardStep(1)} className="text-slate-400 font-bold text-xs px-4">Voltar</button><button onClick={() => setWizardStep(3)} disabled={!validationSuccess} className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl flex items-center gap-2">Próximo <ArrowRight size={14}/></button></div>
                            </div>
                        )}

                        {wizardStep === 3 && (
                            <div className="space-y-8 animate-in slide-in-from-right-4">
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                                    {['monthly', 'weekly', 'daily', 'hourly'].map(freq => (
                                        <button key={freq} onClick={() => setWizardData((d:any) => ({...d, frequency: freq}))} className={`py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${wizardData.frequency === freq ? 'bg-indigo-600 text-white shadow-lg' : 'bg-slate-50 text-slate-400 hover:bg-slate-100'}`}>{freq}</button>
                                    ))}
                                </div>
                                <div className="bg-slate-50 border border-slate-200 rounded-[2rem] p-6 space-y-6">
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
                                <div className="flex justify-between pt-4"><button onClick={() => setWizardStep(2)} className="text-slate-400 font-bold text-xs px-4">Voltar</button><button onClick={() => setWizardStep(4)} className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl flex items-center gap-2">Próximo <ArrowRight size={14}/></button></div>
                            </div>
                        )}

                        {wizardStep === 4 && (
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
                                <div className="flex justify-between pt-4"><button onClick={() => setWizardStep(3)} className="text-slate-400 font-bold text-xs px-4">Voltar</button><button onClick={handleSavePolicy} className="bg-emerald-600 text-white px-10 py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl hover:bg-emerald-700 flex items-center gap-2"><CheckCircle2 size={16}/> {editingPolicyId ? 'Atualizar Política' : 'Confirmar & Ativar'}</button></div>
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
