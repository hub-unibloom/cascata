
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Folder, File, Upload, HardDrive, Search, Trash2, 
  Download, Image as ImageIcon, FileText, MoreVertical, 
  Plus, Loader2, CheckCircle2, ChevronRight, AlertCircle,
  FolderPlus, ChevronDown, MoreHorizontal, Copy, Edit, 
  ExternalLink, ArrowRight, Filter, SortAsc, SortDesc,
  Grid, List, X, Move, Share2, Settings2, Shield, Eye,
  Check, Square, CheckSquare, Zap, ShieldAlert, Lock,
  MousePointer2, CornerUpRight, Cloud, Server, Box, Globe,
  Save, Database, Key, RefreshCw, Wand2, AlertTriangle, FileCode
} from 'lucide-react';

interface StorageItem {
  name: string;
  type: 'file' | 'folder';
  size: number;
  updated_at: string;
  path: string;
}

const SECTOR_DEFINITIONS = [
  { id: 'visual', label: 'Visual Content (Images)', desc: 'Raster and vector static visuals.', exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'avif', 'heic', 'heif'], defaults: ['jpg', 'jpeg', 'png', 'webp', 'svg'] },
  { id: 'motion', label: 'Motion Content (Videos)', desc: 'Dynamic animations and video files.', exts: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp'], defaults: ['mp4', 'mov', 'webm'] },
  { id: 'audio', label: 'Audio Content', desc: 'Music, voice, podcasts and messages.', exts: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'm4p', 'amr', 'mid', 'midi', 'opus'], defaults: ['mp3', 'wav', 'ogg', 'm4a'] },
  { id: 'docs', label: 'Document Registry', desc: 'Formal documents and readable data.', exts: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'pages', 'epub', 'mobi', 'azw3'], defaults: ['pdf', 'doc', 'docx', 'txt'] },
  { id: 'structured', label: 'Structured Data & Exchanges', desc: 'Import/Export pipelines and integrations.', exts: ['csv', 'json', 'xml', 'yaml', 'yml', 'sql', 'xls', 'xlsx', 'ods', 'tsv', 'parquet', 'avro'], defaults: ['csv', 'json', 'xlsx'] },
  { id: 'archives', label: 'Archives & Bundles', desc: 'Compressed packages and backups.', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'iso', 'dmg', 'pkg', 'xz', 'zst'], defaults: ['zip', 'rar', '7z'] },
  { id: 'exec', label: 'Executables & Installers', desc: 'Binary execution packages.', exts: ['exe', 'msi', 'bin', 'app', 'deb', 'rpm', 'sh', 'bat', 'cmd', 'vbs', 'ps1'], defaults: [] },
  { id: 'scripts', label: 'Scripts & Automation', desc: 'Interpreted code and system hooks.', exts: ['js', 'ts', 'py', 'rb', 'php', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'cs', 'swift', 'kt'], defaults: ['js', 'ts', 'py'] },
  { id: 'config', label: 'Configuration & Environment', exts: ['env', 'config', 'ini', 'xml', 'manifest', 'lock', 'gitignore', 'editorconfig', 'toml'], desc: 'Sensitive infrastructure manifests.', defaults: ['env', 'config', 'json', 'yml'] },
  { id: 'telemetry', label: 'Logs, Reports & Telemetry', exts: ['log', 'dump', 'out', 'err', 'crash', 'report', 'audit'], desc: 'System generated data and dumps.', defaults: ['log', 'report'] },
  { id: 'messaging', label: 'Messaging & Artifacts', exts: ['eml', 'msg', 'vcf', 'chat', 'ics', 'pbx'], desc: 'Communication exports and attachments.', defaults: ['eml', 'vcf'] },
  { id: 'ui_assets', label: 'Fonts & UI Assets', exts: ['ttf', 'otf', 'woff', 'woff2', 'eot', 'sketch', 'fig', 'ai', 'psd', 'xd'], desc: 'Typography and design interface assets.', defaults: ['ttf', 'otf', 'woff2'] },
  { id: 'simulation', label: '3D, CAD & Simulation', exts: ['obj', 'stl', 'fbx', 'dwg', 'dxf', 'dae', 'blend', 'step', 'iges', 'glf', 'gltf', 'glb'], desc: 'Heavy engineering and gaming assets.', defaults: ['obj', 'stl', 'glb'] },
  { id: 'backup_sys', label: 'Backup & Snapshots', exts: ['bak', 'sql', 'snapshot', 'dump', 'db', 'sqlite', 'sqlite3', 'rdb'], desc: 'System restoration and state data.', defaults: ['bak', 'sql'] },
  { id: 'global', label: 'Global Binary Limit', exts: [], desc: 'Fallback absolute rule for everything else.', defaults: [] }
];

const STORAGE_PROVIDERS = [
  { id: 'local', name: 'Local Storage', icon: Server, desc: 'Armazenamento em disco no servidor.' },
  { id: 's3', name: 'S3 Compatible', icon: Database, desc: 'AWS S3, R2, Wasabi, MinIO, DigitalOcean.' },
  { id: 'cloudinary', name: 'Cloudinary', icon: Cloud, desc: 'Otimização de mídia e CDN global.' },
  { id: 'imagekit', name: 'ImageKit', icon: ImageIcon, desc: 'CDN de imagem em tempo real.' },
  { id: 'gdrive', name: 'Google Drive', icon: HardDrive, desc: 'Integração via Google Workspace API.' },
  { id: 'onedrive', name: 'OneDrive', icon: Cloud, desc: 'Microsoft Graph API Storage.' },
  { id: 'dropbox', name: 'Dropbox', icon: Box, desc: 'Armazenamento de arquivos simples.' }
];

// Physical Limit Hardcoded in Nginx/Node
const PHYSICAL_LIMIT_BYTES = 100 * 1024 * 1024; // 100MB

