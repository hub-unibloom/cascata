
import React, { useState, useEffect } from 'react';
import { 
  Plus, Search, ExternalLink, Activity, Database, Clock, MoreVertical, 
  Terminal, Loader2, Server, Key, Shield, Trash2, AlertTriangle, 
  Upload, FileArchive, ArrowRight, CheckCircle2, X, Sparkles, HardDrive,
  Copy, RefreshCcw, FileText, Info, Globe
} from 'lucide-react';
import { Project } from '../types';

interface DashboardProps {
  onSelectProject: (id: string) => void;
}

const COMMON_TIMEZONES = [
  'UTC', 'America/Sao_Paulo', 'America/New_York', 'America/Los_Angeles',
  'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Asia/Singapore',
  'Australia/Sydney'
];

const Dashboard: React.FC<DashboardProps> = ({ onSelectProject }) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Create Modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newProject, setNewProject] = useState({ 
    name: '', 
    slug: '', 
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone 
  });
  const [createError, setCreateError] = useState<string | null>(null);
  
  // Import Modal (CAF 2.0 Wizard)
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importStep, setImportStep] = useState<'upload' | 'config' | 'processing'>('upload');
  const [importManifest, setImportManifest] = useState<any>(null);
  
  // Import Config State
  const [importSlug, setImportSlug] = useState('');
  const [importName, setImportName] = useState(''); // New: Name Override
  const [importTempPath, setImportTempPath] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importStatusMessage, setImportStatusMessage] = useState('Initializing...');
  
  // Strategies - Forced to Template for Dashboard
  const [importIncludeData, setImportIncludeData] = useState(true);

  // Delete Modal
  const [deleteModal, setDeleteModal] = useState<{ active: boolean, slug: string }>({ active: false, slug: '' });
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchProjects = async () => {
    try {
      const response = await fetch('/api/control/projects', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await response.json();
      setProjects(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Project Registry Sync Failure');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProjects(); }, []);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const name = e.target.value;
      const slug = name.toLowerCase()
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
          .replace(/\s+/g, '-')     
          .replace(/[^a-z0-9-]/g, '') 
          .replace(/--+/g, '-')     
          .replace(/^-+/, '')       
          .replace(/-+$/, '');      
      
      setNewProject(prev => ({ ...prev, name, slug }));
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setCreateError(null);
    try {
      const response = await fetch('/api/control/projects', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify(newProject),
      });
      const data = await response.json();
      if (response.ok) {
        setShowCreateModal(false);
        setNewProject({ name: '', slug: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        fetchProjects();
      } else {
        setCreateError(data.error || "Failed to create project");
      }
    } catch (err: any) {
      setCreateError(err.message || "Network Error");
    } finally {
      setLoading(false);
    }
  };

  const openDeleteModal = (slug: string) => {
      setDeleteModal({ active: true, slug });
      setDeleteConfirmation('');
  };

  const handleConfirmDelete = async () => {
    if (deleteConfirmation !== deleteModal.slug) return;
    setIsDeleting(true);
    try {
        await fetch(`/api/control/projects/${deleteModal.slug}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
        });
        setDeleteModal({ active: false, slug: '' });
        fetchProjects();
    } catch (e) {
        alert("Delete failed.");
    } finally {
        setIsDeleting(false);
    }
  };

  // --- IMPORT LOGIC (CAF 2.0 Async) ---

  const handleUploadAnalyze = async () => {
      if (!importFile) return;
      setLoading(true);
      setImportError(null);
      
      const formData = new FormData();
      formData.append('file', importFile);

      try {
          const res = await fetch('/api/control/projects/import/upload', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
              body: formData
          });
          const data = await res.json();
          
          if (!res.ok) throw new Error(data.error || "Upload failed");
          
          setImportManifest(data.manifest);
          setImportTempPath(data.temp_path);
          
          // Pre-fill slug and name based on manifest
          const baseName = data.manifest.project?.name || 'Imported Project';
          const baseSlug = data.manifest.project?.slug || importFile.name.split('.')[0];
          
          setImportName(baseName + ' (Copy)');
          setImportSlug(baseSlug + '-copy');
          
          setImportStep('config');
      } catch (e: any) {
          setImportError(e.message);
      } finally {
          setLoading(false);
      }
  };

  const handleExecuteImport = async () => {
      if (!importName || !importSlug) {
          setImportError("Name and Slug are required.");
          return;
      }

      setImportStep('processing');
      setImportStatusMessage("Queueing Job...");
      setImportError(null);
      
      try {
          const res = await fetch('/api/control/projects/import/confirm', {
              method: 'POST',
              headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
              },
              body: JSON.stringify({
                  temp_path: importTempPath,
                  slug: importSlug,
                  name: importName,
                  mode: 'template', // Forced Template Mode for Dashboard
                  include_data: importIncludeData,
                  preserve_keys: false // New projects always get new keys
              })
          });

          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Import enqueue failed");

          const operationId = data.operation_id;
          
          // Start Polling
          let attempts = 0;
          const pollInterval = setInterval(async () => {
              attempts++;
              try {
                  const statusRes = await fetch(`/api/control/projects/operations/${operationId}`, {
                      headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
                  });
                  const statusData = await statusRes.json();
                  
                  if (statusData.status === 'completed') {
                      clearInterval(pollInterval);
                      setShowImportModal(false);
                      setImportFile(null);
                      setImportStep('upload');
                      fetchProjects();
                  } else if (statusData.status === 'failed') {
                      clearInterval(pollInterval);
                      setImportError(statusData.result?.error || "Import operation failed in background.");
                      setImportStep('config');
                  } else {
                      setImportStatusMessage(`Processing... (${statusData.status})`);
                  }
                  
                  if (attempts > 300) { // Timeout after 5 mins (approx)
                       clearInterval(pollInterval);
                       setImportError("Operation timed out waiting for status. Check logs.");
                       setImportStep('config');
                  }

              } catch(e) {
                  // Ignore poll errors, retry next tick
              }
          }, 2000);

      } catch (e: any) {
          setImportError(e.message);
          setImportStep('config');
      }
  };

  return (
    <div className="p-8 lg:p-16 max-w-[1600px] mx-auto w-full min-h-screen">
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-16 gap-8">
        <div>
          <h1 className="text-5xl font-black text-slate-900 tracking-tighter mb-4">Registry</h1>
          <p className="text-slate-400 text-lg font-medium max-w-2xl leading-relaxed">Infrastructure-as-Code orchestration for multi-tenant PostgreSQL environments.</p>
        </div>
        <div className="flex gap-4">
            <button 
                onClick={() => setShowImportModal(true)} 
                className="bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 px-6 py-4 rounded-[1.5rem] font-black flex items-center gap-3 transition-all shadow-sm hover:shadow-md text-xs uppercase tracking-widest"
            >
                <Upload size={18} /> New from Template (.CAF)
            </button>
            <button 
                onClick={() => setShowCreateModal(true)} 
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-4 rounded-[1.5rem] font-black flex items-center gap-3 transition-all shadow-[0_20px_40px_rgba(79,70,229,0.3)] hover:-translate-y-1 active:scale-95 text-sm uppercase tracking-widest"
            >
                <Plus size={18} /> Provision Instance
            </button>
        </div>
      </div>

      {loading && projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-40 text-slate-400">
          <Loader2 className="animate-spin mb-6 text-indigo-600" size={64} />
          <p className="font-black text-xs uppercase tracking-widest">Synchronizing Registry...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 pb-40">
          {projects.map((project) => (
            <div key={project.id} className="relative group perspective-1000">
                <ProjectCard project={project} onClick={() => onSelectProject(project.slug)} />
                <button 
                    onClick={(e) => { e.stopPropagation(); openDeleteModal(project.slug); }}
                    className="absolute top-6 right-6 p-3 bg-white text-slate-300 hover:text-rose-600 hover:bg-rose-50 rounded-xl shadow-sm hover:shadow-lg transition-all opacity-0 group-hover:opacity-100 z-50 transform translate-y-2 group-hover:translate-y-0 duration-300"
                    title="Destroy Instance"
                >
                    <Trash2 size={18} />
                </button>
            </div>
          ))}
          
          <button 
            onClick={() => setShowCreateModal(true)}
            className="border-4 border-dashed border-slate-100 rounded-[3.5rem] p-12 flex flex-col items-center justify-center text-slate-300 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/30 transition-all group overflow-hidden relative min-h-[480px]"
          >
            <div className="w-20 h-20 rounded-[1.5rem] bg-slate-50 flex items-center justify-center mb-6 group-hover:bg-white group-hover:shadow-xl transition-all duration-500 group-hover:scale-110">
              <Plus size={32} />
            </div>
            <span className="font-black text-xl tracking-tighter">New Instance</span>
            <p className="text-[10px] font-bold uppercase tracking-widest mt-2 opacity-60">Physical Schema Isolation</p>
          </button>
        </div>
      )}

      {/* CREATE MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-2xl z-[100] flex items-center justify-center p-8 animate-in fade-in duration-500">
          <div className="bg-white rounded-[3.5rem] w-full max-w-xl p-12 shadow-[0_0_150px_rgba(0,0,0,0.5)] border border-slate-100 animate-in zoom-in-95">
            <div className="w-16 h-16 bg-indigo-600 rounded-[1.5rem] flex items-center justify-center text-white mb-8 shadow-2xl">
              <Server size={32} />
            </div>
            <h2 className="text-3xl font-black text-slate-900 mb-4 tracking-tighter">New Infrastructure</h2>
            <p className="text-slate-500 mb-8 text-sm font-medium leading-relaxed">Creating a new project will provision a dedicated PostgreSQL database and generate unique service keys.</p>
            
            {createError && (
              <div className="mb-6 p-4 bg-rose-50 border border-rose-100 rounded-2xl flex items-center gap-3 text-rose-600 text-xs font-bold animate-in slide-in-from-top-2">
                  <AlertTriangle size={16} className="shrink-0" /> {createError}
              </div>
            )}

            <form onSubmit={handleCreateProject} className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Instance Name</label>
                <input 
                  type="text" 
                  value={newProject.name}
                  onChange={handleNameChange}
                  className="w-full bg-slate-50 border border-slate-100 rounded-3xl py-4 px-6 focus:outline-none focus:ring-4 focus:ring-indigo-500/10 text-lg font-bold text-slate-900 placeholder:text-slate-300 transition-all"
                  placeholder="App Production"
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Global Slug (ID)</label>
                <div className="relative">
                  <Terminal className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input 
                    type="text" 
                    value={newProject.slug}
                    onChange={(e) => setNewProject(prev => ({...prev, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')}))}
                    className="w-full bg-slate-50 border border-slate-100 rounded-3xl py-4 pl-14 pr-6 focus:outline-none focus:ring-4 focus:ring-indigo-500/10 font-mono text-sm font-bold text-indigo-600"
                    placeholder="my-saas-infra"
                    required
                  />
                </div>
              </div>

              {/* TIMEZONE SELECTOR */}
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Instance Timezone</label>
                <div className="relative">
                  <Globe className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <select 
                    value={newProject.timezone}
                    onChange={(e) => setNewProject(prev => ({...prev, timezone: e.target.value}))}
                    className="w-full bg-slate-50 border border-slate-100 rounded-3xl py-4 pl-14 pr-6 focus:outline-none focus:ring-4 focus:ring-indigo-500/10 text-sm font-bold text-slate-700 appearance-none cursor-pointer"
                  >
                    {COMMON_TIMEZONES.map(tz => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                    {!COMMON_TIMEZONES.includes(newProject.timezone) && <option value={newProject.timezone}>{newProject.timezone}</option>}
                  </select>
                </div>
                <p className="text-[9px] text-slate-400 px-2">Critical for CRON jobs and Timestamps. Cannot be changed later.</p>
              </div>
              
              <div className="flex gap-4 pt-6">
                <button type="button" onClick={() => setShowCreateModal(false)} className="flex-1 py-4 text-slate-400 font-black hover:bg-slate-50 rounded-3xl transition-all uppercase tracking-widest text-xs">Abort</button>
                <button 
                   type="submit" 
                   disabled={loading}
                   className="flex-[2] py-4 bg-indigo-600 text-white font-black rounded-3xl shadow-xl shadow-indigo-500/30 hover:bg-indigo-700 transition-all uppercase tracking-widest text-xs flex items-center justify-center gap-3 active:scale-95 disabled:opacity-50"
                >
                  {loading ? <Loader2 size={18} className="animate-spin" /> : 'Provision Architecture'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* IMPORT MODAL (CAF 2.0 TEMPLATE WIZARD) */}
      {showImportModal && (
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-2xl z-[100] flex items-center justify-center p-8 animate-in fade-in duration-500">
           <div className="bg-white rounded-[3.5rem] w-full max-w-2xl p-12 shadow-2xl border border-slate-100 relative overflow-hidden flex flex-col max-h-[90vh]">
              
              <div className="flex items-center justify-between mb-8 shrink-0">
                  <div className="flex items-center gap-6">
                      <div className="w-16 h-16 bg-emerald-600 rounded-[1.5rem] flex items-center justify-center text-white shadow-lg"><FileArchive size={32} /></div>
                      <div>
                          <h2 className="text-3xl font-black text-slate-900 tracking-tighter">New from Template</h2>
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Create a new project based on a .CAF snapshot</p>
                      </div>
                  </div>
                  <button onClick={() => setShowImportModal(false)} className="p-4 hover:bg-slate-100 rounded-full text-slate-400 transition-all"><X size={24}/></button>
              </div>

              <div className="flex-1 overflow-y-auto pr-2">
                  {importError && (
                      <div className="mb-6 p-4 bg-rose-50 border border-rose-100 rounded-2xl flex items-center gap-3 text-rose-600 text-xs font-bold animate-in slide-in-from-top-2">
                          <AlertTriangle size={18} className="shrink-0"/> {importError}
                      </div>
                  )}

                  {importStep === 'upload' && (
                      <div className="space-y-8 animate-in slide-in-from-right-4">
                          <div className="border-4 border-dashed border-slate-100 rounded-[3rem] p-12 text-center hover:border-emerald-400 hover:bg-emerald-50/10 transition-all cursor-pointer relative group">
                              <input 
                                  type="file" 
                                  accept=".caf,.zip" 
                                  onChange={(e) => setImportFile(e.target.files?.[0] || null)} 
                                  className="absolute inset-0 opacity-0 cursor-pointer z-10" 
                              />
                              <div className="flex flex-col items-center gap-4">
                                  <div className="w-20 h-20 bg-slate-50 rounded-[2rem] flex items-center justify-center text-slate-400 group-hover:text-emerald-600 transition-colors shadow-sm">
                                      <Upload size={32} />
                                  </div>
                                  <div>
                                      <p className="text-xl font-bold text-slate-700">{importFile ? importFile.name : 'Drop .CAF file here'}</p>
                                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-2">Cascata Archive v2.0</p>
                                  </div>
                              </div>
                          </div>
                          
                          <button 
                              onClick={handleUploadAnalyze}
                              disabled={!importFile || loading}
                              className="w-full py-5 bg-slate-900 text-white font-black rounded-[2rem] shadow-xl hover:bg-indigo-600 transition-all uppercase tracking-widest text-xs flex items-center justify-center gap-3 disabled:opacity-50 active:scale-95"
                          >
                              {loading ? <Loader2 size={18} className="animate-spin" /> : 'Analyze & Configure'}
                          </button>
                      </div>
                  )}

                  {importStep === 'config' && importManifest && (
                      <div className="space-y-8 animate-in slide-in-from-right-4">
                          
                          {/* Manifest Info */}
                          <div className="bg-slate-50 border border-slate-100 rounded-[2.5rem] p-6 space-y-4">
                              <div className="flex items-center gap-3 px-2">
                                  <FileText size={16} className="text-indigo-500"/>
                                  <span className="text-xs font-black text-slate-400 uppercase tracking-widest">Source Snapshot</span>
                              </div>
                              <div className="grid grid-cols-2 gap-4">
                                  <div className="bg-white p-4 rounded-2xl border border-slate-100">
                                      <span className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Original Name</span>
                                      <span className="text-sm font-bold text-slate-800">{importManifest.project.name}</span>
                                  </div>
                                  <div className="bg-white p-4 rounded-2xl border border-slate-100">
                                      <span className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Export Date</span>
                                      <span className="text-sm font-bold text-slate-800">{new Date(importManifest.exported_at).toLocaleDateString()}</span>
                                  </div>
                              </div>
                          </div>

                          {/* Identity Override */}
                          <div className="space-y-6">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2">Target Name</label>
                                    <input 
                                        value={importName}
                                        onChange={(e) => setImportName(e.target.value)}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-[1.5rem] py-4 px-6 font-bold text-slate-800 outline-none focus:ring-4 focus:ring-indigo-500/10"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-2">Target Slug</label>
                                    <input 
                                        value={importSlug}
                                        onChange={(e) => setImportSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-[1.5rem] py-4 px-6 font-bold text-indigo-600 outline-none focus:ring-4 focus:ring-indigo-500/10 font-mono"
                                    />
                                </div>
                              </div>

                              <div 
                                onClick={() => setImportIncludeData(!importIncludeData)}
                                className="flex items-center gap-4 p-4 bg-slate-50 rounded-[1.5rem] border border-slate-200 cursor-pointer hover:bg-slate-100 transition-colors"
                              >
                                  <div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-colors ${importIncludeData ? 'bg-indigo-600 border-indigo-600' : 'bg-white border-slate-300'}`}>
                                      {importIncludeData && <CheckCircle2 size={14} className="text-white"/>}
                                  </div>
                                  <div>
                                      <span className="text-xs font-bold text-slate-700 block">Include Sample Data</span>
                                      <span className="text-[10px] text-slate-400">Clone database rows from the snapshot. Uncheck for structure only.</span>
                                  </div>
                              </div>
                              
                              <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-2xl flex gap-3">
                                  <Info size={16} className="text-indigo-600 shrink-0 mt-0.5"/>
                                  <p className="text-[10px] text-indigo-800 font-medium">This will create a completely new project with fresh API keys and secrets.</p>
                              </div>
                          </div>
                          
                          <div className="flex gap-4 pt-4">
                              <button onClick={() => setImportStep('upload')} className="flex-1 py-5 text-slate-400 font-black uppercase tracking-widest text-xs hover:bg-slate-50 rounded-[2rem]">Back</button>
                              <button onClick={handleExecuteImport} className="flex-[2] py-5 bg-emerald-600 text-white font-black rounded-[2rem] shadow-xl hover:bg-emerald-700 transition-all uppercase tracking-widest text-xs flex items-center justify-center gap-2">
                                  <CheckCircle2 size={16}/> Create Project
                              </button>
                          </div>
                      </div>
                  )}

                  {importStep === 'processing' && (
                      <div className="py-20 flex flex-col items-center justify-center text-center animate-in zoom-in-95">
                          <div className="relative mb-8">
                              <div className="absolute inset-0 bg-emerald-500 blur-3xl opacity-20 rounded-full animate-pulse"></div>
                              <Loader2 size={80} className="text-emerald-600 animate-spin relative z-10" />
                          </div>
                          <h3 className="text-2xl font-black text-slate-900 mb-2 tracking-tight">Provisioning...</h3>
                          <p className="text-slate-400 font-bold uppercase tracking-widest text-[10px] max-w-xs mx-auto leading-relaxed">
                              {importStatusMessage}
                          </p>
                      </div>
                  )}
              </div>
           </div>
        </div>
      )}

      {/* SAFETY DELETE MODAL */}
      {deleteModal.active && (
          <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-2xl z-[200] flex items-center justify-center p-8 animate-in zoom-in-95 duration-300">
              <div className="bg-white rounded-[3.5rem] w-full max-w-lg p-12 shadow-2xl border border-rose-100 text-center relative overflow-hidden">
                  <div className="w-20 h-20 bg-rose-50 text-rose-600 rounded-[1.5rem] flex items-center justify-center mx-auto mb-8 shadow-inner">
                      <AlertTriangle size={40} strokeWidth={2.5}/>
                  </div>
                  <h3 className="text-3xl font-black text-slate-900 mb-3 tracking-tighter">Danger Zone</h3>
                  <p className="text-sm font-medium text-slate-500 mb-8 leading-relaxed">
                      This action will <b>permanently destroy</b> the database, all storage files, and API configurations for <span className="text-slate-900 font-bold">{deleteModal.slug}</span>. This cannot be undone.
                  </p>

                  <div className="space-y-3 mb-8 text-left">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Type <span className="text-rose-600">{deleteModal.slug}</span> to confirm</label>
                      <input 
                        autoFocus
                        value={deleteConfirmation}
                        onChange={(e) => setDeleteConfirmation(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-3xl py-4 px-6 text-center font-bold text-slate-900 outline-none focus:border-rose-500 focus:ring-4 focus:ring-rose-500/10 transition-all placeholder:text-slate-300"
                        placeholder={deleteModal.slug}
                      />
                  </div>

                  <div className="flex gap-4">
                      <button 
                        onClick={() => setDeleteModal({active: false, slug: ''})}
                        className="flex-1 py-4 text-xs font-black text-slate-400 uppercase tracking-widest hover:bg-slate-50 rounded-3xl transition-all"
                      >
                          Cancel
                      </button>
                      <button 
                        onClick={handleConfirmDelete}
                        disabled={deleteConfirmation !== deleteModal.slug || isDeleting}
                        className="flex-[2] py-4 bg-rose-600 text-white rounded-3xl font-black text-xs uppercase tracking-widest shadow-xl shadow-rose-500/30 hover:bg-rose-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      >
                          {isDeleting ? <Loader2 size={16} className="animate-spin"/> : <><Trash2 size={16}/> Destroy Instance</>}
                      </button>
                  </div>
              </div>
          </div>
      )}
    </div>
  );
};

const ProjectCard: React.FC<{ project: Project, onClick: () => void }> = ({ project, onClick }) => {
  return (
    <div 
      onClick={onClick}
      className="group relative bg-white border-2 border-slate-100 rounded-[3.5rem] p-10 hover:shadow-[0_40px_80px_rgba(0,0,0,0.08)] hover:border-indigo-100 transition-all duration-500 cursor-pointer flex flex-col h-[480px] overflow-hidden"
    >
      <div className="absolute top-0 right-0 p-10 opacity-5 group-hover:scale-150 group-hover:rotate-12 transition-all duration-700">
        <Database size={180} />
      </div>
      
      <div className="flex items-start justify-between mb-12 relative z-10">
        <div className="w-16 h-16 rounded-[1.5rem] bg-slate-900 flex items-center justify-center text-white group-hover:bg-indigo-600 transition-all duration-500 shadow-2xl group-hover:shadow-indigo-500/40">
          <Database size={28} />
        </div>
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border ${project.status === 'healthy' ? 'bg-emerald-50 border-emerald-100' : 'bg-rose-50 border-rose-100'}`}>
          <div className={`w-2 h-2 rounded-full ${project.status === 'healthy' ? 'bg-emerald-500' : 'bg-rose-500'} animate-pulse`}></div>
          <span className={`text-[9px] font-black uppercase tracking-widest ${project.status === 'healthy' ? 'text-emerald-600' : 'text-rose-600'}`}>{project.status}</span>
        </div>
      </div>
      
      <div className="relative z-10">
        <h3 className="text-3xl font-black text-slate-900 group-hover:text-indigo-600 transition-colors mb-2 tracking-tighter leading-none truncate pr-2">
          {project.name}
        </h3>
        <p className="text-xs text-slate-400 font-mono bg-slate-50 px-3 py-1.5 rounded-xl inline-block w-fit mt-4 border border-slate-100">
          /{project.slug}
        </p>
      </div>
      
      <div className="mt-auto space-y-4 relative z-10 mb-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600"><Key size={14}/></div>
             <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Isolated Auth</span>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600"><Shield size={14}/></div>
             <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Zero Trust</span>
          </div>
        </div>
      </div>

      <div className="pt-8 border-t border-slate-50 flex items-center justify-between text-indigo-600 text-sm font-black relative z-10 group/btn">
        <span className="group-hover:translate-x-2 transition-all duration-300 inline-block uppercase tracking-[0.2em] text-[10px]">Open Console</span>
        <div className="w-10 h-10 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-indigo-600 group-hover:text-white transition-all">
          <ArrowRight size={16} className="-ml-0.5"/>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
