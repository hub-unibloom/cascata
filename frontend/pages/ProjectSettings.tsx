
import React, { useState, useEffect, useRef } from 'react';
import { 
  Shield, Key, Globe, Lock, Save, Loader2, CheckCircle2, Copy, 
  Terminal, Eye, EyeOff, RefreshCw, Code, BookOpen, AlertTriangle,
  Server, ExternalLink, Plus, X, Link, CloudLightning, FileText, Info, Trash2,
  Archive, Download, Upload, HardDrive, FileJson, Database, Zap, Network, Scale,
  Smartphone, MessageSquare, Clock, RotateCcw, Calendar, Play, Vault,
  Folder, FolderPlus, FileKey, FileCode, ChevronRight, LockKeyhole, ShieldCheck, FileUp,
  ScanEye, Settings2
} from 'lucide-react';

const ProjectSettings: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [project, setProject] = useState<any>(null);
  const [customDomain, setCustomDomain] = useState('');
  const [availableCerts, setAvailableCerts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Database Config State
  const [dbConfig, setDbConfig] = useState<{ maxConnections: number, idleTimeout: number, statementTimeout: number }>({
      maxConnections: 10,
      idleTimeout: 60,
      statementTimeout: 15000 // Default 15s
  });

  // Timezone
  const [timezone, setTimezone] = useState('UTC');

  // BYOD / Ejection State
  const [isEjected, setIsEjected] = useState(false);
  const [externalDbUrl, setExternalDbUrl] = useState('');
  const [readReplicaUrl, setReadReplicaUrl] = useState('');

  // Firebase State
  const [firebaseJson, setFirebaseJson] = useState('');
  const [hasFirebase, setHasFirebase] = useState(false);

  // Security State
  const [revealedKeyValues, setRevealedKeyValues] = useState<Record<string, string>>({});

  // Origins State
  const [origins, setOrigins] = useState<any[]>([]);
  const [newOrigin, setNewOrigin] = useState('');

  // Verification Modal State
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyPassword, setVerifyPassword] = useState('');
  
  // Vault State
  const [showVault, setShowVault] = useState(false);
  const [isVaultUnlocked, setIsVaultUnlocked] = useState(false);
  const [vaultPath, setVaultPath] = useState<{id: string, name: string}[]>([]); // Breadcrumbs
  const [vaultItems, setVaultItems] = useState<any[]>([]);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [showNewSecret, setShowNewSecret] = useState(false);
  const [newSecretData, setNewSecretData] = useState({ name: '', type: 'key', value: '', description: '', mime: 'text/plain' });
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  type SecurityIntent = 
    | { type: 'REVEAL_KEY', keyType: string }
    | { type: 'ROTATE_KEY', keyType: string }
    | { type: 'DELETE_DOMAIN' }
    | { type: 'UNLOCK_VAULT' }; 

  const [pendingIntent, setPendingIntent] = useState<SecurityIntent | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);

  // Backup State
  const [exporting, setExporting] = useState(false);

  // --- UI LOGIC ---
  const isInputDirty = customDomain !== (project?.custom_domain || '');
  
  const bestCertMatch = availableCerts.find(cert => {
      if (cert === customDomain) return true;
      if (cert.startsWith('*.')) {
          const root = cert.slice(2);
          if (customDomain.endsWith(root)) {
              const domainParts = customDomain.split('.');
              const rootParts = root.split('.');
              return domainParts.length === rootParts.length + 1;
          }
      }
      return false;
  });

  const copyToClipboard = (text: string) => {
    if (!text) return;
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text)
            .then(() => { setSuccess("Copiado!"); setTimeout(() => setSuccess(null), 2000); })
            .catch(() => alert("Erro ao copiar (HTTPS)."));
        return;
    }
    try {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        setSuccess("Copiado!");
        setTimeout(() => setSuccess(null), 2000);
    } catch (err) { alert("Erro ao copiar."); }
  };

  const fetchProject = async () => {
    try {
        const res = await fetch('/api/control/projects', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
        });
        const data = await res.json();
        const current = data.find((p: any) => p.slug === projectId);
        
        if (current) {
            setProject(current);
            setCustomDomain(current.custom_domain || '');
            
            const rawOrigins = current.metadata?.allowed_origins || [];
            setOrigins(rawOrigins.map((o: any) => typeof o === 'string' ? { url: o, require_auth: true } : o));

            // Load Timezone
            setTimezone(current.metadata?.timezone || 'UTC');

            if (current.metadata?.db_config) {
                setDbConfig({
                    maxConnections: current.metadata.db_config.maxConnections || 10,
                    idleTimeout: current.metadata.db_config.idleTimeout || 60,
                    statementTimeout: current.metadata.db_config.statementTimeout || 15000
                });
            }

            // Load BYOD State
            if (current.metadata?.external_db_url) {
                setIsEjected(true);
                setExternalDbUrl(current.metadata.external_db_url);
                setReadReplicaUrl(current.metadata.read_replica_url || '');
            } else {
                setIsEjected(false);
                setExternalDbUrl('');
                setReadReplicaUrl('');
            }

            if (current.metadata?.firebase_config) {
                setHasFirebase(true);
            }
        }
        
        fetchAvailableCerts();
    } catch (e) {
        console.error("Failed to sync project settings");
    } finally {
        setLoading(false);
    }
  };

  const fetchAvailableCerts = async () => {
    try {
        const certRes = await fetch('/api/control/system/certificates/status', {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
        });
        const certData = await certRes.json();
        setAvailableCerts(certData.domains || []);
    } catch(e) { console.error("Cert list failed"); }
  };

  // --- VAULT LOGIC ---
  const fetchVaultItems = async (parentId: string | null = null) => {
      setVaultLoading(true);
      try {
          const res = await fetch(`/api/control/projects/${projectId}/vault?parentId=${parentId || 'root'}`, {
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          const data = await res.json();
          setVaultItems(data);
      } catch (e) { alert("Failed to load vault"); }
      finally { setVaultLoading(false); }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
          const base64 = event.target?.result as string;
          // Format: data:mime/type;base64,RAWDATA
          const parts = base64.split(',');
          const mime = parts[0].match(/:(.*?);/)?.[1] || 'application/octet-stream';
          const rawData = parts[1]; // Store only the raw base64 data

          setNewSecretData(prev => ({
              ...prev,
              name: prev.name || file.name,
              value: rawData,
              mime: mime,
              type: 'file'
          }));
      };
      reader.readAsDataURL(file);
  };

  const handleCreateSecret = async () => {
      if (!newSecretData.name) return;
      try {
          const currentFolder = vaultPath.length > 0 ? vaultPath[vaultPath.length - 1].id : 'root';
          const res = await fetch(`/api/control/projects/${projectId}/vault`, {
              method: 'POST',
              headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
              },
              body: JSON.stringify({
                  ...newSecretData,
                  parent_id: currentFolder,
                  metadata: { mime: newSecretData.mime, is_file: newSecretData.type === 'file' }
              })
          });
          
          if (!res.ok) throw new Error((await res.json()).error);
          
          setSuccess(newSecretData.type === 'folder' ? "Folder created" : "Secret stored safely");
          setShowNewSecret(false);
          setNewSecretData({ name: '', type: 'key', value: '', description: '', mime: 'text/plain' });
          fetchVaultItems(currentFolder === 'root' ? null : currentFolder);
      } catch (e: any) { alert(e.message); }
  };

  const handleRevealSecret = async (item: any) => {
      try {
          const res = await fetch(`/api/control/projects/${projectId}/vault/${item.id}/reveal`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          const data = await res.json();
          
          if (item.type === 'file' || data.meta?.is_file) {
              // Download logic for files
              const mime = data.meta?.mime || 'application/octet-stream';
              const link = document.createElement('a');
              link.href = `data:${mime};base64,${data.value}`;
              link.download = item.name;
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
              setSuccess("File decrypted & downloading...");
          } else {
              // Standard Copy for text
              copyToClipboard(data.value);
              setSuccess("Secret decrypted & copied (Audit Logged)");
          }
      } catch (e) { alert("Failed to decrypt."); }
  };

  const handleDeleteSecret = async (id: string) => {
      if (!confirm("Are you sure? This action is irreversible.")) return;
      try {
          await fetch(`/api/control/projects/${projectId}/vault/${id}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          const currentFolder = vaultPath.length > 0 ? vaultPath[vaultPath.length - 1].id : null;
          fetchVaultItems(currentFolder);
      } catch (e) { alert("Failed to delete."); }
  };

  useEffect(() => { fetchProject(); }, [projectId]);

  // --- ACTIONS ---

  const handleVerifyAndExecute = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!verifyPassword) { alert("Digite a senha."); return; }
    if (!pendingIntent) return;

    setVerifyLoading(true);
    
    // Handling Standard Security Actions
    if (pendingIntent.type !== 'UNLOCK_VAULT') {
        try {
            if (pendingIntent.type === 'REVEAL_KEY') {
                const keyType = pendingIntent.keyType === 'service' ? 'service_key' : pendingIntent.keyType === 'anon' ? 'anon_key' : 'jwt_secret';
                const res = await fetch(`/api/control/projects/${projectId}/reveal-key`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                    body: JSON.stringify({ password: verifyPassword, keyType: keyType })
                });
                const data = await res.json();
                if (!res.ok) { alert(data.error || "Senha incorreta."); } else {
                    setRevealedKeyValues(prev => ({ ...prev, [pendingIntent.keyType]: data.key }));
                    setTimeout(() => { setRevealedKeyValues(prev => { const updated = { ...prev }; delete updated[pendingIntent.keyType]; return updated; }); }, 60000);
                    setShowVerifyModal(false); setVerifyPassword('');
                }
            } else {
                const verifyRes = await fetch('/api/control/auth/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
                    body: JSON.stringify({ password: verifyPassword })
                });

                if (!verifyRes.ok) { alert("Senha incorreta."); setVerifyLoading(false); return; }

                setShowVerifyModal(false); 
                setVerifyPassword('');

                if (pendingIntent.type === 'ROTATE_KEY') await executeRotateKey(pendingIntent.keyType);
                else if (pendingIntent.type === 'DELETE_DOMAIN') await executeDeleteDomain();
            }
        } catch (e) { alert("Erro de conexão."); } 
        finally { setVerifyLoading(false); setPendingIntent(null); }
        return;
    }

    // Vault Unlock Logic
    try {
        const verifyRes = await fetch('/api/control/auth/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
            body: JSON.stringify({ password: verifyPassword })
        });

        if (!verifyRes.ok) { 
            alert("Acesso Negado: Senha Incorreta."); 
        } else {
            setIsVaultUnlocked(true);
            setShowVault(true);
            fetchVaultItems(); // Load root
            setShowVerifyModal(false);
            setVerifyPassword('');
        }
    } catch (e) { alert("Erro ao verificar senha."); }
    finally { setVerifyLoading(false); setPendingIntent(null); }
  };

  const executeRotateKey = async (type: string) => {
    setRotating(type);
    try {
      await fetch(`/api/control/projects/${projectId}/rotate-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }, body: JSON.stringify({ type }) });
      await fetchProject();
      setSuccess(`${type.toUpperCase()} rotacionada.`);
      const next = { ...revealedKeyValues }; delete next[type.replace('_key', '').replace('_secret', '')]; setRevealedKeyValues(next);
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) { alert('Falha ao rotacionar chave.'); } finally { setRotating(null); }
  };

  const executeDeleteDomain = async () => {
      setSaving(true);
      try {
          const res = await fetch(`/api/control/projects/${projectId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
            body: JSON.stringify({ custom_domain: null })
          });
          
          if (res.ok) {
              setSuccess('Domínio desvinculado.');
              setProject((prev: any) => ({ ...prev, custom_domain: null }));
              setCustomDomain('');
              setTimeout(() => { fetchProject(); setSuccess(null); }, 1500);
          }
      } catch(e) { 
          alert('Erro ao remover domínio.'); 
      } finally { 
          setSaving(false); 
      }
  };

  const handleUpdateSettings = async (overrideOrigins?: any[]) => {
    setSaving(true);
    try {
      // Validate External DB if ejected
      if (isEjected) {
          if (!externalDbUrl.startsWith('postgres://') && !externalDbUrl.startsWith('postgresql://')) {
              throw new Error("External DB URL must start with postgres:// or postgresql://");
          }
          if (readReplicaUrl && !readReplicaUrl.startsWith('postgres')) {
              throw new Error("Read Replica URL invalid format");
          }
      }

      const payload: any = { custom_domain: customDomain };
      
      const metaUpdate: any = { 
          db_config: dbConfig,
          // Timezone is read-only here, not sent back
          external_db_url: isEjected ? externalDbUrl : null,
          read_replica_url: isEjected && readReplicaUrl ? readReplicaUrl : null
      };
      
      if (overrideOrigins) metaUpdate.allowed_origins = overrideOrigins;
      
      payload.metadata = metaUpdate;

      const res = await fetch(`/api/control/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
        body: JSON.stringify(payload)
      });
      
      if (!res.ok) throw new Error((await res.json()).error);

      setSuccess('Configuração salva. Migração de dados (se necessária) concluída.');
      if (!overrideOrigins) fetchProject(); 
      setTimeout(() => setSuccess(null), 3000);
    } catch (e: any) { 
        alert(e.message || 'Erro ao salvar/migrar.'); 
    } finally { 
        setSaving(false); 
    }
  };

  const handleSaveFirebase = async () => {
      setSaving(true);
      try {
          let firebaseConfig;
          try {
              firebaseConfig = JSON.parse(firebaseJson);
          } catch(e) {
              throw new Error("JSON Inválido.");
          }

          if (!firebaseConfig.project_id || !firebaseConfig.private_key || !firebaseConfig.client_email) {
              throw new Error("JSON incompleto. Requer project_id, private_key, e client_email.");
          }

          const newMeta = { ...project.metadata, firebase_config: firebaseConfig };
          
          await fetch(`/api/control/projects/${projectId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ metadata: newMeta })
          });

          setSuccess("FCM Configurado com sucesso!");
          setHasFirebase(true);
          setFirebaseJson(''); // Clear input for security
          fetchProject();
          setTimeout(() => setSuccess(null), 2000);
      } catch (e: any) {
          alert(e.message);
      } finally {
          setSaving(false);
      }
  };

  const toggleSchemaExposure = async () => {
      if (!project) return;
      setSaving(true);
      try {
          const current = project.metadata?.schema_exposure || false;
          const newMetadata = { ...project.metadata, schema_exposure: !current };
          
          const res = await fetch(`/api/control/projects/${projectId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: JSON.stringify({ metadata: newMetadata })
          });

          if (res.ok) {
              setProject({ ...project, metadata: newMetadata });
              setSuccess(!current ? "Discovery Enabled (Public Swagger)" : "Discovery Disabled (Secure Mode)");
              setTimeout(() => setSuccess(null), 2000);
          }
      } catch (e) {
          alert("Falha ao atualizar.");
      } finally {
          setSaving(false);
      }
  };

  const addOrigin = () => {
    if (!newOrigin) return;
    try { new URL(newOrigin); } catch { alert('URL inválida.'); return; }
    const updated = [...origins, { url: newOrigin, require_auth: true }];
    setOrigins(updated); setNewOrigin(''); handleUpdateSettings(updated);
  };

  const removeOrigin = (url: string) => {
    const updated = origins.filter(o => o.url !== url);
    setOrigins(updated); handleUpdateSettings(updated);
  };

  const handleDownloadBackup = async () => {
      setExporting(true);
      try {
          const res = await fetch(`/api/control/projects/${projectId}/export`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` } });
          if (!res.ok) throw new Error("Download failed");
          const blob = await res.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = `${project.slug}_backup.caf`; document.body.appendChild(a); a.click(); window.URL.revokeObjectURL(url); document.body.removeChild(a);
      } catch (e) { alert("Erro ao baixar backup."); } finally { setExporting(false); }
  };

  // --- UI HANDLERS ---
  const handleRevealClick = (keyType: string) => {
      if (revealedKeyValues[keyType]) {
          const next = { ...revealedKeyValues }; delete next[keyType]; setRevealedKeyValues(next); return;
      }
      setPendingIntent({ type: 'REVEAL_KEY', keyType }); setShowVerifyModal(true);
  };
  const handleRotateClick = (keyType: string) => { setPendingIntent({ type: 'ROTATE_KEY', keyType }); setShowVerifyModal(true); };
  
  const handleSaveDomainClick = () => {
      if (!customDomain) { alert("Digite um domínio."); return; }
      handleUpdateSettings();
  };

  const handleDeleteDomainClick = () => {
      setPendingIntent({ type: 'DELETE_DOMAIN' });
      setShowVerifyModal(true);
  };

  const handleOpenVault = () => {
      if (isVaultUnlocked) {
          setShowVault(true);
          fetchVaultItems();
      } else {
          setPendingIntent({ type: 'UNLOCK_VAULT' });
          setShowVerifyModal(true);
      }
  };

  if (loading) return <div className="p-20 flex justify-center"><Loader2 className="animate-spin text-indigo-600" /></div>;

  const apiEndpoint = project?.custom_domain ? `https://${project.custom_domain}` : `${window.location.origin}/api/data/${project?.slug}`;
  const sdkCode = `import { createClient } from './lib/cascata-sdk';\nconst cascata = createClient('${apiEndpoint}', '${project?.anon_key || 'anon_key'}');`;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8 pb-40">
      {success && <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[500] p-5 rounded-3xl bg-indigo-600 text-white shadow-2xl flex items-center gap-4 animate-bounce"><CheckCircle2 size={20} /><span className="text-sm font-black uppercase tracking-tight">{success}</span></div>}

      {/* HEADER: DATA SOVEREIGNTY - FEATURE CARD */}
      <div className="bg-slate-900 border border-slate-800 rounded-[3.5rem] p-10 shadow-2xl relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-16 opacity-5 group-hover:scale-110 transition-transform duration-700"><Archive size={200} className="text-white" /></div>
          <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
              <div>
                  <h3 className="text-3xl font-black text-white tracking-tight flex items-center gap-4 mb-2"><div className="w-14 h-14 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><HardDrive size={24} /></div>Data Sovereignty</h3>
                  <p className="text-slate-400 font-medium max-w-xl text-sm leading-relaxed mb-4">Generate a cryptographic snapshot (.CAF) containing your Database, Vectors, and Storage assets. For Automated Backups, use the dedicated Backups page.</p>
              </div>
              <button onClick={handleDownloadBackup} disabled={exporting} className="bg-white text-slate-900 px-8 py-4 rounded-3xl font-black text-xs uppercase tracking-widest hover:bg-indigo-50 transition-all flex items-center gap-3 shadow-xl active:scale-95 disabled:opacity-70">
                  {exporting ? <Loader2 size={18} className="animate-spin text-indigo-600"/> : <Download size={18} className="text-indigo-600" />}Download Snapshot
              </button>
          </div>
      </div>

      {/* BENTO GRID LAYOUT */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        
        {/* COL 1: CONNECTION & KEYS & VAULT */}
        <div className="xl:col-span-1 space-y-8">
            {/* Keys Card */}
            <div className="bg-white border border-slate-200 rounded-[3rem] p-8 shadow-sm h-fit">
                <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3 mb-6"><Key size={20} className="text-indigo-600"/> API Keys</h3>
                <div className="space-y-6">
                    <KeyControl label="Anon Key" value={project?.anon_key || '******'} isSecret={false} isRevealed={true} onCopy={() => copyToClipboard(project?.anon_key)} onRotate={() => handleRotateClick('anon')} />
                    <KeyControl label="Service Key (Root)" value={revealedKeyValues['service'] || '••••••••••••••••'} isSecret={true} isRevealed={!!revealedKeyValues['service']} onReveal={() => handleRevealClick('service')} onRotate={() => handleRotateClick('service')} onCopy={() => copyToClipboard(revealedKeyValues['service'])} />
                    <KeyControl label="JWT Secret" value={revealedKeyValues['jwt_secret'] || '••••••••••••••••'} isSecret={true} isRevealed={!!revealedKeyValues['jwt_secret']} onReveal={() => handleRevealClick('jwt_secret')} onRotate={() => handleRotateClick('jwt_secret')} onCopy={() => copyToClipboard(revealedKeyValues['jwt_secret'])} />
                </div>
            </div>

            {/* SECURE VAULT CARD (NEW) */}
            <button 
                onClick={handleOpenVault}
                className="w-full bg-slate-950 border border-slate-800 rounded-[3rem] p-8 shadow-2xl relative overflow-hidden group text-left"
            >
                <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:scale-125 transition-transform"><Vault size={80} className="text-amber-500"/></div>
                <div className="relative z-10">
                    <h3 className="text-xl font-black text-white tracking-tight flex items-center gap-3 mb-2"><LockKeyhole size={20} className="text-amber-500"/> Secure Vault</h3>
                    <p className="text-slate-400 text-xs font-medium">Encrypted storage for certificates, tokens, and secrets.</p>
                    <div className="mt-6 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-amber-500 bg-amber-500/10 px-3 py-1.5 rounded-xl w-fit">
                        {isVaultUnlocked ? 'UNLOCKED' : 'LOCKED • ADMIN ACCESS ONLY'}
                    </div>
                </div>
            </button>

            {/* SDK Helper */}
            <div className="bg-slate-900 border border-slate-800 rounded-[3rem] p-8 shadow-lg relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:scale-125 transition-transform"><Terminal size={100} className="text-white"/></div>
                <h3 className="text-xl font-black text-white tracking-tight flex items-center gap-3 mb-4 relative z-10"><Code size={20} className="text-emerald-400"/> Quick Connect</h3>
                <div className="relative z-10 group/code">
                    <pre className="bg-black/30 p-4 rounded-2xl text-[10px] text-emerald-400 font-mono overflow-x-auto whitespace-pre-wrap">{sdkCode}</pre>
                    <button onClick={() => copyToClipboard(sdkCode)} className="absolute top-2 right-2 p-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-white opacity-0 group-hover/code:opacity-100 transition-opacity"><Copy size={14}/></button>
                </div>
            </div>
        </div>

        {/* COL 2: INFRASTRUCTURE & DOMAIN */}
        <div className="xl:col-span-2 space-y-8">
            
            {/* Global Limits & Localization */}
            <div className="bg-white border border-slate-200 rounded-[4rem] p-12 shadow-sm relative overflow-hidden">
                <h3 className="text-2xl font-black text-slate-900 tracking-tight mb-8 flex items-center gap-4">
                    <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shadow-lg"><Database size={20} /></div>
                    Infrastructure & Localization
                </h3>
                <p className="text-slate-400 text-sm font-medium mb-6">
                    Hard Cap for total database connections across all tenants. Prevents Node.js from overwhelming the Postgres instance.
                </p>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                     <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 mb-2 block">Global Connection Cap</label>
                        <div className="flex gap-4 items-center">
                            <input 
                                type="number" 
                                min="10"
                                value={dbConfig.maxConnections} 
                                onChange={(e) => setDbConfig({...dbConfig, maxConnections: parseInt(e.target.value)})} 
                                className="w-full bg-slate-50 border border-slate-100 rounded-[1.8rem] py-5 px-8 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-blue-500/10 transition-all text-center" 
                            />
                        </div>
                     </div>
                     
                     <div>
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 mb-2 block">Project Timezone</label>
                        {/* IMMUTABLE TIMEZONE DISPLAY */}
                        <div className="w-full bg-slate-100 border border-slate-200 rounded-[1.8rem] py-5 px-8 flex items-center justify-between group cursor-not-allowed">
                            <span className="text-sm font-bold text-slate-500">{timezone}</span>
                            <Lock size={16} className="text-slate-400 group-hover:text-amber-500 transition-colors" />
                        </div>
                        <p className="text-[9px] text-slate-400 mt-2 px-2">
                           Immutable. Defined at instance creation to ensure data integrity.
                        </p>
                     </div>
                </div>

                <div className="mt-8">
                     <button 
                        onClick={() => handleUpdateSettings()} 
                        disabled={saving}
                        className="bg-blue-600 text-white px-10 py-5 rounded-[1.8rem] font-black uppercase tracking-widest text-xs flex items-center justify-center hover:bg-blue-700 transition-all shadow-xl disabled:opacity-50 w-full md:w-auto"
                    >
                        {saving ? <Loader2 className="animate-spin" size={16}/> : 'Apply Configuration'}
                    </button>
                </div>
            </div>

            {/* DOMAIN CONFIG */}
            <div className="bg-white border border-slate-200 rounded-[4rem] p-12 shadow-sm relative overflow-hidden">
                <div className="absolute top-0 right-0 p-10 opacity-5"><Globe size={160}/></div>
                <h3 className="text-2xl font-black text-slate-900 tracking-tight mb-8 flex items-center gap-4">
                   <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center shadow-lg"><Globe size={20} /></div> Custom Domain
                </h3>
                
                <div className="flex gap-4 items-center mb-6">
                    <input 
                       value={customDomain} 
                       onChange={(e) => setCustomDomain(e.target.value)} 
                       placeholder="api.my-app.com" 
                       className={`flex-1 bg-slate-50 border ${project?.custom_domain ? 'border-emerald-200 text-emerald-800' : 'border-slate-100'} rounded-[1.8rem] py-5 px-8 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-emerald-500/10 transition-all`}
                       disabled={project?.custom_domain}
                    />
                    {project?.custom_domain ? (
                        <button onClick={handleDeleteDomainClick} className="bg-rose-50 text-rose-600 p-5 rounded-[1.8rem] hover:bg-rose-100 transition-all"><Trash2 size={20}/></button>
                    ) : (
                        <button onClick={handleSaveDomainClick} disabled={saving || !customDomain} className="bg-emerald-600 text-white px-8 py-5 rounded-[1.8rem] font-black uppercase tracking-widest text-xs shadow-xl hover:bg-emerald-700 transition-all disabled:opacity-50">{saving ? <Loader2 className="animate-spin" size={16}/> : 'Connect'}</button>
                    )}
                </div>

                {project?.custom_domain && (
                    <div className={`p-6 rounded-[2.5rem] flex items-center gap-4 ${bestCertMatch ? 'bg-emerald-50 border border-emerald-100' : 'bg-amber-50 border border-amber-100'}`}>
                        {bestCertMatch ? <CheckCircle2 size={24} className="text-emerald-500"/> : <AlertTriangle size={24} className="text-amber-500"/>}
                        <div>
                            <h4 className={`font-bold text-sm ${bestCertMatch ? 'text-emerald-900' : 'text-amber-900'}`}>{bestCertMatch ? 'SSL Certificate Active' : 'No Valid Certificate Found'}</h4>
                            <p className="text-[10px] opacity-80 mt-1">{bestCertMatch ? `Secured by: ${bestCertMatch}` : 'Add a certificate matching this domain in System Settings > Vault.'}</p>
                        </div>
                    </div>
                )}
            </div>

            {/* FIREBASE CONFIG */}
            <div className="bg-white border border-slate-200 rounded-[4rem] p-12 shadow-sm relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-10 opacity-5 group-hover:scale-110 transition-transform"><CloudLightning size={160}/></div>
                <h3 className="text-2xl font-black text-slate-900 tracking-tight mb-8 flex items-center gap-4">
                   <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center shadow-lg"><CloudLightning size={20} /></div> Mobile Push (FCM)
                </h3>
                
                <div className="space-y-6 relative z-10">
                    <p className="text-slate-400 text-sm font-medium">Paste your Firebase Service Account JSON to enable the Push Engine.</p>
                    {hasFirebase ? (
                        <div className="bg-emerald-50 border border-emerald-100 p-6 rounded-[2rem] flex items-center justify-between">
                            <div className="flex items-center gap-4">
                                <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center text-emerald-600"><CheckCircle2 size={20}/></div>
                                <div><h4 className="font-bold text-emerald-900 text-sm">FCM Configured</h4><p className="text-[10px] text-emerald-700">Push Notifications are active.</p></div>
                            </div>
                            <button onClick={() => setHasFirebase(false)} className="text-[10px] font-bold text-emerald-600 hover:text-emerald-800 uppercase tracking-widest">Update</button>
                        </div>
                    ) : (
                        <>
                            <textarea 
                                value={firebaseJson}
                                onChange={(e) => setFirebaseJson(e.target.value)}
                                className="w-full h-32 bg-slate-50 border border-slate-100 rounded-[1.8rem] p-6 text-xs font-mono text-slate-600 outline-none focus:ring-4 focus:ring-amber-500/10 resize-none"
                                placeholder='{ "type": "service_account", "project_id": "..." }'
                            />
                            <button onClick={handleSaveFirebase} disabled={saving || !firebaseJson} className="bg-amber-500 text-white px-8 py-4 rounded-[1.8rem] font-black uppercase tracking-widest text-xs shadow-xl hover:bg-amber-600 transition-all disabled:opacity-50 w-full md:w-auto">
                                {saving ? <Loader2 className="animate-spin" size={16}/> : 'Activate Push Engine'}
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* BYOD / EXTERNAL DB */}
            <div className="bg-white border border-slate-200 rounded-[4rem] p-12 shadow-sm relative overflow-hidden">
                 <h3 className="text-2xl font-black text-slate-900 tracking-tight mb-8 flex items-center gap-4">
                   <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center shadow-lg"><Server size={20} /></div> Bring Your Own Database
                </h3>
                
                <div className="flex items-center gap-4 mb-6 p-4 bg-slate-50 rounded-[2rem]">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-widest flex-1">Eject from Managed DB</span>
                    <button 
                        onClick={() => setIsEjected(!isEjected)}
                        className={`w-14 h-8 rounded-full p-1 transition-colors ${isEjected ? 'bg-indigo-600' : 'bg-slate-300'}`}
                    >
                        <div className={`w-6 h-6 bg-white rounded-full shadow-md transition-transform ${isEjected ? 'translate-x-6' : ''}`}></div>
                    </button>
                </div>

                {isEjected && (
                    <div className="space-y-6 animate-in slide-in-from-top-4">
                        <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">External Connection String</label>
                            <input 
                                value={externalDbUrl} 
                                onChange={(e) => setExternalDbUrl(e.target.value)} 
                                className="w-full bg-indigo-50/50 border border-indigo-100 rounded-[1.8rem] py-5 px-8 text-sm font-bold text-indigo-900 outline-none focus:ring-4 focus:ring-indigo-500/10" 
                                placeholder="postgres://user:pass@host:5432/db"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Read Replica (Optional)</label>
                            <input 
                                value={readReplicaUrl} 
                                onChange={(e) => setReadReplicaUrl(e.target.value)} 
                                className="w-full bg-slate-50 border border-slate-100 rounded-[1.8rem] py-5 px-8 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10" 
                                placeholder="postgres://replica-host:5432/db"
                            />
                        </div>
                        <button onClick={() => handleUpdateSettings()} disabled={saving} className="bg-indigo-600 text-white px-8 py-4 rounded-[1.8rem] font-black uppercase tracking-widest text-xs shadow-xl hover:bg-indigo-700 transition-all disabled:opacity-50 w-full md:w-auto">
                           {saving ? <Loader2 className="animate-spin" size={16}/> : 'Connect & Migrate'}
                        </button>
                        <p className="text-[10px] text-indigo-400 font-bold px-2 mt-2">
                            Note: Migration will install required extensions (pgcrypto, uuid-ossp) and setup schemas.
                        </p>
                    </div>
                )}
            </div>

            {/* SECURITY (CORS & DISCOVERY) */}
            <div className="bg-white border border-slate-200 rounded-[4rem] p-12 shadow-sm">
                <h3 className="text-2xl font-black text-slate-900 tracking-tight mb-8 flex items-center gap-4">
                   <div className="w-12 h-12 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center shadow-lg"><Shield size={20} /></div> Security Perimeter
                </h3>

                <div className="space-y-8">
                     {/* Schema Exposure Toggle */}
                     <div className="flex items-center justify-between p-4 bg-slate-50 rounded-[2rem] border border-slate-100">
                        <div>
                            <h4 className="font-bold text-slate-900 text-sm">API Schema Discovery</h4>
                            <p className="text-[10px] text-slate-400 font-medium">Expose OpenAPI/Swagger specs publicly for low-code tools.</p>
                        </div>
                        <button 
                            onClick={toggleSchemaExposure}
                            className={`w-12 h-7 rounded-full p-1 transition-colors ${project?.metadata?.schema_exposure ? 'bg-emerald-500' : 'bg-slate-300'}`}
                        >
                            <div className={`w-5 h-5 bg-white rounded-full shadow-md transition-transform ${project?.metadata?.schema_exposure ? 'translate-x-5' : ''}`}></div>
                        </button>
                     </div>

                     {/* Origins Manager */}
                     <div className="space-y-4">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Allowed Origins (CORS)</label>
                        <div className="flex gap-2">
                            <input value={newOrigin} onChange={(e) => setNewOrigin(e.target.value)} placeholder="https://myapp.com" className="flex-1 bg-slate-50 border border-slate-100 rounded-2xl py-3 px-6 text-xs font-bold outline-none"/>
                            <button onClick={addOrigin} className="bg-slate-900 text-white p-3 rounded-2xl hover:bg-slate-700 transition-all"><Plus size={16}/></button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {origins.length === 0 && <span className="text-xs text-slate-300 font-medium italic p-2">All origins allowed (Dev Mode)</span>}
                            {origins.map((o, i) => (
                                <div key={i} className="flex items-center gap-2 bg-white border border-slate-200 px-3 py-1.5 rounded-xl text-xs font-bold text-slate-600 shadow-sm">
                                    {o.url}
                                    <button onClick={() => removeOrigin(o.url)} className="text-rose-400 hover:text-rose-600"><X size={12}/></button>
                                </div>
                            ))}
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
               <h3 className="text-xl font-black text-slate-900 mb-2">Confirmação de Segurança</h3>
               <p className="text-xs text-slate-500 font-bold mb-8">Digite sua senha atual para autorizar esta alteração crítica.</p>
               <form onSubmit={handleVerifyAndExecute}>
                   <input 
                     type="password" 
                     autoFocus
                     value={verifyPassword}
                     onChange={e => setVerifyPassword(e.target.value)}
                     className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-center font-bold text-slate-900 outline-none mb-6 focus:ring-4 focus:ring-indigo-500/10"
                     placeholder="••••••••"
                   />
                   <button type="submit" disabled={verifyLoading} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center gap-2">
                      {verifyLoading ? <Loader2 className="animate-spin" size={16}/> : 'Confirmar Acesso'}
                   </button>
               </form>
               <button onClick={() => { setShowVerifyModal(false); setPendingIntent(null); }} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600">Cancelar</button>
            </div>
         </div>
      )}

      {/* VAULT MODAL */}
      {showVault && (
         <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-[700] flex items-center justify-center p-8 animate-in fade-in zoom-in-95">
             <div className="bg-slate-900 rounded-[3rem] w-full max-w-5xl h-[85vh] border border-slate-800 shadow-2xl flex flex-col overflow-hidden relative">
                 
                 {/* Vault Header */}
                 <div className="p-8 border-b border-slate-800 flex justify-between items-center bg-slate-900/50 backdrop-blur-xl shrink-0">
                     <div className="flex items-center gap-4">
                         <div className="w-12 h-12 bg-amber-500 rounded-2xl flex items-center justify-center shadow-[0_0_20px_rgba(245,158,11,0.4)]">
                             <LockKeyhole size={24} className="text-slate-900"/>
                         </div>
                         <div>
                             <h3 className="text-2xl font-black text-white tracking-tight">Project Vault</h3>
                             <p className="text-xs text-slate-400 font-medium uppercase tracking-widest mt-1">Encrypted Storage & Certificates</p>
                         </div>
                     </div>
                     <div className="flex gap-4">
                        {/* New Item Buttons */}
                        <div className="flex bg-slate-800 p-1 rounded-xl">
                            <button onClick={() => { setNewSecretData({ name: '', type: 'folder', value: '', description: '', mime: 'text/plain' }); setShowNewSecret(true); }} className="px-4 py-2 text-[10px] font-bold text-slate-300 hover:text-white uppercase hover:bg-slate-700 rounded-lg flex items-center gap-2 transition-all"><FolderPlus size={14}/> Folder</button>
                            <button onClick={() => { setNewSecretData({ name: '', type: 'key', value: '', description: '', mime: 'text/plain' }); setShowNewSecret(true); }} className="px-4 py-2 text-[10px] font-bold text-amber-500 hover:text-amber-300 uppercase hover:bg-slate-700 rounded-lg flex items-center gap-2 transition-all"><Plus size={14}/> Secret</button>
                        </div>
                        <button onClick={() => setShowVault(false)} className="p-3 bg-slate-800 hover:bg-slate-700 rounded-full text-slate-400 hover:text-white transition-colors"><X size={20}/></button>
                     </div>
                 </div>

                 {/* Breadcrumbs */}
                 <div className="px-8 py-4 bg-slate-900/80 border-b border-slate-800 flex items-center gap-2 text-xs font-mono text-slate-400">
                     <button onClick={() => { setVaultPath([]); fetchVaultItems(null); }} className="hover:text-amber-500 transition-colors">ROOT</button>
                     {vaultPath.map((p, i) => (
                         <React.Fragment key={p.id}>
                             <span className="text-slate-600">/</span>
                             <button onClick={() => { 
                                 const newPath = vaultPath.slice(0, i + 1);
                                 setVaultPath(newPath);
                                 fetchVaultItems(p.id);
                             }} className="hover:text-amber-500 transition-colors">{p.name}</button>
                         </React.Fragment>
                     ))}
                 </div>

                 {/* Vault Content */}
                 <div className="flex-1 overflow-y-auto p-8 bg-[#0B0F19]">
                     {vaultLoading ? (
                         <div className="flex justify-center items-center h-full"><Loader2 size={32} className="animate-spin text-amber-500"/></div>
                     ) : vaultItems.length === 0 ? (
                         <div className="flex flex-col items-center justify-center h-full text-slate-700 opacity-50">
                             <Vault size={64} className="mb-4"/>
                             <p className="text-sm font-bold uppercase tracking-widest">Vault Empty</p>
                         </div>
                     ) : (
                         <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
                             {vaultItems.map((item) => (
                                 <div 
                                    key={item.id} 
                                    onClick={() => {
                                        if (item.type === 'folder') {
                                            setVaultPath([...vaultPath, { id: item.id, name: item.name }]);
                                            fetchVaultItems(item.id);
                                        }
                                    }}
                                    className={`
                                        p-4 rounded-2xl border transition-all cursor-pointer group relative overflow-hidden
                                        ${item.type === 'folder' 
                                            ? 'bg-slate-800/50 border-slate-700 hover:border-slate-600 hover:bg-slate-800' 
                                            : 'bg-slate-900 border-slate-800 hover:border-amber-900/50 hover:bg-slate-800/30'}
                                    `}
                                 >
                                     <div className="flex justify-between items-start mb-4">
                                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${item.type === 'folder' ? 'bg-slate-700 text-slate-300' : 'bg-amber-500/10 text-amber-500'}`}>
                                            {item.type === 'folder' && <Folder size={20}/>}
                                            {item.type === 'key' && <Key size={20}/>}
                                            {item.type === 'cert' && <ShieldCheck size={20}/>}
                                            {item.type === 'env' && <Terminal size={20}/>}
                                            {item.type === 'file' && <FileText size={20}/>}
                                        </div>
                                        {item.type !== 'folder' && (
                                            <button 
                                                onClick={(e) => { e.stopPropagation(); handleRevealSecret(item); }}
                                                className="p-2 bg-slate-800 rounded-lg text-slate-400 hover:text-amber-500 transition-colors z-20"
                                                title={item.type === 'file' ? "Download" : "Decrypt & Copy"}
                                            >
                                                {item.type === 'file' ? <Download size={14}/> : <Eye size={14}/>}
                                            </button>
                                        )}
                                     </div>
                                     <h4 className="font-bold text-sm text-slate-200 truncate pr-6">{item.name}</h4>
                                     <p className="text-[10px] text-slate-500 mt-1 uppercase tracking-widest">{item.type}</p>
                                     
                                     {/* Delete Button (Hover) */}
                                     <button 
                                        onClick={(e) => { e.stopPropagation(); handleDeleteSecret(item.id); }}
                                        className="absolute bottom-4 right-4 text-slate-600 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity"
                                     >
                                         <Trash2 size={14}/>
                                     </button>
                                 </div>
                             ))}
                         </div>
                     )}
                 </div>

                 {/* New Secret Form (Inline Overlay) */}
                 {showNewSecret && (
                     <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-8 z-50 animate-in fade-in">
                         <div className="bg-slate-900 border border-slate-700 rounded-[2rem] p-8 w-full max-w-lg shadow-2xl">
                             <h4 className="text-xl font-black text-white mb-6">New {newSecretData.type === 'folder' ? 'Folder' : 'Secret'}</h4>
                             <div className="space-y-4">
                                 <div>
                                     <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Type</label>
                                     <div className="flex gap-2 mt-1 flex-wrap">
                                         {['folder', 'key', 'cert', 'env', 'file'].map(t => (
                                             <button 
                                                key={t}
                                                onClick={() => setNewSecretData({...newSecretData, type: t, value: ''})}
                                                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase transition-all ${newSecretData.type === t ? 'bg-amber-500 text-slate-900' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                                             >
                                                 {t}
                                             </button>
                                         ))}
                                     </div>
                                 </div>
                                 
                                 {/* Name Input */}
                                 <div>
                                     <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Name</label>
                                     <input autoFocus value={newSecretData.name} onChange={e => setNewSecretData({...newSecretData, name: e.target.value})} className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-amber-500"/>
                                 </div>

                                 {/* Value Input (Text vs File) */}
                                 {newSecretData.type !== 'folder' && (
                                     <div>
                                         <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Content</label>
                                         {newSecretData.type === 'file' || newSecretData.type === 'cert' ? (
                                             <div className="w-full bg-slate-800 border-2 border-dashed border-slate-700 rounded-xl p-6 text-center cursor-pointer hover:border-amber-500 transition-colors relative">
                                                 <input 
                                                    type="file" 
                                                    ref={fileInputRef}
                                                    onChange={handleFileUpload} 
                                                    className="absolute inset-0 opacity-0 cursor-pointer"
                                                 />
                                                 <FileUp className="mx-auto text-slate-400 mb-2"/>
                                                 <p className="text-xs text-slate-300 font-bold">{newSecretData.value ? 'File Selected (Ready to Encrypt)' : 'Click to Upload File'}</p>
                                             </div>
                                         ) : (
                                             <textarea value={newSecretData.value} onChange={e => setNewSecretData({...newSecretData, value: e.target.value})} className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-xs font-mono text-emerald-400 outline-none focus:border-amber-500 min-h-[100px]"/>
                                         )}
                                     </div>
                                 )}

                                 <div>
                                     <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Description</label>
                                     <input value={newSecretData.description} onChange={e => setNewSecretData({...newSecretData, description: e.target.value})} className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-xs text-slate-400 outline-none focus:border-amber-500"/>
                                 </div>
                                 <div className="flex gap-4 pt-2">
                                     <button onClick={() => setShowNewSecret(false)} className="flex-1 py-3 text-xs font-bold text-slate-500 hover:text-white">Cancel</button>
                                     <button onClick={handleCreateSecret} className="flex-[2] bg-amber-500 text-slate-900 py-3 rounded-xl font-black text-xs uppercase tracking-widest hover:bg-amber-400 shadow-lg">Save to Vault</button>
                                 </div>
                             </div>
                         </div>
                     </div>
                 )}
             </div>
         </div>
      )}

    </div>
  );
};

const KeyControl: React.FC<{ label: string, value: string, isSecret: boolean, isRevealed: boolean, onReveal?: () => void, onRotate?: () => void, onCopy: () => void }> = ({ label, value, isSecret, isRevealed, onReveal, onRotate, onCopy }) => (
    <div className="group">
        <div className="flex justify-between items-center mb-2">
            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{label}</label>
            <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                {isSecret && (
                    <button onClick={onReveal} className="text-slate-400 hover:text-indigo-600 transition-colors" title={isRevealed ? "Hide" : "Reveal"}>
                        {isRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                )}
                {onRotate && (
                    <button onClick={onRotate} className="text-slate-400 hover:text-amber-600 transition-colors" title="Rotate Key">
                        <RefreshCw size={14} />
                    </button>
                )}
            </div>
        </div>
        <div className="flex items-center bg-slate-50 border border-slate-100 rounded-2xl p-1 relative overflow-hidden group/input">
            <code className="flex-1 bg-transparent px-4 py-3 font-mono text-xs text-slate-600 truncate font-bold">
                {value}
            </code>
            <button onClick={onCopy} className="p-3 bg-white text-slate-400 hover:text-indigo-600 rounded-xl shadow-sm hover:shadow-md transition-all">
                <Copy size={16} />
            </button>
        </div>
    </div>
);

export default ProjectSettings;