const StorageExplorer: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [buckets, setBuckets] = useState<any[]>([]);
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [items, setItems] = useState<StorageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  
  // View States
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [sortBy, setSortBy] = useState<string>('newest');
  
  // Auth State
  const [lastVerifiedTime, setLastVerifiedTime] = useState<number>(0);
  
  // Modals & Popups
  const [showNewBucket, setShowNewBucket] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [showConnectModal, setShowConnectModal] = useState(false);

  const [expandedSector, setExpandedSector] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [moveDestination, setMoveDestination] = useState({ bucket: '', path: '' });
  const [verifyPassword, setVerifyPassword] = useState('');
  const [pendingAction, setPendingAction] = useState<(() => Promise<void>) | null>(null);

  const [draggedItem, setDraggedItem] = useState<StorageItem | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null>(null); 

  const [governanceSearch, setGovernanceSearch] = useState('');
  const [newCustomExt, setNewCustomExt] = useState('');

  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, type: 'bucket' | 'item', data: any } | null>(null);

  const [governance, setGovernance] = useState<any>({});
  
  // Storage Configuration State (Provider Settings)
  const [storageConfig, setStorageConfig] = useState<any>({ provider: 'local', optimize: false });
  const [activeConfigTab, setActiveConfigTab] = useState('local');

  // --- HELPERS ---
  const fetchWithAuth = useCallback(async (url: string, options: any = {}) => {
    const token = localStorage.getItem('cascata_token');
    const headers = { 'Authorization': `Bearer ${token}`, ...options.headers };
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
        const errorText = await res.text();
        let errorMessage = `HTTP ${res.status}`;
        try {
            const json = JSON.parse(errorText);
            errorMessage = json.error || errorMessage;
        } catch {}
        throw new Error(errorMessage);
    }
    return res.json();
  }, []);

  const getSecureDownloadLink = (path: string) => {
    const token = localStorage.getItem('cascata_token');
    return `${window.location.origin}/api/data/${projectId}/storage/${selectedBucket}/object/${path}?apikey=${token}`; 
  };

  const safeCopyToClipboard = (text: string) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text);
      setSuccess("Link copiado!");
      setTimeout(() => setSuccess(null), 2000);
    } else {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        setSuccess("Link copiado!");
        setTimeout(() => setSuccess(null), 2000);
      } catch (err) {
        setError("Erro ao copiar link.");
      }
      document.body.removeChild(textArea);
    }
  };

  const toggleSelect = (path: string) => {
    const next = new Set(selectedItems);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelectedItems(next);
  };

  // --- DATA FETCHING ---
  const fetchBuckets = async () => {
    try {
      const data = await fetchWithAuth(`/api/data/${projectId}/storage/buckets`);
      setBuckets(data);
      if (data.length > 0 && !selectedBucket) setSelectedBucket(data[0].name);
    } catch (e) { console.error("Storage offline"); }
  };

  const fetchItems = async () => {
    setLoading(true);
    try {
      let url = '';
      if (searchQuery) {
        const bucketParam = selectedBucket ? `&bucket=${selectedBucket}` : '';
        url = `/api/data/${projectId}/storage/search?q=${encodeURIComponent(String(searchQuery))}${bucketParam}`;
      } else {
        if (!selectedBucket) { setLoading(false); return; }
        url = `/api/data/${projectId}/storage/${selectedBucket}/list?path=${encodeURIComponent(String(currentPath))}`;
      }

      const data = await fetchWithAuth(url);
      setItems(data.items || []);
      if (!searchQuery) setSelectedItems(new Set());
    } catch (e: any) { setError("Falha na listagem."); }
    finally { setLoading(false); }
  };

  const fetchProjectData = async () => {
    const data = await fetchWithAuth('/api/control/projects');
    const proj = data.find((p: any) => p.slug === projectId);
    if (proj?.metadata?.storage_governance) {
      setGovernance(proj.metadata.storage_governance);
    } else {
      const initial: any = {};
      SECTOR_DEFINITIONS.forEach(s => {
        initial[s.id] = { 
            max_size: s.id === 'global' ? '100MB' : '10MB', // Internal
            max_size_direct: '5GB', // External Default
            allowed_exts: s.defaults 
        };
      });
      setGovernance(initial);
    }
    if (proj?.metadata?.storage_config) {
        setStorageConfig(proj.metadata.storage_config);
        setActiveConfigTab(proj.metadata.storage_config.provider || 'local');
    }
  };

  useEffect(() => { fetchBuckets(); fetchProjectData(); }, [projectId]);
  
  useEffect(() => { 
      const timer = setTimeout(() => fetchItems(), 100);
      return () => clearTimeout(timer);
  }, [selectedBucket, currentPath, searchQuery]);

  useEffect(() => {
    const hide = () => setContextMenu(null);
    window.addEventListener('click', hide);
    return () => window.removeEventListener('click', hide);
  }, []);

  // --- INTERACTION ---
  const handleItemClick = (e: React.MouseEvent, item: StorageItem) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
        toggleSelect(item.path);
        return;
    }
    
    if (item.type === 'folder') {
        // Folder: Single click navigates
        setCurrentPath(item.path);
        setSearchQuery('');
        setSelectedItems(new Set()); // Clear selection on navigate
    } else {
        // File: Single click selects
        setSelectedItems(new Set([item.path]));
    }
  };

  const handleItemDoubleClick = (item: StorageItem) => {
      if (item.type === 'folder') {
          // Folder: Double click selects
          toggleSelect(item.path);
      } else {
          // File: Double click opens/downloads
          window.open(getSecureDownloadLink(item.path), '_blank');
      }
  };

  const handleCreateFolder = async () => {
      if(!newName) return;
      try {
          await fetchWithAuth(`/api/data/${projectId}/storage/${selectedBucket}/folder`, { 
              method: 'POST', 
              body: JSON.stringify({ name: newName, path: currentPath }) 
          });
          setNewName('');
          setShowNewFolder(false);
          fetchItems();
          setSuccess("Pasta criada.");
      } catch(e: any) {
          setError(e.message);
      }
  };

  // --- HYBRID UPLOAD (Direct vs Proxy) ---
  const handleUpload = async (files: FileList | null, targetPath: string = currentPath, targetBucket: string = selectedBucket!) => {
      if (!files || !targetBucket) return;
      setIsUploading(true);
      setError(null);
      
      try {
          let successCount = 0;
          
          for (let i = 0; i < files.length; i++) {
              const file = files[i];
              setUploadProgress(Math.round(((i) / files.length) * 100));

              // 1. Negotiate (Get Strategy)
              const signRes = await fetchWithAuth(`/api/data/${projectId}/storage/${targetBucket}/sign`, {
                  method: 'POST',
                  body: JSON.stringify({ 
                      name: file.name, 
                      type: file.type, 
                      size: file.size, 
                      path: targetPath 
                  })
              });

              if (signRes.error) throw new Error(signRes.error);

              // 2. Execute based on Strategy
              if (signRes.strategy === 'direct') {
                  // Direct Upload (PUT to S3/Cloud)
                  await fetch(signRes.url, {
                      method: signRes.method,
                      headers: signRes.fields || { 'Content-Type': file.type },
                      body: file
                  });
              } else {
                  // Proxy Upload (Standard Multipart)
                  const formData = new FormData();
                  formData.append('file', file);
                  formData.append('path', targetPath);
                  await fetchWithAuth(`/api/data/${projectId}/storage/${targetBucket}/upload`, { 
                      method: 'POST', 
                      body: formData 
                  });
              }
              successCount++;
          }
          
          if (targetBucket === selectedBucket) {
              fetchItems();
          }
          setSuccess(`${successCount} arquivos enviados.`);
      } catch (e: any) { 
          setError(e.message || "Erro no upload."); 
      } finally { 
          setIsUploading(false);
          setUploadProgress(0); 
      }
  };

  // --- DRAG & DROP LOGIC ---

  const handleDragStartItem = (e: React.DragEvent, item: StorageItem) => {
    setDraggedItem(item);
    e.dataTransfer.setData('text/plain', item.path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDropOnTarget = (e: React.DragEvent, targetBucket: string, targetPath: string) => {
      e.preventDefault(); e.stopPropagation(); setDragTarget(null);
      
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          handleUpload(e.dataTransfer.files, targetPath, targetBucket);
          return;
      }

      if (draggedItem) {
          if (targetBucket === selectedBucket && targetPath.startsWith(draggedItem.path)) return;
          
          const move = async () => {
              try {
                  await fetchWithAuth(`/api/data/${projectId}/storage/move`, {
                      method: 'POST',
                      body: JSON.stringify({
                          bucket: selectedBucket,
                          paths: [draggedItem.path],
                          destination: { bucket: targetBucket, path: targetPath } 
                      })
                  });
                  if (selectedBucket === targetBucket || targetBucket === selectedBucket) {
                      fetchItems();
                  }
                  setSuccess(`Moved to ${targetPath || targetBucket}`);
              } catch (err: any) { setError("Failed to move item."); }
          };
          move();
          setDraggedItem(null);
      }
  };

  const handleDragEnter = (e: React.DragEvent, id: string) => {
      e.preventDefault(); e.stopPropagation();
      setDragTarget(id);
  };

  const handleDragLeave = (e: React.DragEvent, id: string) => {
      e.preventDefault(); e.stopPropagation();
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      if (dragTarget === id) setDragTarget(null);
  };

  // --- ACTIONS (Delete, Rename, Move, Config) ---

  const handleSaveStorageConfig = async () => {
      try {
          const newConfig = { ...storageConfig, provider: activeConfigTab };
          await fetchWithAuth(`/api/control/projects/${projectId}`, {
              method: 'PATCH',
              body: JSON.stringify({ metadata: { storage_config: newConfig } })
          });
          setStorageConfig(newConfig);
          setSuccess("Provedor de armazenamento atualizado.");
          setShowConnectModal(false);
      } catch (e: any) {
          setError("Erro ao salvar configuração.");
      }
  };

  const checkAuth = (action: () => Promise<void>, requiresAuth: boolean = true) => {
    const isSessionValid = (Date.now() - lastVerifiedTime) < 3600000;
    if (!requiresAuth || isSessionValid) {
        action();
    } else {
        setPendingAction(() => action);
        setShowVerifyModal(true);
    }
  };

  const handleVerifyAndExecute = async () => {
    try {
      const res = await fetch('/api/control/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
        body: JSON.stringify({ password: verifyPassword })
      });
      if (res.ok) {
        setLastVerifiedTime(Date.now());
        setShowVerifyModal(false);
        setVerifyPassword('');
        if (pendingAction) await pendingAction();
        setPendingAction(null);
      } else {
        setError("Senha incorreta.");
      }
    } catch (e: any) { setError("Erro na verificação."); }
  };

  const handleDeleteBucket = async (bucketName: string) => {
    const isCurrentBucket = bucketName === selectedBucket;
    const isEmpty = isCurrentBucket && items.length === 0;
    
    checkAuth(async () => {
        try {
            await fetchWithAuth(`/api/data/${projectId}/storage/buckets/${bucketName}`, { method: 'DELETE' });
            if (isCurrentBucket) {
                setSelectedBucket(null);
                setItems([]);
            }
            fetchBuckets();
            setSuccess("Bucket deleted successfully");
        } catch (e: any) { setError("Failed to delete bucket"); }
    }, !isEmpty); 
  };

  const handleBulkDelete = async () => {
    const paths = Array.from(selectedItems);
    if (paths.length === 0) return;

    checkAuth(async () => {
      try {
        for (const p of paths) {
          await fetchWithAuth(`/api/data/${projectId}/storage/${selectedBucket}/object?path=${encodeURIComponent(String(p))}`, { method: 'DELETE' });
        }
        setSelectedItems(new Set());
        fetchItems();
        setSuccess("Itens removidos.");
      } catch (e: any) { setError("Erro ao deletar."); }
    }, true);
  };

  const handleMove = async () => {
    const paths = Array.from(selectedItems);
    if (!moveDestination.bucket || paths.length === 0) return;
    try {
      await fetchWithAuth(`/api/data/${projectId}/storage/move`, {
        method: 'POST',
        body: JSON.stringify({
          bucket: selectedBucket,
          paths,
          destination: moveDestination
        })
      });
      setShowMoveModal(false);
      setSelectedItems(new Set());
      fetchItems();
      setSuccess("Transferência concluída.");
    } catch (e: any) { setError("Erro ao mover."); }
  };

  const handleRenameBucket = async (newName: string) => {
    if (!contextMenu?.data?.name) return;
    try {
      await fetchWithAuth(`/api/data/${projectId}/storage/buckets/${contextMenu.data.name}`, {
        method: 'PATCH',
        body: JSON.stringify({ newName })
      });
      fetchBuckets();
      setSuccess("Bucket renomeado.");
    } catch (e: any) { setError("Falha ao renomear."); }
  };

  // --- GOVERNANCE UI HELPERS ---
  const updateSectorSize = (sectorId: string, val: string, unit: string, isDirect: boolean = false) => {
    const combined = `${val}${unit}`;
    const key = isDirect ? 'max_size_direct' : 'max_size';
    setGovernance({ ...governance, [sectorId]: { ...governance[sectorId], [key]: combined } });
  };

  const parseSizeValue = (str: string) => {
    const match = str?.match(/^(\d+(?:\.\d+)?)/);
    return match ? match[1] : '';
  };

  const parseSizeUnit = (str: string) => {
    const match = str?.match(/([a-zA-Z]+)$/);
    return match ? match[1] : 'MB';
  };

  const checkPhysicalLimit = (valStr: string) => {
      const val = parseFloat(parseSizeValue(valStr) || '0');
      const unit = parseSizeUnit(valStr);
      const multipliers: any = { 'B': 1, 'KB': 1024, 'MB': 1024*1024, 'GB': 1024*1024*1024 };
      const bytes = val * (multipliers[unit.toUpperCase()] || 1);
      return bytes > PHYSICAL_LIMIT_BYTES;
  };

  const addCustomExtension = (sectorId: string) => {
      if (!newCustomExt) return;
      const cleanExt = newCustomExt.replace(/^\./, '').toLowerCase();
      const current = governance[sectorId]?.allowed_exts || [];
      if (!current.includes(cleanExt)) {
          const next = [...current, cleanExt];
          setGovernance({ ...governance, [sectorId]: { ...governance[sectorId], allowed_exts: next } });
      }
      setNewCustomExt('');
  };

  // --- RENDER HELPERS ---
  const sortedItems = useMemo(() => {
    let result = items;
    if (!searchQuery && filterType !== 'all') {
      const allowed = SECTOR_DEFINITIONS.find(s => s.id === filterType)?.exts || [];
      result = result.filter(i => i.type === 'folder' || allowed.includes(i.name.split('.').pop()?.toLowerCase() || ''));
    }
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      if (sortBy === 'newest') return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      return a.name.localeCompare(b.name);
    });
    return result;
  }, [items, searchQuery, filterType, sortBy]);

  const activeProviderName = STORAGE_PROVIDERS.find(p => p.id === storageConfig.provider)?.name || 'Local Storage';
  const ActiveProviderIcon = STORAGE_PROVIDERS.find(p => p.id === storageConfig.provider)?.icon || Server;

  return (
    <div 
      className="flex h-full flex-col bg-[#F8FAFC] overflow-hidden relative" 
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={e => e.preventDefault()} 
      onDrop={e => {
          if (!dragTarget) {
              handleDropOnTarget(e, selectedBucket!, currentPath);
          }
      }}
    >
      
      {/* Toast */}
      {(error || success) && (
        <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[600] px-6 py-4 rounded-full shadow-2xl flex items-center gap-3 animate-in slide-in-from-top-4 ${error ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`}>
          {error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span className="text-xs font-bold">{error || success}</span>
          <button onClick={() => { setError(null); setSuccess(null); }} className="ml-2 opacity-60"><X size={14} /></button>
        </div>
      )}

      {/* Floating Bulk Actions */}
      {selectedItems.size > 0 && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[500] bg-slate-900 text-white p-2 pl-6 pr-2 rounded-2xl shadow-2xl flex items-center gap-6 animate-in slide-in-from-bottom-4">
          <span className="text-xs font-black uppercase tracking-widest">{selectedItems.size} Selected</span>
          <div className="flex gap-2">
             <button onClick={() => { setMoveDestination({bucket: selectedBucket!, path: ''}); setShowMoveModal(true); }} className="p-3 hover:bg-white/10 rounded-xl transition-all flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest"><CornerUpRight size={14}/> Move</button>
             <button onClick={handleBulkDelete} className="p-3 bg-rose-600 hover:bg-rose-700 rounded-xl transition-all flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest"><Trash2 size={14}/> Delete</button>
             <button onClick={() => setSelectedItems(new Set())} className="p-3 hover:bg-white/10 rounded-xl transition-all"><X size={14}/></button>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div 
          className="fixed z-[700] bg-white border border-slate-200 shadow-2xl rounded-2xl p-2 w-56 animate-in fade-in zoom-in-95" 
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'bucket' ? (
            <>
              <button onClick={() => { const name = prompt("Novo nome:", contextMenu.data.name); if(name) handleRenameBucket(name); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Edit size={14}/> Rename Bucket</button>
              <button onClick={() => { setShowNewFolder(true); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><FolderPlus size={14}/> New Folder</button>
              <button onClick={() => window.location.hash = `#/project/${projectId}/rls-editor/bucket/${contextMenu.data.name}`} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Shield size={14}/> Security Policies</button>
              <div className="h-[1px] bg-slate-100 my-1"></div>
              <button onClick={() => { handleDeleteBucket(contextMenu.data.name); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-xl transition-all"><Trash2 size={14}/> Delete Bucket</button>
            </>
          ) : (
            <>
              {contextMenu.data.type === 'folder' && (
                 <button onClick={() => { setShowNewFolder(true); setCurrentPath(contextMenu.data.path); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><FolderPlus size={14}/> New Folder Inside</button>
              )}
              <button onClick={() => { safeCopyToClipboard(getSecureDownloadLink(contextMenu.data.path)); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Share2 size={14}/> Copy Public URL</button>
              <button onClick={() => { setSelectedItems(new Set([contextMenu.data.path])); setMoveDestination({bucket: selectedBucket!, path: ''}); setShowMoveModal(true); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Move size={14}/> Move Asset</button>
              <div className="h-[1px] bg-slate-100 my-1"></div>
              <button onClick={() => { toggleSelect(contextMenu.data.path); handleBulkDelete(); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-xl transition-all"><Trash2 size={14}/> Delete Asset</button>
            </>
          )}
        </div>
      )}

      {/* Header */}
      <header className="px-10 py-6 bg-white border-b border-slate-200 flex items-center justify-between shrink-0 z-10 shadow-sm">
        <div className="flex items-center gap-6">
          <div className="w-14 h-14 bg-slate-900 text-white rounded-[1.5rem] flex items-center justify-center shadow-xl"><HardDrive size={28} /></div>
          <div><h2 className="text-3xl font-black text-slate-900 tracking-tighter leading-none">Storage Engine</h2><p className="text-[10px] text-indigo-600 font-bold uppercase tracking-[0.2em] mt-1">Sovereign Object Infrastructure</p></div>
        </div>
        <div className="flex items-center gap-4">
           {/* CONNECTION MANAGER BUTTON */}
           <button onClick={() => setShowConnectModal(true)} className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all ${storageConfig.provider === 'local' ? 'bg-slate-100 text-slate-500 hover:bg-slate-200' : 'bg-emerald-50 text-emerald-600 border border-emerald-100'}`}>
              <ActiveProviderIcon size={14}/>
              {storageConfig.provider === 'local' ? 'Local Storage' : storageConfig.provider.toUpperCase()}
           </button>
           
           <div className="w-[1px] h-8 bg-slate-100 mx-2"></div>
           <div className="relative group mr-4">
             <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
             <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Global Search..." className="pl-12 pr-6 py-3 bg-slate-100 border-none rounded-2xl text-xs font-bold outline-none w-64 transition-all focus:ring-2 focus:ring-indigo-500/10" />
           </div>
           <button onClick={() => setShowSettings(true)} className="p-3 text-slate-400 hover:text-indigo-600 transition-all"><Settings2 size={24}/></button>
           <button onClick={() => setShowNewFolder(true)} disabled={!selectedBucket} className="p-3 text-slate-400 hover:text-indigo-600 transition-all"><FolderPlus size={24} /></button>
           <label className={`cursor-pointer bg-indigo-600 text-white px-8 py-3.5 rounded-2xl text-xs font-black uppercase tracking-widest flex items-center gap-3 hover:bg-indigo-700 shadow-xl ${!selectedBucket || isUploading ? 'opacity-50' : ''}`}>
             {isUploading ? <Loader2 size={18} className="animate-spin" /> : <><Upload size={18} /> Ingest Data</>}
             <input type="file" multiple className="hidden" onChange={(e) => handleUpload(e.target.files)} disabled={!selectedBucket || isUploading} />
           </label>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-80 border-r border-slate-200 bg-white flex flex-col shrink-0">
           <div className="p-6 border-b border-slate-50"><button onClick={() => setShowNewBucket(true)} className="w-full py-4 border-2 border-dashed border-slate-200 rounded-2xl text-[10px] font-black text-slate-400 uppercase tracking-widest hover:border-indigo-400 transition-all flex items-center justify-center gap-2"><Plus size={14} /> New Bucket</button></div>
           <div className="flex-1 overflow-y-auto p-4 space-y-1">
             <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest px-4 mb-4 block">Registry Root</span>
             {buckets.map(b => (
               <div 
                 key={b.name} 
                 onClick={() => { setSelectedBucket(b.name); setCurrentPath(''); setSearchQuery(''); }} 
                 onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, type: 'bucket', data: b }); }}
                 // Drag Handlers for Sidebar (Bucket Target)
                 onDragOver={(e) => handleDragEnter(e, `bucket-${b.name}`)}
                 onDragLeave={(e) => handleDragLeave(e, `bucket-${b.name}`)}
                 onDrop={(e) => handleDropOnTarget(e, b.name, '')}
                 className={`w-full flex items-center justify-between px-5 py-4 rounded-2xl transition-all cursor-pointer group 
                    ${selectedBucket === b.name && currentPath === '' ? 'bg-indigo-600 text-white shadow-xl' : 'text-slate-600 hover:bg-slate-50'}
                    ${dragTarget === `bucket-${b.name}` ? 'ring-2 ring-indigo-500 bg-indigo-50 !text-indigo-700' : ''}
                 `}
               >
                 <div className="flex items-center gap-4"><Folder size={20} className={selectedBucket === b.name ? 'text-white' : 'text-slate-300'} /><span className="text-sm font-bold tracking-tight">{b.name}</span></div>
                 {/* Quick Policy Link */}
                 {selectedBucket === b.name && (
                    <button onClick={(e) => { e.stopPropagation(); window.location.hash = `#/project/${projectId}/rls-editor/bucket/${b.name}`; }} className="text-white/70 hover:text-white" title="Manage Policies"><Shield size={14} /></button>
                 )}
               </div>
             ))}
           </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col bg-[#FDFDFD] relative overflow-hidden">
          {/* Breadcrumbs */}
          <div className="px-10 py-6 bg-white border-b border-slate-100 flex items-center justify-between sticky top-0 z-20">
             <div className="flex items-center gap-3 text-slate-400 text-sm font-black">
                <HardDrive size={16} />
                <span className="hover:text-indigo-600 cursor-pointer" onClick={() => setCurrentPath('')}>{selectedBucket || 'Root'}</span>
                {currentPath.split('/').filter(Boolean).map((part, i, arr) => {
                    const partialPath = arr.slice(0, i + 1).join('/');
                    return (
                        <React.Fragment key={i}>
                            <ChevronRight size={14} />
                            <span className="hover:text-indigo-600 cursor-pointer" onClick={() => setCurrentPath(partialPath)}>{part}</span>
                        </React.Fragment>
                    );
                })}
                {searchQuery && <span className="text-indigo-600 ml-2">/ Searching: "{searchQuery}"</span>}
             </div>
             <div className="flex items-center bg-slate-50 p-1 rounded-xl border border-slate-100">
               <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="bg-transparent border-none text-[10px] font-black uppercase tracking-widest px-4 py-2 outline-none text-slate-500 cursor-pointer">
                 <option value="all">All Sectors</option>
                 {SECTOR_DEFINITIONS.filter(s => s.id !== 'global').map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
               </select>
             </div>
          </div>

          <div className="flex-1 overflow-y-auto p-10">
            {loading ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-300 gap-6"><Loader2 size={64} className="animate-spin text-indigo-600" /><p className="text-xs font-black uppercase tracking-widest">Loading...</p></div>
            ) : sortedItems.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-200 gap-6"><div className="w-32 h-32 rounded-[3rem] bg-slate-50 flex items-center justify-center"><Folder size={64} className="opacity-10" /></div><p className="text-sm font-black uppercase tracking-widest text-slate-400">{searchQuery ? 'No matches' : 'Empty Directory'}</p></div>
            ) : (
              <div className="bg-white border border-slate-200 rounded-[3rem] shadow-sm overflow-hidden min-h-full">
                <table className="w-full text-left border-collapse">
                  <thead><tr className="bg-slate-50 border-b border-slate-100"><th className="w-16 px-8 py-6"></th><th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Name</th><th className="px-8 py-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Modified</th><th className="px-8 py-6 w-20"></th></tr></thead>
                  <tbody className="divide-y divide-slate-50">
                    {/* "Up" Navigation if not root */}
                    {currentPath && (
                        <tr className="hover:bg-slate-50 cursor-pointer group" onClick={() => setCurrentPath(currentPath.split('/').slice(0, -1).join('/'))}>
                            <td className="px-8 py-4 text-center"><CornerUpRight size={16} className="text-slate-300 mx-auto"/></td>
                            <td className="px-8 py-4 text-xs font-bold text-slate-500">.. (Up One Level)</td>
                            <td></td><td></td>
                        </tr>
                    )}
                    {sortedItems.map((item) => (
                      <tr 
                        key={item.path} 
                        draggable
                        onDragStart={(e) => handleDragStartItem(e, item)}
                        // Specific handlers for Folder Rows (Drop Target)
                        onDragOver={(e) => item.type === 'folder' ? handleDragEnter(e, `folder-${item.path}`) : undefined}
                        onDragLeave={(e) => item.type === 'folder' ? handleDragLeave(e, `folder-${item.path}`) : undefined}
                        onDrop={(e) => item.type === 'folder' ? handleDropOnTarget(e, selectedBucket!, item.path) : undefined}
                        
                        onClick={(e) => handleItemClick(e, item)}
                        onDoubleClick={() => handleItemDoubleClick(item)}
                        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, type: 'item', data: item }); }}
                        className={`group transition-colors cursor-pointer select-none ${selectedItems.has(item.path) ? 'bg-indigo-50' : 'hover:bg-indigo-50/30'} ${dragTarget === `folder-${item.path}` ? '!bg-indigo-100 ring-2 ring-inset ring-indigo-500' : ''}`}
                      >
                        <td className="px-8 py-5 text-center">
                            <div 
                                onClick={(e) => { e.stopPropagation(); toggleSelect(item.path); }} 
                                className={`w-4 h-4 border-2 rounded transition-all mx-auto cursor-pointer ${selectedItems.has(item.path) ? 'bg-indigo-600 border-indigo-600' : 'border-slate-200 group-hover:border-indigo-300'}`}
                            >
                                {selectedItems.has(item.path) && <Check size={12} className="text-white" />}
                            </div>
                        </td>
                        <td className="px-8 py-5">
                            <div className="flex items-center gap-4">
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${item.type === 'folder' ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-500'}`}>
                                    {item.type === 'folder' ? <Folder size={20} /> : <FileText size={20} />}
                                </div>
                                <span className="text-sm font-bold text-slate-700">{item.name}</span>
                            </div>
                        </td>
                        <td className="px-8 py-5 text-right font-mono text-xs font-bold text-slate-400">{new Date(item.updated_at).toLocaleDateString()}</td>
                        <td className="px-8 py-5 text-right relative">
                           <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              {item.type === 'file' && (
                                <button onClick={(e) => { e.stopPropagation(); window.open(getSecureDownloadLink(item.path), '_blank'); }} title="Preview" className="p-3 text-slate-400 hover:text-indigo-600 hover:bg-white rounded-xl shadow-sm"><Eye size={18} /></button>
                              )}
                              <button onClick={(e) => { e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, type: 'item', data: item }); }} className="p-3 text-slate-400 hover:text-indigo-600 hover:bg-white rounded-xl shadow-sm"><MoreHorizontal size={18} /></button>
                           </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* SETTINGS MODAL (GOVERNANCE) */}
      {showSettings && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-xl z-[400] flex items-center justify-center p-8 animate-in fade-in duration-300">
          <div className="bg-white rounded-[4rem] w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl border border-slate-100 animate-in zoom-in-95">
            <header className="p-12 pb-6 border-b border-slate-100 bg-slate-50/50">
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-6">
                  <div className="w-16 h-16 bg-slate-900 text-white rounded-[1.8rem] flex items-center justify-center shadow-xl"><Shield size={32} /></div>
                  <div><h3 className="text-4xl font-black text-slate-900 tracking-tighter">Governance Engine</h3><p className="text-[10px] text-indigo-600 font-bold uppercase tracking-widest">Advanced Ingestion Policy</p></div>
                </div>
                <button onClick={() => setShowSettings(false)} className="p-4 hover:bg-slate-200 rounded-full transition-all text-slate-400"><X size={32} /></button>
              </div>
              
              {/* GLOBAL SEARCH */}
              <div className="relative mb-2">
                 <Search size={18} className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400" />
                 <input 
                   value={governanceSearch}
                   onChange={(e) => setGovernanceSearch(e.target.value)}
                   placeholder="Search format globally (e.g. .png, json)..." 
                   className="w-full pl-14 pr-6 py-5 bg-white border border-slate-200 rounded-3xl text-sm font-bold outline-none focus:ring-4 focus:ring-indigo-500/10 shadow-sm"
                 />
              </div>
            </header>
            
            <div className="flex-1 overflow-y-auto p-12 space-y-4">
              {SECTOR_DEFINITIONS.map(sector => {
                // Filter logic
                const searchClean = governanceSearch.toLowerCase().replace(/^\./, '');
                const hasMatch = sector.exts.some(ext => ext.includes(searchClean));
                if (governanceSearch && !hasMatch && sector.id !== 'global') return null;

                const internalValStr = governance[sector.id]?.max_size || '10MB';
                const externalValStr = governance[sector.id]?.max_size_direct || '5GB';
                const isOverPhysical = checkPhysicalLimit(internalValStr);

                return (
                  <div key={sector.id} className="bg-slate-50 border border-slate-100 rounded-[2.5rem] overflow-hidden transition-all group">
                     <button onClick={() => { setExpandedSector(expandedSector === sector.id ? null : sector.id); }} className="w-full p-8 flex items-center justify-between text-left hover:bg-white transition-colors">
                       <div className="flex items-center gap-6">
                         <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-inner ${expandedSector === sector.id || governanceSearch ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400'}`}><Zap size={24} /></div>
                         <div><h4 className="text-xl font-black text-slate-900 tracking-tight">{sector.label}</h4><p className="text-[11px] text-slate-400 font-medium uppercase tracking-widest">{sector.desc}</p></div>
                       </div>
                       <ChevronDown size={20} className={`text-slate-300 transition-transform ${expandedSector === sector.id || governanceSearch ? 'rotate-180' : ''}`} />
                     </button>

                     {(expandedSector === sector.id || (governanceSearch && hasMatch)) && (
                       <div className="p-8 pt-0 border-t border-slate-100 bg-white/50 animate-in slide-in-from-top-2">
                          
                          {/* LIMITS SECTION (DUAL) */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8 bg-white p-6 rounded-3xl border border-slate-100">
                              {/* Internal Limit */}
                              <div>
                                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-2">
                                      <Server size={12}/> Internal Limit (Proxy)
                                      {isOverPhysical && <span className="text-rose-500 flex items-center gap-1" title="Exceeds Nginx Physical Cap"><AlertTriangle size={10}/> High Risk</span>}
                                  </label>
                                  <div className={`flex items-center gap-2 bg-slate-50 border rounded-xl p-1 ${isOverPhysical ? 'border-rose-300 bg-rose-50' : 'border-slate-200'}`}>
                                     <input 
                                      value={parseSizeValue(internalValStr)}
                                      onChange={(e) => updateSectorSize(sector.id, e.target.value, parseSizeUnit(internalValStr), false)}
                                      className="w-full text-center text-xs font-black text-indigo-600 outline-none bg-transparent py-2"
                                     />
                                     <select 
                                      value={parseSizeUnit(internalValStr)}
                                      onChange={(e) => updateSectorSize(sector.id, parseSizeValue(internalValStr), e.target.value, false)}
                                      className="bg-white rounded-lg text-[9px] font-bold text-slate-500 outline-none px-2 py-1 shadow-sm border border-slate-100 h-8"
                                     >
                                       <option value="B">Bytes</option><option value="KB">KB</option><option value="MB">MB</option><option value="GB">GB</option>
                                     </select>
                                  </div>
                                  <p className="text-[9px] text-slate-400 mt-2 leading-relaxed">Limit for files passing through the server RAM/Disk. Max safe: 100MB.</p>
                              </div>

                              {/* External Limit */}
                              <div>
                                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-2"><Cloud size={12}/> External Limit (Direct)</label>
                                  <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl p-1">
                                     <input 
                                      value={parseSizeValue(externalValStr)}
                                      onChange={(e) => updateSectorSize(sector.id, e.target.value, parseSizeUnit(externalValStr), true)}
                                      className="w-full text-center text-xs font-black text-emerald-600 outline-none bg-transparent py-2"
                                     />
                                     <select 
                                      value={parseSizeUnit(externalValStr)}
                                      onChange={(e) => updateSectorSize(sector.id, parseSizeValue(externalValStr), e.target.value, true)}
                                      className="bg-white rounded-lg text-[9px] font-bold text-slate-500 outline-none px-2 py-1 shadow-sm border border-slate-100 h-8"
                                     >
                                       <option value="B">Bytes</option><option value="KB">KB</option><option value="MB">MB</option><option value="GB">GB</option><option value="TB">TB</option>
                                     </select>
                                  </div>
                                  <p className="text-[9px] text-slate-400 mt-2 leading-relaxed">Limit for presigned uploads directly to S3/Cloud. Virtually unlimited.</p>
                              </div>
                          </div>

                          {sector.id !== 'global' && (
                              <>
                                <div className="flex items-center justify-between mb-6">
                                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Whitelisted Terminations</span>
                                    <div className="flex gap-4">
                                        <button onClick={() => setGovernance({ ...governance, [sector.id]: { ...governance[sector.id], allowed_exts: sector.exts } })} className="text-[10px] font-black text-indigo-600 uppercase hover:underline">Select All</button>
                                        <button onClick={() => setGovernance({ ...governance, [sector.id]: { ...governance[sector.id], allowed_exts: [] } })} className="text-[10px] font-black text-rose-600 uppercase hover:underline">Clear All</button>
                                    </div>
                                </div>
                                
                                {/* Custom Extension Adder */}
                                <div className="mb-4 flex items-center gap-3">
                                    <input 
                                    value={newCustomExt}
                                    onChange={(e) => setNewCustomExt(e.target.value)}
                                    placeholder="Add custom ext (e.g. .thales)"
                                    className="bg-white border border-slate-200 rounded-xl px-4 py-2 text-xs font-bold outline-none focus:ring-2 focus:ring-indigo-500/10"
                                    onKeyDown={(e) => e.key === 'Enter' && addCustomExtension(sector.id)}
                                    />
                                    <button onClick={() => addCustomExtension(sector.id)} className="bg-indigo-600 text-white p-2 rounded-lg hover:bg-indigo-700 transition-colors"><Plus size={14}/></button>
                                </div>

                                <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
                                    {Array.from(new Set([...sector.exts, ...(governance[sector.id]?.allowed_exts || [])]))
                                    .filter(ext => ext.includes(governanceSearch.toLowerCase().replace(/^\./, '')))
                                    .map(ext => {
                                        const isActive = governance[sector.id]?.allowed_exts?.includes(ext);
                                        return (
                                        <button 
                                            key={ext} 
                                            onClick={() => {
                                            const current = governance[sector.id]?.allowed_exts || [];
                                            const next = current.includes(ext) ? current.filter((e:string) => e !== ext) : [...current, ext];
                                            setGovernance({ ...governance, [sector.id]: { ...governance[sector.id], allowed_exts: next } });
                                            }}
                                            className={`flex items-center justify-center gap-2 py-3 rounded-xl border transition-all ${isActive ? 'bg-indigo-600 text-white border-indigo-700 shadow-lg' : 'bg-white text-slate-400 border-slate-200 hover:border-slate-300'}`}
                                        >
                                            {isActive ? <CheckSquare size={12} /> : <Square size={12} />}
                                            <span className="text-[10px] font-black uppercase tracking-tighter">.{ext}</span>
                                        </button>
                                        );
                                    })}
                                </div>
                              </>
                          )}
                       </div>
                     )}
                  </div>
                );
              })}
            </div>

            <footer className="p-10 bg-slate-50 border-t border-slate-100 flex gap-6 shrink-0">
               <button onClick={() => setShowSettings(false)} className="flex-1 py-6 text-slate-400 font-black uppercase tracking-widest text-xs hover:bg-slate-100 rounded-[2rem] transition-all">Discard</button>
               <button onClick={async () => {
                  try {
                    await fetchWithAuth(`/api/control/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ metadata: { storage_governance: governance } }) });
                    setSuccess("Políticas de governança sincronizadas."); setShowSettings(false);
                  } catch (e: any) { setError("Erro ao salvar governança."); }
               }} className="flex-[3] py-6 bg-slate-900 text-white rounded-[2rem] text-xs font-black uppercase tracking-widest shadow-2xl hover:bg-indigo-600 transition-all">Sincronizar Políticas de Segurança</button>
            </footer>
          </div>
        </div>
      )}

      {/* MOVE MODAL */}
      {showMoveModal && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
           <div className="bg-white rounded-[3rem] w-full max-w-lg p-10 shadow-2xl border border-slate-100">
              <h3 className="text-2xl font-black text-slate-900 mb-6">Mover {selectedItems.size} Itens</h3>
              <div className="space-y-4 mb-8">
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Destination Bucket</label>
                    <select 
                      value={moveDestination.bucket} 
                      onChange={(e) => setMoveDestination({...moveDestination, bucket: e.target.value})}
                      className="w-full bg-slate-50 border-none rounded-2xl py-3 px-4 text-sm font-bold text-slate-900 outline-none"
                    >
                       {buckets.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
                    </select>
                 </div>
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Relative Path (Optional)</label>
                    <input 
                      value={moveDestination.path} 
                      onChange={(e) => setMoveDestination({...moveDestination, path: e.target.value})}
                      placeholder="folder/subfolder"
                      className="w-full bg-slate-50 border-none rounded-2xl py-3 px-4 text-sm font-bold text-slate-900 outline-none"
                    />
                 </div>
              </div>
              <div className="flex gap-4">
                 <button onClick={() => setShowMoveModal(false)} className="flex-1 py-4 text-xs font-black text-slate-400 uppercase tracking-widest">Cancelar</button>
                 <button onClick={handleMove} className="flex-[2] py-4 bg-indigo-600 text-white font-black rounded-2xl text-xs uppercase tracking-widest shadow-xl">Confirmar Transferência</button>
              </div>
           </div>
        </div>
      )}

      {/* PASSWORD CONFIRM MODAL */}
      {showVerifyModal && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[800] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3rem] p-10 max-w-sm w-full shadow-2xl text-center border border-rose-100">
               <Lock size={40} className="mx-auto text-rose-600 mb-6" />
               <h3 className="text-xl font-black text-slate-900 mb-2">Ação Destrutiva</h3>
               <p className="text-xs text-slate-500 font-bold mb-8">Confirme sua senha mestra para prosseguir.</p>
               <input 
                 type="password" 
                 autoFocus
                 value={verifyPassword}
                 onChange={e => setVerifyPassword(e.target.value)}
                 className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-center font-bold text-slate-900 outline-none mb-6 focus:ring-4 focus:ring-rose-500/10"
                 placeholder="••••••••"
               />
               <button onClick={handleVerifyAndExecute} className="w-full bg-rose-600 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl hover:bg-rose-700 transition-all">
                  Liberar Acesso
               </button>
               <button onClick={() => { setShowVerifyModal(false); setPendingAction(null); }} className="mt-4 text-xs font-bold text-slate-400 hover:text-slate-600">Cancelar</button>
            </div>
         </div>
      )}

      {/* NEW BUCKET/FOLDER POPUP */}
      {(showNewBucket || showNewFolder) && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-md z-[200] flex items-center justify-center p-8 animate-in zoom-in-95">
           <div className="bg-white rounded-[3.5rem] w-full max-w-lg p-12 shadow-2xl border border-slate-100">
              <h3 className="text-3xl font-black text-slate-900 tracking-tighter mb-8">{showNewBucket ? 'New Bucket' : 'New Folder'}</h3>
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/gi, '_'))} className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-8 text-lg font-black outline-none mb-8" placeholder="entity_name" />
              <div className="flex gap-4"><button onClick={() => { setShowNewBucket(false); setShowNewFolder(false); setNewName(''); }} className="flex-1 py-5 text-xs font-black text-slate-400 uppercase tracking-widest">Abort</button><button onClick={showNewBucket ? async () => { await fetchWithAuth(`/api/data/${projectId}/storage/buckets`, { method: 'POST', body: JSON.stringify({ name: newName }) }); setNewName(''); setShowNewBucket(false); fetchBuckets(); } : handleCreateFolder} className="flex-[2] py-5 bg-indigo-600 text-white font-black rounded-2xl text-xs uppercase tracking-widest shadow-xl">Confirm</button></div>
           </div>
        </div>
      )}

      {/* CONNECT STORAGE MODAL (FIXED & EXPANDED) */}
      {showConnectModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[800] flex items-center justify-center p-8 animate-in zoom-in-95">
            <div className="bg-white rounded-[3.5rem] w-full max-w-4xl h-[700px] shadow-2xl flex overflow-hidden">
                {/* Sidebar */}
                <div className="w-72 bg-slate-50 p-6 flex flex-col gap-2 overflow-y-auto">
                    <h3 className="text-lg font-black text-slate-900 mb-4 px-2">Providers</h3>
                    {STORAGE_PROVIDERS.map(p => (
                        <button 
                            key={p.id}
                            onClick={() => setActiveConfigTab(p.id)}
                            className={`flex items-center gap-3 p-3 rounded-xl transition-all ${activeConfigTab === p.id ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-500 hover:bg-white hover:text-indigo-600'}`}
                        >
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${activeConfigTab === p.id ? 'bg-white/20' : 'bg-white'}`}>
                                <p.icon size={16}/>
                            </div>
                            <div className="text-left">
                                <span className="text-xs font-bold block">{p.name}</span>
                                <span className="text-[9px] opacity-70 block">{p.desc.substring(0, 20)}...</span>
                            </div>
                        </button>
                    ))}
                </div>
                
                {/* Main Config Area */}
                <div className="flex-1 p-10 flex flex-col">
                    <div className="flex justify-between items-start mb-8">
                        <div>
                            <h3 className="text-3xl font-black text-slate-900 tracking-tighter mb-2">Configure {STORAGE_PROVIDERS.find(p => p.id === activeConfigTab)?.name}</h3>
                            <p className="text-slate-400 text-xs font-bold uppercase tracking-widest">Storage Connection Settings</p>
                        </div>
                        <button onClick={() => setShowConnectModal(false)} className="p-3 hover:bg-slate-50 rounded-full text-slate-400"><X size={24}/></button>
                    </div>

                    <div className="flex-1 overflow-y-auto space-y-6 pr-4">
                        {activeConfigTab === 'local' && (
                            <div className="p-6 bg-slate-50 rounded-[2rem] border border-slate-100 flex items-center gap-4">
                                <Server size={32} className="text-indigo-600"/>
                                <div>
                                    <h4 className="font-bold text-slate-900">Default Local Storage</h4>
                                    <p className="text-xs text-slate-500 mt-1">Files are stored directly on the server's disk.</p>
                                </div>
                            </div>
                        )}

                        {activeConfigTab === 's3' && (
                            <div className="space-y-4">
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Endpoint (Optional for AWS)</label><input value={storageConfig.s3?.endpoint || ''} onChange={e => setStorageConfig({...storageConfig, s3: {...storageConfig.s3, endpoint: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none" placeholder="https://s3.us-east-1.amazonaws.com"/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Region</label><input value={storageConfig.s3?.region || ''} onChange={e => setStorageConfig({...storageConfig, s3: {...storageConfig.s3, region: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none" placeholder="us-east-1"/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Bucket Name</label><input value={storageConfig.s3?.bucket || ''} onChange={e => setStorageConfig({...storageConfig, s3: {...storageConfig.s3, bucket: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none" placeholder="my-bucket"/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Access Key ID</label><input value={storageConfig.s3?.accessKeyId || ''} onChange={e => setStorageConfig({...storageConfig, s3: {...storageConfig.s3, accessKeyId: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none"/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Secret Access Key</label><input type="password" value={storageConfig.s3?.secretAccessKey || ''} onChange={e => setStorageConfig({...storageConfig, s3: {...storageConfig.s3, secretAccessKey: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none"/></div>
                            </div>
                        )}

                        {activeConfigTab === 'cloudinary' && (
                             <div className="space-y-4">
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Cloud Name</label><input value={storageConfig.cloudinary?.cloudName || ''} onChange={e => setStorageConfig({...storageConfig, cloudinary: {...storageConfig.cloudinary, cloudName: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none"/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">API Key</label><input value={storageConfig.cloudinary?.apiKey || ''} onChange={e => setStorageConfig({...storageConfig, cloudinary: {...storageConfig.cloudinary, apiKey: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none"/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">API Secret</label><input type="password" value={storageConfig.cloudinary?.apiSecret || ''} onChange={e => setStorageConfig({...storageConfig, cloudinary: {...storageConfig.cloudinary, apiSecret: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none"/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Upload Preset (Unsigned)</label><input value={storageConfig.cloudinary?.uploadPreset || ''} onChange={e => setStorageConfig({...storageConfig, cloudinary: {...storageConfig.cloudinary, uploadPreset: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none"/></div>
                             </div>
                        )}

                        {activeConfigTab === 'imagekit' && (
                             <div className="space-y-4">
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Public Key</label><input value={storageConfig.imagekit?.publicKey || ''} onChange={e => setStorageConfig({...storageConfig, imagekit: {...storageConfig.imagekit, publicKey: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none"/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Private Key</label><input type="password" value={storageConfig.imagekit?.privateKey || ''} onChange={e => setStorageConfig({...storageConfig, imagekit: {...storageConfig.imagekit, privateKey: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none"/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">URL Endpoint</label><input value={storageConfig.imagekit?.urlEndpoint || ''} onChange={e => setStorageConfig({...storageConfig, imagekit: {...storageConfig.imagekit, urlEndpoint: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none" placeholder="https://ik.imagekit.io/your_id"/></div>
                             </div>
                        )}

                        {activeConfigTab === 'gdrive' && (
                             <div className="space-y-4">
                                <div className="p-4 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-800 font-medium">Use a Service Account JSON from Google Cloud Console.</div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Client Email (Service Account)</label><input value={storageConfig.gdrive?.clientEmail || ''} onChange={e => setStorageConfig({...storageConfig, gdrive: {...storageConfig.gdrive, clientEmail: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none" placeholder="service-account@..."/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Private Key</label><textarea value={storageConfig.gdrive?.privateKey || ''} onChange={e => setStorageConfig({...storageConfig, gdrive: {...storageConfig.gdrive, privateKey: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-xs font-mono border-none outline-none h-24" placeholder="-----BEGIN PRIVATE KEY..."/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Root Folder ID (Optional)</label><input value={storageConfig.gdrive?.rootFolderId || ''} onChange={e => setStorageConfig({...storageConfig, gdrive: {...storageConfig.gdrive, rootFolderId: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none"/></div>
                             </div>
                        )}

                        {['onedrive', 'dropbox'].includes(activeConfigTab) && (
                             <div className="space-y-4">
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Client ID / App Key</label><input value={storageConfig[activeConfigTab]?.clientId || ''} onChange={e => setStorageConfig({...storageConfig, [activeConfigTab]: {...storageConfig[activeConfigTab], clientId: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none"/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Client Secret / App Secret</label><input type="password" value={storageConfig[activeConfigTab]?.clientSecret || ''} onChange={e => setStorageConfig({...storageConfig, [activeConfigTab]: {...storageConfig[activeConfigTab], clientSecret: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none"/></div>
                                <div><label className="text-[10px] font-black uppercase text-slate-400">Refresh Token (Long Lived)</label><input type="password" value={storageConfig[activeConfigTab]?.refreshToken || ''} onChange={e => setStorageConfig({...storageConfig, [activeConfigTab]: {...storageConfig[activeConfigTab], refreshToken: e.target.value}})} className="w-full p-3 bg-slate-50 rounded-xl text-sm font-bold border-none outline-none"/></div>
                             </div>
                        )}

                        {/* --- NEW OPTIMIZATION TOGGLE (SOLUTION 3) --- */}
                        <div className="mt-8 pt-8 border-t border-slate-100">
                           <h4 className="text-sm font-bold text-slate-900 mb-2 flex items-center gap-2"><Wand2 size={16}/> Processing Pipeline</h4>
                           <label className={`flex items-center gap-3 p-4 border rounded-xl cursor-pointer transition-all ${storageConfig.optimize ? 'bg-indigo-50 border-indigo-200' : 'hover:bg-slate-50 border-slate-200'}`}>
                              <div className={`w-5 h-5 rounded-md border flex items-center justify-center transition-colors ${storageConfig.optimize ? 'bg-indigo-600 border-indigo-600' : 'bg-white border-slate-300'}`}>
                                  {storageConfig.optimize && <Check size={14} className="text-white"/>}
                              </div>
                              <input type="checkbox" className="hidden" checked={storageConfig.optimize || false} onChange={e => setStorageConfig({...storageConfig, optimize: e.target.checked})} />
                              <div>
                                 <span className="text-xs font-black uppercase block text-slate-700">Auto-Optimize Images</span>
                                 <span className="text-[10px] text-slate-400 font-medium">Automatically resize/compress uploads. Disable for FlutterFlow compatibility if needed.</span>
                              </div>
                           </label>
                        </div>
                    </div>

                    <div className="pt-6 mt-4 border-t border-slate-100 flex gap-4">
                        <button onClick={() => setShowConnectModal(false)} className="flex-1 py-4 text-xs font-black uppercase tracking-widest text-slate-400 hover:bg-slate-50 rounded-2xl">Cancel</button>
                        <button onClick={handleSaveStorageConfig} className="flex-[2] py-4 bg-indigo-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl hover:bg-indigo-700">Save Configuration</button>
                    </div>
                </div>
            </div>
        </div>
      )}

    </div>
  );
};

export default StorageExplorer;
