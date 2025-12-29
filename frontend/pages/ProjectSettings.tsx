
import React, { useState, useEffect } from 'react';
import { 
  Shield, Key, Globe, Lock, Save, Loader2, CheckCircle2, Copy, 
  Terminal, Eye, EyeOff, RefreshCw, Code, BookOpen, AlertTriangle,
  Server, ExternalLink, Plus, X, Link, CloudLightning, FileText, Info, Trash2,
  Archive, Download, Upload, HardDrive
} from 'lucide-react';

const ProjectSettings: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [project, setProject] = useState<any>(null);
  const [customDomain, setCustomDomain] = useState('');
  const [sslSource, setSslSource] = useState('');
  const [availableCerts, setAvailableCerts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Security State
  const [revealedKeyValues, setRevealedKeyValues] = useState<Record<string, string>>({});

  // Origins State
  const [origins, setOrigins] = useState<any[]>([]);
  const [newOrigin, setNewOrigin] = useState('');

  // SSL Modal State
  const [showCertModal, setShowCertModal] = useState(false);
  const [sslMode, setSslMode] = useState<'letsencrypt' | 'cloudflare_pem'>('letsencrypt');
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [leEmail, setLeEmail] = useState('');
  const [sslLoading, setSslLoading] = useState(false);

  // Verification Modal State
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyPassword, setVerifyPassword] = useState('');
  
  type SecurityIntent = 
    | { type: 'REVEAL_KEY', keyType: string }
    | { type: 'ROTATE_KEY', keyType: string }
    | { type: 'DELETE_CERT' }
    | { type: 'DELETE_DOMAIN' }
    | { type: 'UPDATE_PROFILE' };

  const [pendingIntent, setPendingIntent] = useState<SecurityIntent | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);

  // Backup State
  const [exporting, setExporting] = useState(false);

  // --- UI STATE MACHINE ---
  // CORREÇÃO: Detecta mudanças tanto no texto do domínio quanto no dropdown de SSL
  const isInputDirty = 
    customDomain !== (project?.custom_domain || '') || 
    sslSource !== (project?.ssl_certificate_source || '');

  const hasSavedDomain = !!project?.custom_domain;
  
  // B. Estado de SSL: Se existe um domínio salvo E ele está na lista de certificados ativos.
  const hasSSL = hasSavedDomain && availableCerts.includes(project.custom_domain);

  // --- HTTP CLIPBOARD FALLBACK ---
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
        
        // Só atualiza se houver dados, evita flash de conteúdo vazio
        if (current) {
            setProject(current);
            setCustomDomain(current.custom_domain || '');
            setSslSource(current.ssl_certificate_source || '');
            
            const rawOrigins = current.metadata?.allowed_origins || [];
            setOrigins(rawOrigins.map((o: any) => typeof o === 'string' ? { url: o, require_auth: true } : o));
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

  useEffect(() => { fetchProject(); }, [projectId]);

  // --- SECURITY CORE ---

  const handleVerifyAndExecute = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!verifyPassword) { alert("Digite a senha."); return; }
    if (!pendingIntent) return;

    setVerifyLoading(true);
    
    // A. Special Logic for REVEAL
    if (pendingIntent.type === 'REVEAL_KEY') {
        try {
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
        } catch (e: any) { alert("Erro de conexão."); } finally { setVerifyLoading(false); setPendingIntent(null); }
        return;
    }

    // B. Standard Actions
    try {
        const verifyRes = await fetch('/api/control/auth/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
            body: JSON.stringify({ password: verifyPassword })
        });

        if (!verifyRes.ok) { alert("Senha incorreta."); setVerifyLoading(false); return; }

        setShowVerifyModal(false); 
        setVerifyPassword('');

        if (pendingIntent.type === 'ROTATE_KEY') await executeRotateKey(pendingIntent.keyType);
        else if (pendingIntent.type === 'DELETE_CERT') await executeDeleteCert();
        else if (pendingIntent.type === 'DELETE_DOMAIN') await executeDeleteDomain(); // NEW

    } catch (e) { alert("Erro no processo de verificação."); } 
    finally { 
        setVerifyLoading(false); 
        setPendingIntent(null); // Limpa a intenção para evitar loops
    }
  };

  // --- ACTIONS IMPLEMENTATION ---

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

  const executeDeleteCert = async () => {
      setSslLoading(true);
      try {
          const res = await fetch(`/api/control/system/certificates/${project.custom_domain}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          if (!res.ok) throw new Error("Erro ao deletar");
          setSuccess("Certificado removido.");
          setTimeout(() => { fetchAvailableCerts(); setSuccess(null); }, 2000);
      } catch (e) { alert("Erro ao remover certificado."); } finally { setSslLoading(false); }
  };

  const executeDeleteDomain = async () => {
      setSaving(true);
      try {
          const res = await fetch(`/api/control/projects/${projectId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
            body: JSON.stringify({ custom_domain: null, ssl_certificate_source: null }) // Remove ambos
          });
          
          if (res.ok) {
              setSuccess('Domínio desvinculado.');
              
              // ATUALIZAÇÃO OTIMISTA (Evita que o valor volte a aparecer)
              setProject((prev: any) => ({ ...prev, custom_domain: null, ssl_certificate_source: null }));
              setCustomDomain('');
              setSslSource('');
              
              // Sincroniza com backend após um delay para garantir consistência
              setTimeout(() => {
                  fetchProject();
                  setSuccess(null);
              }, 1500);
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
      // Envia o que está no estado atual (incluindo o dropdown sslSource)
      const payload: any = { custom_domain: customDomain, ssl_certificate_source: sslSource || null };
      if (overrideOrigins) payload.metadata = { allowed_origins: overrideOrigins };

      const res = await fetch(`/api/control/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        setSuccess('Configuração salva.');
        if (!overrideOrigins) fetchProject(); 
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch (e) { alert('Erro ao salvar.'); } finally { setSaving(false); }
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

  const handleSaveCertificate = async () => {
    if (!customDomain) { alert("Salve o domínio do projeto primeiro."); return; }
    setSslLoading(true);
    try {
      const response = await fetch('/api/control/system/certificates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
        body: JSON.stringify({ domain: customDomain, cert: certPem, key: keyPem, provider: sslMode, email: leEmail, isSystem: false })
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Erro ao salvar certificado.');
      
      setSuccess(sslMode === 'letsencrypt' ? 'Solicitação enviada. Aguarde...' : 'Certificados salvos.');
      setShowCertModal(false);
      setTimeout(() => { fetchAvailableCerts(); setSuccess(null); }, 4000);
    } catch (err: any) { alert(err.message); } finally { setSslLoading(false); }
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
  
  // NEW: Button Logic Handlers
  const handleSaveDomainClick = () => {
      if (!customDomain) { alert("Digite um domínio."); return; }
      handleUpdateSettings();
  };

  const handleDeleteDomainClick = () => {
      if (hasSSL) {
          alert("Segurança: Você deve remover o Certificado SSL primeiro para evitar arquivos órfãos.");
          return;
      }
      setPendingIntent({ type: 'DELETE_DOMAIN' });
      setShowVerifyModal(true);
  };

  const handleDeleteCertClick = () => {
      setPendingIntent({ type: 'DELETE_CERT' });
      setShowVerifyModal(true);
  };

  if (loading) return <div className="p-20 flex justify-center"><Loader2 className="animate-spin text-indigo-600" /></div>;

  const apiEndpoint = project?.custom_domain ? `https://${project.custom_domain}` : `${window.location.origin}/api/data/${project?.slug}`;
  const sdkCode = `import { createClient } from './lib/cascata-sdk';\nconst cascata = createClient('${apiEndpoint}', '${project?.anon_key || 'anon_key'}');`;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-12 pb-40">
      {success && <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[500] p-5 rounded-3xl bg-indigo-600 text-white shadow-2xl flex items-center gap-4 animate-bounce"><CheckCircle2 size={20} /><span className="text-sm font-black uppercase tracking-tight">{success}</span></div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        
        {/* DATA SOVEREIGNTY */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-[3.5rem] p-12 shadow-2xl relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-16 opacity-5 group-hover:scale-110 transition-transform duration-700"><Archive size={200} className="text-white" /></div>
            <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
                <div><h3 className="text-3xl font-black text-white tracking-tight flex items-center gap-4 mb-2"><div className="w-14 h-14 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><HardDrive size={24} /></div>Data Sovereignty</h3><p className="text-slate-400 font-medium max-w-xl text-sm leading-relaxed">Full ownership of your infrastructure. Generate a cryptographic snapshot (CAF).</p></div>
                <button onClick={handleDownloadBackup} disabled={exporting} className="bg-white text-slate-900 px-8 py-4 rounded-3xl font-black text-xs uppercase tracking-widest hover:bg-indigo-50 transition-all flex items-center gap-3 shadow-xl active:scale-95 disabled:opacity-70">{exporting ? <Loader2 size={18} className="animate-spin text-indigo-600"/> : <Download size={18} className="text-indigo-600" />}Download Snapshot (.caf)</button>
            </div>
        </div>

        {/* DOMAIN & SSL CONFIG (STRICT WORKFLOW) */}
        <div className="bg-white border border-slate-200 rounded-[3.5rem] p-12 shadow-sm space-y-10">
           <div className="flex items-center justify-between">
              <h3 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-4">
                <div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><Globe size={20} /></div>
                Domínio Personalizado
              </h3>
           </div>
           
           <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Custom API Domain (FQDN)</label>
                <div className="flex gap-2">
                    <input 
                        value={customDomain} 
                        onChange={(e) => setCustomDomain(e.target.value)} 
                        placeholder="api.meu-app.com"
                        // Disable input only if saved AND synced (allow user to fix typos by editing)
                        disabled={hasSavedDomain && !isInputDirty} 
                        className="flex-1 bg-slate-50 border border-slate-100 rounded-2xl py-4 px-6 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all disabled:bg-slate-100 disabled:text-slate-500" 
                    />
                    
                    {/* BUTTON 1: SAVE DOMAIN (Visible if Not Saved OR Edited/Dirty) */}
                    {(isInputDirty || !hasSavedDomain) && (
                        <button 
                            onClick={handleSaveDomainClick}
                            disabled={saving || !customDomain}
                            className="bg-indigo-600 text-white px-6 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg flex items-center gap-2"
                        >
                            {saving ? <Loader2 size={14} className="animate-spin"/> : <Save size={14} />} Salvar
                        </button>
                    )}

                    {/* BUTTON 2: SSL MANAGER (Visible ONLY if Saved AND Clean) */}
                    {hasSavedDomain && !isInputDirty && (
                        <button 
                            onClick={() => setShowCertModal(true)}
                            className={`px-4 rounded-2xl transition-all flex items-center gap-2 font-bold text-xs ${hasSSL ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'}`}
                        >
                            {hasSSL ? <><CheckCircle2 size={16}/> SSL Ativo</> : <><CloudLightning size={16}/> Adicionar SSL</>}
                        </button>
                    )}

                    {/* BUTTON 3: REMOVE CERT (Visible ONLY if Cert Exists AND Clean) */}
                    {hasSSL && !isInputDirty && (
                        <button onClick={handleDeleteCertClick} className="bg-white border border-slate-200 text-slate-400 p-4 rounded-2xl hover:text-rose-600 hover:border-rose-200 transition-all shadow-sm" title="Remover Certificado">
                            <CloudLightning size={18} className="line-through"/>
                        </button>
                    )}

                    {/* BUTTON 4: DELETE DOMAIN (Visible ONLY if Saved AND Clean) */}
                    {hasSavedDomain && !isInputDirty && (
                        <button onClick={handleDeleteDomainClick} className="bg-rose-50 text-rose-600 p-4 rounded-2xl hover:bg-rose-600 hover:text-white transition-all shadow-sm" title="Desvincular Domínio">
                            <Trash2 size={18} />
                        </button>
                    )}
                </div>
                {hasSavedDomain ? (
                    <p className="text-[10px] text-emerald-600 font-bold px-2 flex items-center gap-1"><CheckCircle2 size={10}/> Domínio registrado no sistema.</p>
                ) : (
                    <p className="text-[10px] text-slate-400 font-medium px-2">Salve o domínio antes de configurar o SSL.</p>
                )}
              </div>

              {/* Linked Cert Selection (Optional Advanced) */}
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 flex items-center gap-2">Certificado Vinculado (Opcional) <Info size={12}/></label>
                <select 
                  value={sslSource} 
                  onChange={(e) => setSslSource(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-6 text-xs font-bold text-slate-700 outline-none cursor-pointer hover:border-indigo-300 transition-colors"
                >
                    <option value="">Usar certificado próprio do domínio (Padrão)</option>
                    {availableCerts.filter(c => c !== customDomain).map(cert => (
                        <option key={cert} value={cert}>Compartilhar de: {cert}</option>
                    ))}
                </select>
                <p className="text-[9px] text-slate-400 px-2 font-medium">
                    Se você escolher um certificado vinculado, lembre-se de clicar em <b>SALVAR</b> acima para aplicar a mudança.
                </p>
              </div>
           </div>
        </div>

        {/* Global Origins */}
        <div className="bg-white border border-slate-200 rounded-[3.5rem] p-12 shadow-sm space-y-10">
           <h3 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-4"><div className="w-12 h-12 bg-emerald-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><Link size={20} /></div>Global Allowed Origins</h3>
           <div className="space-y-6">
              <div className="flex gap-4">
                 <input value={newOrigin} onChange={(e) => setNewOrigin(e.target.value)} placeholder="https://meu-app.com" className="flex-1 bg-slate-50 border border-slate-100 rounded-2xl py-3 px-6 text-sm font-bold outline-none focus:ring-4 focus:ring-emerald-500/10" />
                 <button onClick={addOrigin} className="bg-emerald-600 text-white px-4 rounded-2xl hover:bg-emerald-700 transition-all"><Plus size={20} /></button>
              </div>
              <div className="space-y-3 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
                 {origins.map((origin, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-slate-50 p-4 rounded-2xl border border-slate-100"><span className="text-xs font-bold text-slate-700">{origin.url}</span><button onClick={() => removeOrigin(origin.url)} className="text-slate-300 hover:text-rose-600"><X size={16} /></button></div>
                 ))}
              </div>
           </div>
        </div>

        {/* Keys & SDK */}
        <div className="bg-white border border-slate-200 rounded-[3.5rem] p-12 shadow-sm space-y-10">
           <div className="space-y-2">
               <h3 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-4"><div className="w-12 h-12 bg-slate-900 text-white rounded-2xl flex items-center justify-center shadow-lg"><Lock size={20} /></div>Gerenciamento de Segredos</h3>
           </div>
           <div className="space-y-8">
              <KeyControl label="Anon Key" value={revealedKeyValues['anon'] || project?.anon_key || '******'} isSecret={false} isRevealed={!!revealedKeyValues['anon']} onToggleReveal={() => handleRevealClick('anon')} onRotate={() => handleRotateClick('anon')} loading={rotating === 'anon'} copyFn={copyToClipboard} />
              <KeyControl label="Service Key" value={revealedKeyValues['service'] || project?.service_key || '******'} isSecret={true} isRevealed={!!revealedKeyValues['service']} onToggleReveal={() => handleRevealClick('service')} onRotate={() => handleRotateClick('service')} loading={rotating === 'service'} copyFn={copyToClipboard} />
              <KeyControl label="JWT Secret" value={revealedKeyValues['jwt'] || project?.jwt_secret || '******'} isSecret={true} isRevealed={!!revealedKeyValues['jwt']} onToggleReveal={() => handleRevealClick('jwt')} onRotate={() => handleRotateClick('jwt')} loading={rotating === 'jwt'} copyFn={copyToClipboard} />
           </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-[3.5rem] p-12 shadow-sm space-y-8">
           <h3 className="text-2xl font-black text-white tracking-tight flex items-center gap-4"><div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center"><Code size={20} /></div>Cascata SDK</h3>
           <div className="relative group"><pre className="bg-slate-950 p-8 rounded-[2rem] text-[11px] font-mono text-emerald-400 overflow-x-auto leading-relaxed border border-white/5">{sdkCode}</pre><button onClick={() => copyToClipboard(sdkCode)} className="absolute top-4 right-4 p-3 bg-white/5 hover:bg-white/10 text-white rounded-xl transition-all"><Copy size={16} /></button></div>
        </div>
      </div>

      {/* MODALS */}
      {showCertModal && (
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-2xl z-[600] flex items-center justify-center p-8 animate-in fade-in duration-300">
           <div className="bg-white rounded-[4rem] w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl border border-slate-200">
              <header className="p-12 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                 <div className="flex items-center gap-6"><div className="w-16 h-16 bg-indigo-600 text-white rounded-[1.5rem] flex items-center justify-center shadow-xl"><RefreshCw size={32} /></div><div><h3 className="text-3xl font-black text-slate-900 tracking-tighter">Gerenciar SSL: {customDomain}</h3><p className="text-slate-400 font-bold uppercase tracking-widest text-[10px]">Configuração de Segurança para Endpoint</p></div></div>
                 <button onClick={() => setShowCertModal(false)} className="p-4 hover:bg-slate-200 rounded-full transition-all text-slate-400"><X size={32} /></button>
              </header>
              <div className="flex-1 overflow-y-auto p-12 space-y-12">
                 <div className="flex gap-4 p-2 bg-slate-50 rounded-3xl max-w-md mx-auto shadow-inner">
                    <button onClick={() => setSslMode('letsencrypt')} className={`flex-1 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${sslMode === 'letsencrypt' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-400'}`}>Let's Encrypt (Nuvem Cinza)</button>
                    <button onClick={() => setSslMode('cloudflare_pem')} className={`flex-1 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${sslMode === 'cloudflare_pem' ? 'bg-white shadow-md text-orange-600' : 'text-slate-400'}`}>Manual / PEM</button>
                 </div>
                 {sslMode === 'letsencrypt' ? (
                   <div className="max-w-2xl mx-auto space-y-10 py-10"><div className="bg-indigo-50 border border-indigo-100 p-10 rounded-[3rem] flex gap-8"><Info className="text-indigo-600 shrink-0" size={40} /><div className="space-y-4"><h4 className="font-black text-slate-900 text-xl">Validação HTTP-01</h4><p className="text-sm text-slate-600 font-medium leading-relaxed">O Let's Encrypt validará o domínio via <code>.well-known/acme-challenge/</code>. Se usar Cloudflare, deixe a nuvem <b>CINZA</b> temporariamente.</p></div></div><div className="space-y-4"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">E-mail para Alertas SSL</label><input value={leEmail} onChange={(e) => setLeEmail(e.target.value)} placeholder="security@domain.com" className="w-full bg-slate-50 border border-slate-200 rounded-3xl py-6 px-10 text-xl font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-600/10" /></div></div>
                 ) : (
                   <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                      <div className="space-y-4"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2">Certificado PEM</label><textarea value={certPem} onChange={(e) => setCertPem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" className="w-full h-96 bg-slate-900 text-emerald-400 p-8 rounded-[2.5rem] font-mono text-xs outline-none focus:ring-8 focus:ring-indigo-500/10 resize-none shadow-2xl" /></div>
                      <div className="space-y-4"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2">Chave Privada (.key)</label><textarea value={keyPem} onChange={(e) => setKeyPem(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" className="w-full h-96 bg-slate-900 text-amber-400 p-8 rounded-[2.5rem] font-mono text-xs outline-none focus:ring-8 focus:ring-indigo-500/10 resize-none shadow-2xl" /></div>
                   </div>
                 )}
              </div>
              <footer className="p-10 bg-slate-50 border-t border-slate-100 flex gap-6"><button onClick={() => setShowCertModal(false)} className="flex-1 py-6 text-slate-400 font-black uppercase tracking-widest text-[10px] hover:bg-slate-200 rounded-2xl transition-all">Cancelar</button><button onClick={handleSaveCertificate} disabled={sslLoading || (sslMode === 'letsencrypt' && !leEmail)} className="flex-[3] bg-slate-900 text-white py-6 rounded-[2rem] font-black uppercase tracking-widest text-[10px] flex items-center justify-center gap-4 shadow-2xl active:scale-95 disabled:opacity-30 transition-all">{sslLoading ? <Loader2 size={16} className="animate-spin" /> : <><CheckCircle2 size={18} /> {sslMode === 'letsencrypt' ? 'Disparar Let\'s Encrypt' : 'Salvar PEM'}</>}</button></footer>
           </div>
        </div>
      )}

      {showVerifyModal && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[800] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl text-center border border-slate-200">
               <Lock size={40} className="mx-auto text-slate-900 mb-6" />
               <h3 className="text-xl font-black text-slate-900 mb-2">Confirmação de Segurança</h3>
               <p className="text-xs text-slate-500 font-bold mb-8">Digite sua senha mestra para autorizar.</p>
               <form onSubmit={handleVerifyAndExecute}><input type="password" autoFocus value={verifyPassword} onChange={e => setVerifyPassword(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-center font-bold text-slate-900 outline-none mb-6 focus:ring-4 focus:ring-indigo-500/10" placeholder="••••••••"/><button type="submit" disabled={verifyLoading} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center">{verifyLoading ? <Loader2 className="animate-spin"/> : 'Confirmar Acesso'}</button></form>
               <button onClick={() => { setShowVerifyModal(false); setPendingIntent(null); }} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600">Cancelar</button>
            </div>
         </div>
      )}
    </div>
  );
};

const KeyControl = ({ label, value, isSecret, isRevealed, onToggleReveal, onRotate, loading, copyFn }: any) => {
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center px-1"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}</label><div className="flex gap-4">{isSecret && (<button onClick={onToggleReveal} className="text-[10px] font-black text-indigo-600 uppercase hover:underline flex items-center gap-1">{isRevealed ? <><EyeOff size={10}/> Ocultar</> : <><Eye size={10}/> Revelar (Sudo)</>}</button>)}<button onClick={onRotate} disabled={loading} className="text-[10px] font-black text-rose-600 uppercase hover:underline flex items-center gap-1">{loading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />} Rotacionar</button></div></div>
      <div className="relative group"><input type={isSecret && !isRevealed ? 'password' : 'text'} value={value || ''} readOnly className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-6 pr-14 text-[12px] font-mono font-bold text-slate-700 outline-none" /><button onClick={() => { if (isSecret && !isRevealed) { alert("Desbloqueie a chave primeiro para copiar."); } else { copyFn(value); }}} className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-300 hover:text-indigo-600 p-2"><Copy size={16} /></button></div>
    </div>
  );
};

export default ProjectSettings;
