
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
  // Keys now store their revealed values temporarily here.
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
  const [pendingAction, setPendingAction] = useState<(() => Promise<void>) | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);

  // Backup State
  const [exporting, setExporting] = useState(false);

  const fetchProject = async () => {
    try {
        const res = await fetch('/api/control/projects', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
        });
        const data = await res.json();
        const current = data.find((p: any) => p.slug === projectId);
        setProject(current);
        setCustomDomain(current?.custom_domain || '');
        setSslSource(current?.ssl_certificate_source || '');
        
        const rawOrigins = current?.metadata?.allowed_origins || [];
        setOrigins(rawOrigins.map((o: any) => typeof o === 'string' ? { url: o, require_auth: true } : o));
        
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

  // --- SECURITY HELPERS ---

  const triggerSecureAction = (action: () => Promise<void>) => {
    setPendingAction(() => action);
    setShowVerifyModal(true);
  };

  const handleVerifyAndExecute = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setVerifyLoading(true);
    try {
      // Logic for "Reveal Key" is different; it fetches data from a specific secure route
      // instead of just verifying password.
      if (pendingAction) {
          // Standard Actions (Rotate, Delete Domain, etc) that require auth verification first
          const res = await fetch('/api/control/auth/verify', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
            },
            body: JSON.stringify({ password: verifyPassword })
          });
          
          if (res.ok) {
            setShowVerifyModal(false);
            setVerifyPassword('');
            await pendingAction();
            setPendingAction(null);
          } else {
            alert("Senha incorreta.");
          }
      } 
    } catch (e) { 
      alert("Erro na verificação de segurança."); 
    } finally {
        setVerifyLoading(false);
    }
  };

  const handleRevealKey = (keyType: string) => {
      // Toggle Off
      if (revealedKeyValues[keyType]) {
          const next = { ...revealedKeyValues };
          delete next[keyType];
          setRevealedKeyValues(next);
          return;
      }

      // Toggle On (Requires Fetch)
      // Custom Secure Action that passes password directly to the reveal endpoint
      setPendingAction(() => async () => {
          try {
              const res = await fetch(`/api/control/projects/${projectId}/reveal-key`, {
                  method: 'POST',
                  headers: { 
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
                  },
                  body: JSON.stringify({ password: verifyPassword, keyType: keyType === 'service' ? 'service_key' : keyType === 'anon' ? 'anon_key' : 'jwt_secret' })
              });
              
              if (!res.ok) {
                  throw new Error("Senha incorreta ou erro no servidor");
              }
              
              const data = await res.json();
              
              setRevealedKeyValues(prev => ({ ...prev, [keyType]: data.key }));
              
              // Auto-hide after 60 seconds
              setTimeout(() => {
                  setRevealedKeyValues(prev => {
                      const updated = { ...prev };
                      delete updated[keyType];
                      return updated;
                  });
              }, 60000);

          } catch (e: any) {
              alert(e.message);
          }
      });
      setShowVerifyModal(true);
  };

  // --- SETTINGS ACTIONS ---

  const isValidUrl = (str: string) => {
    try { new URL(str); return true; } catch { return false; }
  };

  const handleUpdateSettings = async (overrideOrigins?: any[]) => {
    setSaving(true);
    try {
      const payload: any = { custom_domain: customDomain, ssl_certificate_source: sslSource || null };
      if (overrideOrigins) payload.metadata = { allowed_origins: overrideOrigins };

      const res = await fetch(`/api/control/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        setSuccess('Configuração atualizada.');
        if (!overrideOrigins) fetchProject(); 
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch (e) {
      alert('Erro ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  const addOrigin = () => {
    if (!newOrigin) return;
    if (!isValidUrl(newOrigin)) {
        alert('URL inválida. Use o formato completo: https://seu-site.com');
        return;
    }
    const updated = [...origins, { url: newOrigin, require_auth: true }];
    setOrigins(updated);
    setNewOrigin('');
    handleUpdateSettings(updated);
  };

  const removeOrigin = (url: string) => {
    const updated = origins.filter(o => o.url !== url);
    setOrigins(updated);
    handleUpdateSettings(updated);
  };

  const rotateKey = async (type: string) => {
    setRotating(type);
    try {
      await fetch(`/api/control/projects/${projectId}/rotate-keys`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify({ type })
      });
      await fetchProject();
      setSuccess(`${type.toUpperCase()} rotacionada com sucesso.`);
      // Clear revealed state if rotated
      const next = { ...revealedKeyValues };
      delete next[type.replace('_key', '').replace('_secret', '')];
      setRevealedKeyValues(next);
      
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      alert('Falha ao rotacionar chave.');
    } finally {
      setRotating(null);
    }
  };

  const handleSaveCertificate = async () => {
    if (!customDomain) { alert("Salve o domínio do projeto primeiro."); return; }
    setSslLoading(true);
    try {
      const response = await fetch('/api/control/system/certificates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify({ 
          domain: customDomain, 
          cert: certPem, 
          key: keyPem, 
          provider: sslMode,
          email: leEmail,
          isSystem: false
        })
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Erro ao salvar certificado.');
      
      setSuccess(sslMode === 'letsencrypt' 
        ? 'Solicitação enviada ao Certbot. Aguarde validação e reload (aprox. 30s).' 
        : 'Certificados PEM salvos e aplicados.');
      
      setShowCertModal(false);
      
      setTimeout(() => {
          fetchAvailableCerts();
          setSuccess(null);
      }, 4000);

    } catch (err: any) {
      alert(err.message);
    } finally {
      setSslLoading(false);
    }
  };

  const handleDeleteCertificate = async () => {
      setSslLoading(true);
      try {
          const res = await fetch(`/api/control/system/certificates/${customDomain}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          if (!res.ok) throw new Error("Erro ao deletar");
          setSuccess("Certificado removido.");
          setTimeout(() => {
              fetchAvailableCerts();
              setSuccess(null);
          }, 2000);
      } catch (e) {
          alert("Erro ao remover certificado.");
      } finally {
          setSslLoading(false);
      }
  };

  const handleDownloadBackup = async () => {
      setExporting(true);
      try {
          // Secure download via Blob to avoid token in URL bar
          const res = await fetch(`/api/control/projects/${projectId}/export`, {
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          
          if (!res.ok) throw new Error("Download failed");
          
          const blob = await res.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${project.slug}_backup_${new Date().toISOString().split('T')[0]}.caf`;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          document.body.removeChild(a);
          setSuccess("Backup downloaded successfully.");
          setTimeout(() => setSuccess(null), 3000);
      } catch (e) {
          alert("Erro ao baixar backup.");
      } finally {
          setExporting(false);
      }
  };

  if (loading) return <div className="p-20 flex justify-center"><Loader2 className="animate-spin text-indigo-600" /></div>;

  const apiEndpoint = project?.custom_domain 
    ? `https://${project.custom_domain}` 
    : `${window.location.origin}/api/data/${project?.slug}`;

  const sdkCode = `
import { createClient } from './lib/cascata-sdk';

const cascata = createClient(
  '${apiEndpoint}',
  '${project?.anon_key || 'anon_key'}'
);

// Example
const { data } = await cascata.from('users').select();
  `.trim();

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-12 pb-40">
      {success && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[500] p-5 rounded-3xl bg-indigo-600 text-white shadow-2xl flex items-center gap-4 animate-bounce">
          <CheckCircle2 size={20} />
          <span className="text-sm font-black uppercase tracking-tight">{success}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        
        {/* DATA SOVEREIGNTY & BACKUP */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-[3.5rem] p-12 shadow-2xl relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-16 opacity-5 group-hover:scale-110 transition-transform duration-700">
                <Archive size={200} className="text-white" />
            </div>
            
            <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
                <div>
                    <h3 className="text-3xl font-black text-white tracking-tight flex items-center gap-4 mb-2">
                        <div className="w-14 h-14 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><HardDrive size={24} /></div>
                        Data Sovereignty
                    </h3>
                    <p className="text-slate-400 font-medium max-w-xl text-sm leading-relaxed">
                        Full ownership of your infrastructure. Generate a cryptographic snapshot (CAF) containing your database schema, raw data, storage files, and access policies.
                    </p>
                </div>
                
                <div className="flex gap-4">
                    <button 
                        onClick={handleDownloadBackup}
                        disabled={exporting}
                        className="bg-white text-slate-900 px-8 py-4 rounded-3xl font-black text-xs uppercase tracking-widest hover:bg-indigo-50 transition-all flex items-center gap-3 shadow-xl active:scale-95 disabled:opacity-70"
                    >
                        {exporting ? <Loader2 size={18} className="animate-spin text-indigo-600"/> : <Download size={18} className="text-indigo-600" />}
                        Download Snapshot (.caf)
                    </button>
                </div>
            </div>
        </div>

        {/* Infraestrutura e Domínio */}
        <div className="bg-white border border-slate-200 rounded-[3.5rem] p-12 shadow-sm space-y-10">
           <div className="flex items-center justify-between">
              <h3 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-4">
                <div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><Globe size={20} /></div>
                Exposição de API
              </h3>
              <button onClick={() => handleUpdateSettings()} disabled={saving} className="bg-slate-900 text-white px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2">
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Salvar Domínio
              </button>
           </div>
           
           <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Custom API Domain (FQDN)</label>
                <div className="flex gap-2">
                    <input 
                    value={customDomain} 
                    onChange={(e) => setCustomDomain(e.target.value)} 
                    placeholder="api.meu-app.com"
                    className="flex-1 bg-slate-50 border border-slate-100 rounded-2xl py-4 px-6 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all" 
                    />
                    {customDomain && availableCerts.includes(customDomain) && (
                        <button onClick={() => triggerSecureAction(handleDeleteCertificate)} className="bg-rose-50 text-rose-600 p-4 rounded-2xl hover:bg-rose-100 transition-all" title="Apagar Certificado">
                            <Trash2 size={18} />
                        </button>
                    )}
                    <button 
                        onClick={() => { if(!customDomain) { alert("Defina um domínio primeiro"); return; } setShowCertModal(true); }}
                        className="bg-indigo-50 text-indigo-600 p-4 rounded-2xl hover:bg-indigo-100 transition-all flex items-center gap-2 font-bold text-xs"
                    >
                        <CloudLightning size={18} /> {availableCerts.includes(customDomain) ? 'Atualizar SSL' : 'Criar SSL'}
                    </button>
                </div>
                <p className="text-[10px] text-slate-400 font-medium px-2">Aponte o CNAME/A do seu domínio para <b>{window.location.hostname}</b> para ativar o isolamento.</p>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Linked Certificate (Shared SSL)</label>
                <select 
                  value={sslSource} 
                  onChange={(e) => setSslSource(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 px-6 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all cursor-pointer"
                >
                    <option value="">Use Certificate for {customDomain || 'this domain'}</option>
                    {availableCerts.map(cert => (
                        <option key={cert} value={cert}>Use existing cert from: {cert}</option>
                    ))}
                </select>
                <p className="text-[10px] text-slate-400 font-medium px-2">Útil se você tem um certificado Wildcard (*.site.com) instalado em outro domínio.</p>
              </div>

              <div className="p-6 bg-slate-50 rounded-2xl border border-slate-100 space-y-4">
                <div>
                   <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Default Instance Endpoint</span>
                   <code className="text-xs font-mono font-bold text-indigo-600 break-all">{window.location.origin}/api/data/{project?.slug}</code>
                </div>
              </div>
           </div>
        </div>

        {/* Global Origins Registry */}
        <div className="bg-white border border-slate-200 rounded-[3.5rem] p-12 shadow-sm space-y-10">
           <h3 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-4">
              <div className="w-12 h-12 bg-emerald-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><Link size={20} /></div>
              Global Allowed Origins (URL Locking)
           </h3>
           
           <div className="space-y-6">
              <p className="text-slate-500 text-xs font-medium">
                Lista mestre de URLs confiáveis. URLs adicionadas aqui aparecerão como sugestões ao configurar Strategies individuais.
              </p>
              
              <div className="flex gap-4">
                 <input 
                   value={newOrigin} 
                   onChange={(e) => setNewOrigin(e.target.value)} 
                   placeholder="https://meu-app.com"
                   className="flex-1 bg-slate-50 border border-slate-100 rounded-2xl py-3 px-6 text-sm font-bold outline-none focus:ring-4 focus:ring-emerald-500/10" 
                 />
                 <button onClick={addOrigin} className="bg-emerald-600 text-white px-4 rounded-2xl hover:bg-emerald-700 transition-all"><Plus size={20} /></button>
              </div>

              <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
                 {origins.map((origin, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-slate-50 p-4 rounded-2xl border border-slate-100">
                       <span className="text-xs font-bold text-slate-700">{origin.url}</span>
                       <button onClick={() => removeOrigin(origin.url)} className="text-slate-300 hover:text-rose-600"><X size={16} /></button>
                    </div>
                 ))}
                 {origins.length === 0 && <span className="text-xs text-slate-300 font-bold block text-center py-4">Nenhuma origem global definida.</span>}
              </div>
           </div>
        </div>

        {/* Segurança e Chaves */}
        <div className="bg-white border border-slate-200 rounded-[3.5rem] p-12 shadow-sm space-y-10">
           <div className="space-y-2">
               <h3 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-4">
                  <div className="w-12 h-12 bg-slate-900 text-white rounded-2xl flex items-center justify-center shadow-lg"><Lock size={20} /></div>
                  Gerenciamento de Segredos
               </h3>
               <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest pl-16">
                   Proteção de Nível Bancário: Chaves nunca trafegam em texto puro.
               </p>
           </div>
           
           <div className="space-y-8">
              <KeyControl 
                label="Anon Key" 
                value={revealedKeyValues['anon'] || project?.anon_key || '******'} 
                isSecret={false}
                isRevealed={!!revealedKeyValues['anon']}
                onToggleReveal={() => handleRevealKey('anon')}
                onRotate={() => triggerSecureAction(() => rotateKey('anon'))} 
                loading={rotating === 'anon'}
              />
              <KeyControl 
                label="Service Key" 
                value={revealedKeyValues['service'] || project?.service_key || '******'} 
                isSecret={true} 
                isRevealed={!!revealedKeyValues['service']}
                onToggleReveal={() => handleRevealKey('service')}
                onRotate={() => triggerSecureAction(() => rotateKey('service'))} 
                loading={rotating === 'service'}
              />
              <KeyControl 
                label="JWT Secret" 
                value={revealedKeyValues['jwt'] || project?.jwt_secret || '******'} 
                isSecret={true} 
                isRevealed={!!revealedKeyValues['jwt']}
                onToggleReveal={() => handleRevealKey('jwt')}
                onRotate={() => triggerSecureAction(() => rotateKey('jwt'))} 
                loading={rotating === 'jwt'}
              />
           </div>
        </div>

        {/* Integração SDK Nativo */}
        <div className="bg-slate-900 border border-slate-800 rounded-[3.5rem] p-12 shadow-sm space-y-8">
           <div className="flex items-center justify-between">
              <h3 className="text-2xl font-black text-white tracking-tight flex items-center gap-4">
                <div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center"><Code size={20} /></div>
                Cascata SDK (Nativo)
              </h3>
              <span className="text-[10px] font-black text-indigo-400 border border-indigo-400/30 px-3 py-1 rounded-full uppercase">Independente</span>
           </div>
           
           <div className="space-y-4">
              <p className="text-slate-400 text-sm font-medium leading-relaxed">
                Use nosso SDK minimalista para integração direta. Sem dependências pesadas, focado em performance pura.
              </p>
              <div className="relative group">
                <pre className="bg-slate-950 p-8 rounded-[2rem] text-[11px] font-mono text-emerald-400 overflow-x-auto leading-relaxed border border-white/5">
                  {sdkCode}
                </pre>
                <button 
                  onClick={() => navigator.clipboard.writeText(sdkCode)}
                  className="absolute top-4 right-4 p-3 bg-white/5 hover:bg-white/10 text-white rounded-xl transition-all"
                >
                  <Copy size={16} />
                </button>
              </div>
           </div>

           <div className="p-6 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex gap-4">
              <AlertTriangle className="text-amber-500 shrink-0" size={20} />
              <p className="text-[11px] text-amber-200 font-medium">
                Mantenha a <b>Service Key</b> apenas em ambientes de servidor (Node, Python, etc). Nunca a exponha no código do navegador.
              </p>
           </div>
        </div>
      </div>

      {/* SSL Modal (Certbot Automático) */}
      {showCertModal && (
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-2xl z-[600] flex items-center justify-center p-8 animate-in fade-in duration-300">
           <div className="bg-white rounded-[4rem] w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl border border-slate-200">
              <header className="p-12 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                 <div className="flex items-center gap-6">
                    <div className="w-16 h-16 bg-indigo-600 text-white rounded-[1.5rem] flex items-center justify-center shadow-xl">
                       <RefreshCw size={32} />
                    </div>
                    <div>
                       <h3 className="text-3xl font-black text-slate-900 tracking-tighter">Gerenciar SSL: {customDomain}</h3>
                       <p className="text-slate-400 font-bold uppercase tracking-widest text-[10px]">Configuração de Segurança para Endpoint</p>
                    </div>
                 </div>
                 <button onClick={() => setShowCertModal(false)} className="p-4 hover:bg-slate-200 rounded-full transition-all text-slate-400"><X size={32} /></button>
              </header>

              <div className="flex-1 overflow-y-auto p-12 space-y-12">
                 <div className="flex gap-4 p-2 bg-slate-50 rounded-3xl max-w-md mx-auto shadow-inner">
                    <button onClick={() => setSslMode('letsencrypt')} className={`flex-1 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${sslMode === 'letsencrypt' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-400'}`}>Let's Encrypt (Nuvem Cinza)</button>
                    <button onClick={() => setSslMode('cloudflare_pem')} className={`flex-1 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${sslMode === 'cloudflare_pem' ? 'bg-white shadow-md text-orange-600' : 'text-slate-400'}`}>Manual / Cloudflare (Nuvem Laranja)</button>
                 </div>

                 {sslMode === 'letsencrypt' ? (
                   <div className="max-w-2xl mx-auto space-y-10 py-10">
                      <div className="bg-indigo-50 border border-indigo-100 p-10 rounded-[3rem] flex gap-8">
                        <Info className="text-indigo-600 shrink-0" size={40} />
                        <div className="space-y-4">
                          <h4 className="font-black text-slate-900 text-xl">Requisitos de Validação</h4>
                          <p className="text-sm text-slate-600 font-medium leading-relaxed">
                            O Let's Encrypt tentará acessar o arquivo de desafio em: <br/>
                            <code>http://{customDomain}/.well-known/acme-challenge/</code>
                            <br/><br/>
                            Certifique-se que o domínio está apontando para o seu IP e a <b>nuvem da Cloudflare está CINZA (Desativada)</b> durante este processo inicial.
                          </p>
                        </div>
                      </div>
                      <div className="space-y-4">
                         <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">E-mail para Alertas SSL</label>
                         <input value={leEmail} onChange={(e) => setLeEmail(e.target.value)} placeholder="security@yourdomain.com" className="w-full bg-slate-50 border border-slate-200 rounded-3xl py-6 px-10 text-xl font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-600/10" />
                      </div>
                   </div>
                 ) : (
                   <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                      <div className="space-y-4">
                         <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 ml-2"><FileText size={14}/> Certificado PEM</label>
                         <textarea value={certPem} onChange={(e) => setCertPem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" className="w-full h-96 bg-slate-900 text-emerald-400 p-8 rounded-[2.5rem] font-mono text-xs outline-none focus:ring-8 focus:ring-indigo-500/10 resize-none shadow-2xl" />
                      </div>
                      <div className="space-y-4">
                         <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 ml-2"><Key size={14}/> Chave Privada (.key)</label>
                         <textarea value={keyPem} onChange={(e) => setKeyPem(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" className="w-full h-96 bg-slate-900 text-amber-400 p-8 rounded-[2.5rem] font-mono text-xs outline-none focus:ring-8 focus:ring-indigo-500/10 resize-none shadow-2xl" />
                      </div>
                   </div>
                 )}
              </div>

              <footer className="p-10 bg-slate-50 border-t border-slate-100 flex gap-6">
                 <button onClick={() => setShowCertModal(false)} className="flex-1 py-6 text-slate-400 font-black uppercase tracking-widest text-[10px] hover:bg-slate-200 rounded-2xl transition-all">Cancelar</button>
                 <button onClick={handleSaveCertificate} disabled={sslLoading || (sslMode === 'letsencrypt' && !leEmail)} className="flex-[3] bg-slate-900 text-white py-6 rounded-[2rem] font-black uppercase tracking-widest text-[10px] flex items-center justify-center gap-4 shadow-2xl active:scale-95 disabled:opacity-30 transition-all">
                    {sslLoading ? <Loader2 size={16} className="animate-spin" /> : <><CheckCircle2 size={18} /> {sslMode === 'letsencrypt' ? 'Disparar Let\'s Encrypt' : 'Salvar PEM Manual'}</>}
                 </button>
              </footer>
           </div>
        </div>
      )}

      {/* Verify Password Modal (Sudo Mode) */}
      {showVerifyModal && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[800] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl text-center border border-slate-200">
               <Lock size={40} className="mx-auto text-slate-900 mb-6" />
               <h3 className="text-xl font-black text-slate-900 mb-2">Confirmação de Segurança</h3>
               <p className="text-xs text-slate-500 font-bold mb-8">Esta ação é restrita. Digite sua senha mestra para autorizar.</p>
               
               <form onSubmit={handleVerifyAndExecute}>
                   <input 
                     type="password" 
                     autoFocus
                     value={verifyPassword}
                     onChange={e => setVerifyPassword(e.target.value)}
                     className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-center font-bold text-slate-900 outline-none mb-6 focus:ring-4 focus:ring-indigo-500/10"
                     placeholder="••••••••"
                   />
                   <button type="submit" disabled={verifyLoading} className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-indigo-600 transition-all flex items-center justify-center">
                      {verifyLoading ? <Loader2 className="animate-spin"/> : 'Confirmar Acesso'}
                   </button>
               </form>
               <button onClick={() => { setShowVerifyModal(false); setPendingAction(null); }} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600">Cancelar</button>
            </div>
         </div>
      )}
    </div>
  );
};

const KeyControl = ({ label, value, isSecret, isRevealed, onToggleReveal, onRotate, loading }: any) => {
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center px-1">
        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}</label>
        <div className="flex gap-4">
          {isSecret && (
            <button onClick={onToggleReveal} className="text-[10px] font-black text-indigo-600 uppercase hover:underline flex items-center gap-1">
              {isRevealed ? <><EyeOff size={10}/> Ocultar</> : <><Eye size={10}/> Revelar (Sudo)</>}
            </button>
          )}
          <button onClick={onRotate} disabled={loading} className="text-[10px] font-black text-rose-600 uppercase hover:underline flex items-center gap-1">
            {loading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />} Rotacionar
          </button>
        </div>
      </div>
      <div className="relative group">
        <input 
          type={isSecret && !isRevealed ? 'password' : 'text'}
          value={value || ''}
          readOnly
          className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-6 pr-14 text-[12px] font-mono font-bold text-slate-700 outline-none" 
        />
        <button 
            onClick={() => {
                if (isSecret && !isRevealed) {
                    alert("Desbloqueie a chave primeiro para copiar.");
                } else {
                    navigator.clipboard.writeText(value);
                }
            }} 
            className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-300 hover:text-indigo-600 p-2"
        >
          <Copy size={16} />
        </button>
      </div>
    </div>
  );
};

export default ProjectSettings;
