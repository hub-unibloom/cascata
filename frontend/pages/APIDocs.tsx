
import React, { useState, useEffect, useMemo } from 'react';
import { 
  BookOpen, Copy, Globe, Database, Code2, 
  ChevronRight, ChevronDown, Loader2, FileText, 
  Sparkles, Plus, Search, Check, Terminal, Download,
  FileJson, Package, Blocks, Link as LinkIcon, Zap,
  Layers, ArrowRight, ShieldCheck, Play, Key, AlertCircle, RefreshCw,
  ListFilter, MousePointer2, CheckSquare, Users, Lock, Fingerprint,
  HardDrive, Upload as UploadIcon, Trash2, Cloud
} from 'lucide-react';

interface APIDocsProps {
  projectId: string;
}

const SYSTEM_RPC_PREFIXES = ['uuid_', 'pg_', 'armor', 'crypt', 'digest', 'hmac', 'gen_', 'encrypt', 'decrypt', 'pissh_', 'notify_', 'dearmor'];

// --- STORAGE DEFINITIONS ---
const STORAGE_ENDPOINTS = [
    {
        id: 'storage_list_buckets',
        name: 'List Buckets',
        method: 'GET',
        path: '/storage/buckets',
        description: 'Retrieve all available storage buckets.',
        body: {},
        is_upload: false
    },
    {
        id: 'storage_list_files',
        name: 'List Files',
        method: 'GET',
        path: '/storage/:bucket/list',
        description: 'List files and folders in a specific bucket.',
        body: {}, // Query param path handled in generator
        is_upload: false
    },
    {
        id: 'storage_upload',
        name: 'Upload File',
        method: 'POST',
        path: '/storage/:bucket/upload',
        description: 'Upload a file using multipart/form-data.',
        body: { path: "folder/subfolder" },
        is_upload: true
    },
    {
        id: 'storage_get',
        name: 'Download / Serve',
        method: 'GET',
        path: '/storage/:bucket/object/:path',
        description: 'Retrieve a file via public URL (requires headers if RLS enabled).',
        body: {},
        is_upload: false
    },
    {
        id: 'storage_delete',
        name: 'Delete File',
        method: 'DELETE',
        path: '/storage/:bucket/object',
        description: 'Remove a file permanently.',
        body: {}, // Query param path
        is_upload: false
    }
];

// --- AUTH DEFINITIONS (Static Documentation) ---
const AUTH_ENDPOINTS = [
    {
        id: 'auth_signup',
        name: 'Sign Up (Email)',
        method: 'POST',
        path: '/auth/v1/signup',
        description: 'Register a new user with email and password.',
        body: { email: "user@example.com", password: "secure_password_123", data: { full_name: "John Doe" } },
        auth_required: false
    },
    {
        id: 'auth_login',
        name: 'Sign In (Password)',
        method: 'POST',
        path: '/auth/v1/token',
        description: 'Log in an existing user to obtain an Access Token.',
        body: { email: "user@example.com", password: "secure_password_123", grant_type: "password" },
        auth_required: false
    },
    {
        id: 'auth_magic',
        name: 'Magic Link / OTP',
        method: 'POST',
        path: '/auth/challenge',
        description: 'Initiate a passwordless flow (Email Magic Link or OTP).',
        body: { provider: "email", identifier: "user@example.com" },
        auth_required: false
    },
    {
        id: 'auth_verify',
        name: 'Verify OTP',
        method: 'POST',
        path: '/auth/verify-challenge',
        description: 'Verify the code sent via Magic Link/OTP flow.',
        body: { provider: "email", identifier: "user@example.com", code: "123456" },
        auth_required: false
    },
    {
        id: 'auth_user',
        name: 'Get User',
        method: 'GET',
        path: '/auth/v1/user',
        description: 'Retrieve details of the currently logged-in user.',
        body: {},
        auth_required: true // Needs Bearer
    },
    {
        id: 'auth_refresh',
        name: 'Refresh Token',
        method: 'POST',
        path: '/auth/v1/token',
        description: 'Refresh a session using a valid refresh_token.',
        body: { grant_type: "refresh_token", refresh_token: "your_refresh_token_here" },
        auth_required: false
    },
    {
        id: 'auth_logout',
        name: 'Sign Out',
        method: 'POST',
        path: '/auth/v1/logout',
        description: 'Revoke the current session.',
        body: {},
        auth_required: true // Needs Bearer
    }
];

// --- SMART VALUE GENERATOR ---
const generateSmartValue = (name: string, type: string) => {
    const n = name.toLowerCase();
    const t = type.toLowerCase();

    if (t.includes('bool')) return true;

    if (t.includes('int') || t.includes('serial')) {
        if (n === 'id' || n.endsWith('_id')) return 1;
        if (n.includes('limit')) return 10;
        if (n.includes('offset')) return 0;
        if (n.includes('status')) return 1;
        if (n.includes('qty') || n.includes('count') || n.includes('estoque')) return 100;
        return 0;
    }

    if (t.includes('numeric') || t.includes('float') || t.includes('double') || t.includes('decimal') || t.includes('money')) {
        if (n.includes('price') || n.includes('preco') || n.includes('cost') || n.includes('valor')) return 99.90;
        if (n.includes('tax') || n.includes('rate')) return 0.15;
        if (n.includes('weight') || n.includes('peso')) return 1.5;
        return 10.0;
    }

    if (t.includes('timestamp') || t.includes('date') || t.includes('time')) {
        return new Date().toISOString();
    }

    if (t.includes('uuid')) {
        return "550e8400-e29b-41d4-a716-446655440000";
    }

    if (t.includes('json')) return { key: "value", tags: ["a", "b"] };
    if (t.includes('array') || t.startsWith('_')) return ["option1", "option2"];

    if (n.includes('email')) return "user@example.com";
    if (n.includes('url') || n.includes('image')) return "https://example.com/image.png";
    if (n.includes('phone')) return "+1555999887766";
    if (n.includes('name') || n.includes('nome')) return "Exemplo Nome";
    
    return "text_value";
};

const APIDocs: React.FC<APIDocsProps> = ({ projectId }) => {
  const [activeTab, setActiveTab] = useState<'reference' | 'connect' | 'guides'>('reference');
  const [spec, setSpec] = useState<any>(null);
  const [guides, setGuides] = useState<any[]>([]);
  const [customFunctions, setCustomFunctions] = useState<any[]>([]);
  const [buckets, setBuckets] = useState<any[]>([]);
  const [selectedGuide, setSelectedGuide] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  
  // UX States
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [expandedParams, setExpandedParams] = useState<Set<string>>(new Set()); 
  // Sidebar Accordion State (Default all open)
  const [expandedSidebarGroups, setExpandedSidebarGroups] = useState<Set<string>>(new Set(['auth', 'tables', 'edge', 'rpc', 'storage']));
  
  // Table Operations State (Which method is active for each table: GET | POST | PATCH | DELETE)
  const [tableOperations, setTableOperations] = useState<Record<string, string>>({});

  const [searchQuery, setSearchQuery] = useState('');
  const [richMetadata, setRichMetadata] = useState<Record<string, any>>({}); 
  
  // Selection Logic States
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  const [projectData, setProjectData] = useState<any>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const [tablesList, setTablesList] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [showGenModal, setShowGenModal] = useState(false);

  useEffect(() => {
    fetchData();
  }, [projectId]);

  const fetchData = async () => {
    try {
      const token = localStorage.getItem('cascata_token');
      const headers = { 'Authorization': `Bearer ${token}` };
      
      const [specRes, guidesRes, tablesRes, functionsRes, projectRes, bucketsRes] = await Promise.all([
        fetch(`/api/data/${projectId}/docs/openapi`, { headers }),
        fetch(`/api/data/${projectId}/docs/pages`, { headers }),
        fetch(`/api/data/${projectId}/tables`, { headers }),
        fetch(`/api/data/${projectId}/functions`, { headers }),
        fetch('/api/control/projects', { headers }),
        fetch(`/api/data/${projectId}/storage/buckets`, { headers })
      ]);
      
      setSpec(await specRes.json());
      const g = await guidesRes.json();
      setGuides(g);
      if(g.length > 0 && !selectedGuide) setSelectedGuide(g[0]);
      
      const t = await tablesRes.json();
      setTablesList(t.map((r: any) => r.name));

      const f = await functionsRes.json();
      setCustomFunctions(f);

      const b = await bucketsRes.json();
      setBuckets(b);

      const projects = await projectRes.json();
      const current = projects.find((p: any) => p.slug === projectId);
      setProjectData(current);
      
    } catch (e) {
      console.error("Failed to load docs", e);
    } finally {
      setLoading(false);
    }
  };

  const fetchMetadata = async (name: string, type: 'table' | 'rpc') => {
      if (richMetadata[name]) return;

      try {
          const token = localStorage.getItem('cascata_token');
          let data = null;

          if (type === 'table') {
              const res = await fetch(`/api/data/${projectId}/tables/${name}/columns`, {
                  headers: { 'Authorization': `Bearer ${token}` }
              });
              if (res.ok) data = await res.json(); 
          } else {
              const res = await fetch(`/api/data/${projectId}/rpc/${name}/definition`, {
                  headers: { 'Authorization': `Bearer ${token}` }
              });
              if (res.ok) {
                  const json = await res.json();
                  data = json.args; 
              }
          }

          if (data) {
              setRichMetadata(prev => ({ ...prev, [name]: { type, fields: data } }));
          }
      } catch (e) {
          console.error(`Failed to fetch metadata for ${name}`, e);
      }
  };

  const toggleItem = (name: string, type: 'table' | 'rpc' | 'edge' | 'auth' | 'storage') => {
    const next = new Set(expandedItems);
    if (next.has(name)) {
        next.delete(name);
    } else {
        next.add(name);
        if (type === 'table' || type === 'rpc') fetchMetadata(name, type); 
        // Default table operation to GET if not set
        if (type === 'table' && !tableOperations[name]) {
            setTableOperations(prev => ({ ...prev, [name]: 'GET' }));
        }
    }
    setExpandedItems(next);
  };

  const toggleParams = (name: string) => {
      const next = new Set(expandedParams);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      setExpandedParams(next);
  };

  const toggleSidebarGroup = (group: string) => {
      const next = new Set(expandedSidebarGroups);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      setExpandedSidebarGroups(next);
  };

  const setTableOperation = (tableName: string, op: string) => {
      setTableOperations(prev => ({ ...prev, [tableName]: op }));
  };

  // --- SELECTION LOGIC ---
  
  const handleSidebarClick = (name: string) => {
      if (isMultiSelectMode) {
          const next = new Set(selectedItems);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          setSelectedItems(next);
      } else {
          setSelectedItems(new Set([name]));
          
          if (!expandedItems.has(name)) {
              // Try to guess type based on lists
              let type: 'table' | 'rpc' | 'edge' | 'auth' | 'storage' = 'table';
              if (apiItems.rpcs.includes(name)) type = 'rpc';
              else if (apiItems.edge.includes(name)) type = 'edge';
              else if (apiItems.auth.some(a => a.id === name)) type = 'auth';
              else if (apiItems.storage.some(s => s.id === name)) type = 'storage';
              
              toggleItem(name, type);
          }
          
          setTimeout(() => {
              document.getElementById(`ref-${name}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 100);
      }
  };

  const handleSidebarDoubleClick = (name: string) => {
      setIsMultiSelectMode(true);
      const next = new Set(selectedItems);
      next.add(name);
      setSelectedItems(next);
  };

  const clearSelection = () => {
      setSelectedItems(new Set());
      setIsMultiSelectMode(false);
  };

  const getBaseUrl = () => {
      let host = window.location.origin;
      if (projectData?.custom_domain) {
          host = `https://${projectData.custom_domain}`;
          return `${host}/rest/v1`;
      }
      return `${host}/api/data/${projectId}/rest/v1`;
  };

  const getAuthBaseUrl = () => {
      let host = window.location.origin;
      if (projectData?.custom_domain) {
          host = `https://${projectData.custom_domain}`;
          return host; // Auth paths like /auth/v1 are root relative on custom domain
      }
      return `${host}/api/data/${projectId}`;
  };
  
  const getEdgeUrl = (fnName: string) => {
      let host = window.location.origin;
      if (projectData?.custom_domain) {
          host = `https://${projectData.custom_domain}`;
          return `${host}/edge/${fnName}`;
      }
      return `${host}/api/data/${projectId}/edge/${fnName}`;
  };

  const getSwaggerUrl = () => {
      if (projectData?.custom_domain) {
          return `https://${projectData.custom_domain}/rest/v1`;
      }
      return `${window.location.origin}/api/data/${projectId}/rest/v1`;
  };

  const safeCopyToClipboard = (text: string, id: string) => {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text);
    } else {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
    }
    setCopiedUrl(id);
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  const handleDownloadOpenAPI = () => {
      const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `${projectId}-openapi.json`; a.click();
  };

  const handleGenerateDoc = async (tableName: string) => {
      setGenerating(true);
      try {
          const res = await fetch(`/api/data/${projectId}/ai/draft-doc`, {
              method: 'POST',
              headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` 
              },
              body: JSON.stringify({ tableName })
          });
          
          if (!res.ok) throw new Error('Generation failed');
          const newDoc = await res.json();
          
          setGuides(prev => [newDoc, ...prev]);
          setSelectedGuide(newDoc);
          setShowGenModal(false);
          setActiveTab('guides');
      } catch (e) {
          alert("Failed to generate documentation.");
      } finally {
          setGenerating(false);
      }
  };

  const generateCurl = (method: string, path: string, type: 'table' | 'rpc' | 'edge' | 'auth' | 'storage', endpointDef?: any) => {
      let url = '';
      let bucketName = buckets.length > 0 ? buckets[0].name : 'my-bucket';
      let safePath = path.replace(':bucket', bucketName).replace(':path', 'file.png');

      if (type === 'auth') {
          url = `${getAuthBaseUrl()}${endpointDef.path}`;
      } else if (type === 'edge') {
          const fnName = path.replace('/edge/', '');
          url = getEdgeUrl(fnName);
      } else if (type === 'storage') {
           // Base URL for storage
           let baseUrl = getBaseUrl().replace('/rest/v1', ''); // Strip rest base
           url = `${baseUrl}${safePath}`;
      } else {
          // Handle PostgREST URLs
          let baseUrl = getBaseUrl();
          if (baseUrl.endsWith('/') && path.startsWith('/')) baseUrl = baseUrl.slice(0, -1);
          
          let entityName = '';
          if (type === 'table') {
              const match = path.match(/^\/tables\/(.+)\/data$/);
              entityName = match ? match[1] : path;
          } else {
              entityName = path.replace(/^\/rpc\//, '');
          }

          if (entityName && type === 'table') {
              url = `${baseUrl}/${entityName}`;
          } else if (entityName && type === 'rpc') {
              url = `${baseUrl}/rpc/${entityName}`;
          } else {
              url = `${baseUrl}${path}`;
          }
      }

      const anonKey = projectData?.anon_key || '<YOUR_ANON_KEY>';
      
      let cmd = `curl -X ${method} "${url}" \\\n`;
      
      // Headers
      cmd += `  -H "apikey: ${anonKey}"`;
      
      if (type === 'auth') {
          if (endpointDef.auth_required) {
              cmd += ` \\\n  -H "Authorization: Bearer <USER_ACCESS_TOKEN>"`;
          }
      } else {
           cmd += ` \\\n  -H "Authorization: Bearer ${anonKey}"`;
      }

      // Special Handling for File Upload
      if (type === 'storage' && endpointDef?.is_upload) {
          cmd += ` \\\n  -F "file=@./image.png"`;
          // Form fields if needed
          if (endpointDef.body && Object.keys(endpointDef.body).length > 0) {
              for (const [key, val] of Object.entries(endpointDef.body)) {
                   cmd += ` \\\n  -F "${key}=${val}"`;
              }
          }
          return cmd; // Return early for upload
      }

      // Content-Type & Body
      if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
          cmd += ` \\\n  -H "Content-Type: application/json"`;
          
          let bodyPayload = '{}';

          if (type === 'auth' || type === 'storage') {
              if (endpointDef?.body && Object.keys(endpointDef.body).length > 0) {
                 bodyPayload = JSON.stringify(endpointDef.body, null, 2);
              }
          } else if (type === 'edge') {
              bodyPayload = JSON.stringify({ foo: "bar" }, null, 2);
          } else {
              let entityName = type === 'table' ? path.replace('/tables/','').replace('/data','') : path.replace('/rpc/','');
              const metadata = richMetadata[entityName];
              let body: any = {};

              if (metadata && metadata.fields) {
                  metadata.fields.forEach((field: any) => {
                      if (type === 'rpc' && (field.mode === 'OUT' || field.mode === 'TABLE')) return;
                      if (type === 'table' && field.defaultValue !== null && field.defaultValue !== undefined) return;
                      if (type === 'table' && field.isPrimaryKey && field.type.includes('int')) return;
                      body[field.name] = generateSmartValue(field.name, field.type);
                  });
              }
              
              if (Object.keys(body).length > 0) {
                  bodyPayload = JSON.stringify(body, null, 2);
              }
          }
          
          if (bodyPayload !== '{}') {
             cmd += ` \\\n  -d '${bodyPayload}'`;
          }
      }
      
      if (method === 'GET' && type === 'table') {
          cmd = cmd.replace(url, `${url}?select=*&limit=10`);
      }
      
      if (method === 'DELETE' && type === 'table') {
          cmd = cmd.replace(url, `${url}?id=eq.1`);
      }

      if (method === 'GET' && type === 'storage' && endpointDef?.id === 'storage_list_files') {
          cmd = cmd.replace(url, `${url}?path=folder1`);
      }
      if (method === 'DELETE' && type === 'storage') {
          cmd = cmd.replace(url, `${url}?path=folder1/image.png`);
      }

      return cmd;
  };

  const apiItems = useMemo(() => {
      const tables: string[] = [];
      const edgeFunctions: string[] = [];

      if (spec && spec.paths) {
          Object.keys(spec.paths).forEach(path => {
              // Tables
              const tableMatch = path.match(/^\/tables\/(.+)\/data$/);
              if (tableMatch && tableMatch[1].toLowerCase().includes(searchQuery.toLowerCase())) {
                  tables.push(tableMatch[1]);
              }
              // Edge Functions
              if (path.startsWith('/edge/')) {
                  const fnName = path.replace('/edge/', '');
                  if (fnName.toLowerCase().includes(searchQuery.toLowerCase())) {
                      edgeFunctions.push(fnName);
                  }
              }
          });
      }

      const rpcs = new Set<string>();
      customFunctions.forEach(fn => {
          if (!SYSTEM_RPC_PREFIXES.some(prefix => fn.name.startsWith(prefix))) {
              if (fn.name.toLowerCase().includes(searchQuery.toLowerCase())) {
                  rpcs.add(fn.name);
              }
          }
      });
      
      const auth = AUTH_ENDPOINTS.filter(e => e.name.toLowerCase().includes(searchQuery.toLowerCase()));
      const storage = STORAGE_ENDPOINTS.filter(e => e.name.toLowerCase().includes(searchQuery.toLowerCase()));

      return { tables, rpcs: Array.from(rpcs), edge: edgeFunctions, auth, storage };
  }, [spec, customFunctions, searchQuery]);

  // VISIBLE ITEMS CALCULATION (FILTER LOGIC)
  const visibleItems = useMemo(() => {
      if (selectedItems.size >= 1 && isMultiSelectMode) {
          return {
              tables: apiItems.tables.filter(t => selectedItems.has(t)),
              rpcs: apiItems.rpcs.filter(r => selectedItems.has(r)),
              edge: apiItems.edge.filter(e => selectedItems.has(e)),
              auth: apiItems.auth.filter(a => selectedItems.has(a.id)),
              storage: apiItems.storage.filter(s => selectedItems.has(s.id))
          };
      }
      if (selectedItems.size === 1 && !isMultiSelectMode) {
          const selected = Array.from(selectedItems)[0];
          return {
               tables: apiItems.tables.filter(t => t === selected),
               rpcs: apiItems.rpcs.filter(r => r === selected),
               edge: apiItems.edge.filter(e => e === selected),
               auth: apiItems.auth.filter(a => a.id === selected),
               storage: apiItems.storage.filter(s => s.id === selected)
          };
      }
      return apiItems;
  }, [apiItems, selectedItems, isMultiSelectMode]);

  const supabaseConfigCode = `
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = '${getSwaggerUrl().replace('/rest/v1', '')}'
const supabaseKey = '${projectData?.anon_key || 'YOUR_ANON_KEY'}'

export const supabase = createClient(supabaseUrl, supabaseKey)
  `;

  if (loading) return <div className="p-20 flex justify-center"><Loader2 className="animate-spin text-indigo-600" /></div>;

  return (
    <div className="p-10 max-w-7xl mx-auto w-full space-y-10 pb-40">
      <header className="flex flex-col gap-8">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-emerald-600 text-white rounded-[1.5rem] flex items-center justify-center shadow-xl">
                <BookOpen size={28} />
            </div>
            <div>
                <h1 className="text-4xl font-black text-slate-900 tracking-tighter">Documentation</h1>
                <p className="text-slate-500 font-medium">Auto-generated API Reference & Integration Guides</p>
            </div>
            </div>
            
            <div className="flex flex-wrap gap-4">
                <button onClick={handleDownloadOpenAPI} className="px-4 py-2.5 bg-slate-900 text-white rounded-xl text-xs font-black uppercase tracking-widest flex items-center gap-2 hover:bg-indigo-600 transition-all shadow-lg">
                    <FileJson size={16}/> OpenAPI (JSON)
                </button>
                
                <div className="flex bg-slate-100 p-1.5 rounded-2xl">
                    <button onClick={() => setActiveTab('reference')} className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'reference' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}>API Reference</button>
                    <button onClick={() => setActiveTab('connect')} className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'connect' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}>Connect & SDKs</button>
                    <button onClick={() => setActiveTab('guides')} className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'guides' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}>Guides</button>
                </div>
            </div>
        </div>
      </header>

      {/* REFERENCE TAB */}
      {activeTab === 'reference' && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-10 min-h-[600px]">
            {/* Sidebar Navigation */}
            <aside className="space-y-6 lg:sticky lg:top-8 self-start">
                <div className="relative mb-6">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={16}/>
                    <input 
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search entities..." 
                        className="w-full pl-10 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-indigo-500/20" 
                    />
                </div>

                {(selectedItems.size > 0) && (
                    <div className="bg-indigo-50 border border-indigo-100 p-3 rounded-xl flex justify-between items-center animate-in slide-in-from-left-2 mb-6">
                        <span className="text-[10px] font-black text-indigo-700 uppercase tracking-widest">{selectedItems.size} Selected</span>
                        <button onClick={clearSelection} className="text-[10px] font-bold text-slate-400 hover:text-rose-600">Clear</button>
                    </div>
                )}
                
                <div className="space-y-2">
                    {/* AUTH SERVICES */}
                    <div className="border border-slate-100 rounded-xl overflow-hidden bg-white">
                        <button 
                            onClick={() => toggleSidebarGroup('auth')} 
                            className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors"
                        >
                            <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Authentication</h4>
                            {expandedSidebarGroups.has('auth') ? <ChevronDown size={14} className="text-slate-400"/> : <ChevronRight size={14} className="text-slate-400"/>}
                        </button>
                        {expandedSidebarGroups.has('auth') && (
                            <div className="space-y-1 p-2 max-h-[350px] overflow-y-auto custom-scrollbar">
                                {apiItems.auth.map(endpoint => (
                                    <button 
                                        key={endpoint.id} 
                                        onClick={() => handleSidebarClick(endpoint.id)}
                                        onDoubleClick={() => handleSidebarDoubleClick(endpoint.id)}
                                        className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 
                                            ${selectedItems.has(endpoint.id) ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:bg-slate-50'}`}
                                    >
                                        <div className="flex-1 flex items-center gap-2 truncate">
                                            <Fingerprint size={12} className={selectedItems.has(endpoint.id) ? 'opacity-100' : 'opacity-50'}/> 
                                            {endpoint.name}
                                        </div>
                                        {selectedItems.has(endpoint.id) && <Check size={12}/>}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* STORAGE ENGINE */}
                    <div className="border border-slate-100 rounded-xl overflow-hidden bg-white">
                        <button 
                            onClick={() => toggleSidebarGroup('storage')} 
                            className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors"
                        >
                            <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Storage Engine</h4>
                            {expandedSidebarGroups.has('storage') ? <ChevronDown size={14} className="text-slate-400"/> : <ChevronRight size={14} className="text-slate-400"/>}
                        </button>
                        {expandedSidebarGroups.has('storage') && (
                            <div className="space-y-1 p-2 max-h-[350px] overflow-y-auto custom-scrollbar">
                                {apiItems.storage.map(endpoint => (
                                    <button 
                                        key={endpoint.id} 
                                        onClick={() => handleSidebarClick(endpoint.id)}
                                        onDoubleClick={() => handleSidebarDoubleClick(endpoint.id)}
                                        className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 
                                            ${selectedItems.has(endpoint.id) ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:bg-slate-50'}`}
                                    >
                                        <div className="flex-1 flex items-center gap-2 truncate">
                                            <HardDrive size={12} className={selectedItems.has(endpoint.id) ? 'opacity-100' : 'opacity-50'}/> 
                                            {endpoint.name}
                                        </div>
                                        {selectedItems.has(endpoint.id) && <Check size={12}/>}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* TABLES */}
                    <div className="border border-slate-100 rounded-xl overflow-hidden bg-white">
                        <button 
                            onClick={() => toggleSidebarGroup('tables')} 
                            className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors"
                        >
                            <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Tables & Views</h4>
                            {expandedSidebarGroups.has('tables') ? <ChevronDown size={14} className="text-slate-400"/> : <ChevronRight size={14} className="text-slate-400"/>}
                        </button>
                        {expandedSidebarGroups.has('tables') && (
                            <div className="space-y-1 p-2 max-h-[350px] overflow-y-auto custom-scrollbar">
                                {apiItems.tables.map(name => (
                                    <button 
                                        key={name} 
                                        onClick={() => handleSidebarClick(name)}
                                        onDoubleClick={() => handleSidebarDoubleClick(name)}
                                        className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 
                                            ${selectedItems.has(name) ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:bg-slate-50'}`}
                                    >
                                        <div className="flex-1 flex items-center gap-2 truncate">
                                            <Database size={12} className={selectedItems.has(name) ? 'opacity-100' : 'opacity-50'}/> 
                                            {name}
                                        </div>
                                        {selectedItems.has(name) && <Check size={12}/>}
                                    </button>
                                ))}
                                {apiItems.tables.length === 0 && <p className="text-[10px] text-slate-300 px-3 italic py-2">No tables found</p>}
                            </div>
                        )}
                    </div>
                    
                    {/* EDGE FUNCTIONS */}
                    <div className="border border-slate-100 rounded-xl overflow-hidden bg-white">
                        <button 
                            onClick={() => toggleSidebarGroup('edge')} 
                            className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors"
                        >
                            <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Edge Functions</h4>
                            {expandedSidebarGroups.has('edge') ? <ChevronDown size={14} className="text-slate-400"/> : <ChevronRight size={14} className="text-slate-400"/>}
                        </button>
                        {expandedSidebarGroups.has('edge') && (
                            <div className="space-y-1 p-2 max-h-[350px] overflow-y-auto custom-scrollbar">
                                {apiItems.edge.map(name => (
                                    <button 
                                        key={name} 
                                        onClick={() => handleSidebarClick(name)}
                                        onDoubleClick={() => handleSidebarDoubleClick(name)}
                                        className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 
                                            ${selectedItems.has(name) ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-600 hover:bg-slate-50'}`}
                                    >
                                        <div className="flex-1 flex items-center gap-2 truncate">
                                            <Globe size={12} className={selectedItems.has(name) ? 'opacity-100' : 'opacity-50'}/> 
                                            {name}
                                        </div>
                                        {selectedItems.has(name) && <Check size={12}/>}
                                    </button>
                                ))}
                                {apiItems.edge.length === 0 && <p className="text-[10px] text-slate-300 px-3 italic py-2">No functions found</p>}
                            </div>
                        )}
                    </div>

                    {/* RPCs */}
                    <div className="border border-slate-100 rounded-xl overflow-hidden bg-white">
                        <button 
                            onClick={() => toggleSidebarGroup('rpc')} 
                            className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors"
                        >
                            <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Stored Procedures</h4>
                            {expandedSidebarGroups.has('rpc') ? <ChevronDown size={14} className="text-slate-400"/> : <ChevronRight size={14} className="text-slate-400"/>}
                        </button>
                        {expandedSidebarGroups.has('rpc') && (
                            <div className="space-y-1 p-2 max-h-[350px] overflow-y-auto custom-scrollbar">
                                {apiItems.rpcs.map(name => (
                                    <button 
                                        key={name} 
                                        onClick={() => handleSidebarClick(name)}
                                        onDoubleClick={() => handleSidebarDoubleClick(name)}
                                        className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 
                                            ${selectedItems.has(name) ? 'bg-amber-500 text-white shadow-md' : 'text-slate-600 hover:bg-slate-50'}`}
                                    >
                                        <div className="flex-1 flex items-center gap-2 truncate">
                                            <Zap size={12} className={selectedItems.has(name) ? 'opacity-100' : 'opacity-50'}/> 
                                            {name}
                                        </div>
                                        {selectedItems.has(name) && <Check size={12}/>}
                                    </button>
                                ))}
                                {apiItems.rpcs.length === 0 && <p className="text-[10px] text-slate-300 px-3 italic py-2">No RPCs found</p>}
                            </div>
                        )}
                    </div>
                </div>
            </aside>

            {/* Main Content */}
            <div className="lg:col-span-3 space-y-12">
                
                {/* Auth Section */}
                {visibleItems.auth.length > 0 && (
                    <div className="space-y-8">
                       {visibleItems.auth.map(endpoint => {
                           const isExpanded = expandedItems.has(endpoint.id);
                           return (
                              <div key={endpoint.id} id={`ref-${endpoint.id}`} className={`bg-white border transition-all rounded-[2rem] overflow-hidden ${isExpanded ? 'border-indigo-200 shadow-xl' : 'border-slate-200 hover:border-indigo-200'}`}>
                                  <div 
                                      onClick={() => toggleItem(endpoint.id, 'auth')}
                                      className="p-6 flex items-center justify-between cursor-pointer bg-white hover:bg-slate-50/50 transition-colors"
                                  >
                                      <div className="flex items-center gap-4">
                                          <div className="w-10 h-10 bg-slate-900 text-white rounded-xl flex items-center justify-center">
                                              <Users size={20}/>
                                          </div>
                                          <div>
                                              <h3 className="text-lg font-black text-slate-900 tracking-tight">{endpoint.name}</h3>
                                              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{endpoint.description}</p>
                                          </div>
                                      </div>
                                      <div className="flex items-center gap-3">
                                          <span className={`px-2 py-1 rounded-md text-[9px] font-black uppercase ${endpoint.method === 'GET' ? 'bg-blue-50 text-blue-600' : 'bg-emerald-50 text-emerald-600'}`}>{endpoint.method}</span>
                                          {isExpanded ? <ChevronDown size={20} className="text-slate-300"/> : <ChevronRight size={20} className="text-slate-300"/>}
                                      </div>
                                  </div>
                                  {isExpanded && (
                                      <div className="border-t border-slate-100 p-6 bg-slate-50/50">
                                          <CodeBlock 
                                              label="Execute Request" 
                                              code={generateCurl(endpoint.method, endpoint.path, 'auth', endpoint)} 
                                              onCopy={() => safeCopyToClipboard(generateCurl(endpoint.method, endpoint.path, 'auth', endpoint), endpoint.id)}
                                              copied={copiedUrl === endpoint.id}
                                          />
                                          {endpoint.auth_required && (
                                              <div className="mt-4 flex items-center gap-2 text-xs font-bold text-amber-600 bg-amber-50 p-2 rounded-lg inline-block">
                                                  <Lock size={12}/> Requires User Access Token
                                              </div>
                                          )}
                                      </div>
                                  )}
                              </div>
                           );
                       })}
                    </div>
                )}

                {/* Storage Section */}
                {visibleItems.storage.length > 0 && (
                    <div className="space-y-8">
                       {visibleItems.storage.map(endpoint => {
                           const isExpanded = expandedItems.has(endpoint.id);
                           return (
                              <div key={endpoint.id} id={`ref-${endpoint.id}`} className={`bg-white border transition-all rounded-[2rem] overflow-hidden ${isExpanded ? 'border-indigo-200 shadow-xl' : 'border-slate-200 hover:border-indigo-200'}`}>
                                  <div 
                                      onClick={() => toggleItem(endpoint.id, 'storage')}
                                      className="p-6 flex items-center justify-between cursor-pointer bg-white hover:bg-slate-50/50 transition-colors"
                                  >
                                      <div className="flex items-center gap-4">
                                          <div className="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center">
                                              <Cloud size={20}/>
                                          </div>
                                          <div>
                                              <h3 className="text-lg font-black text-slate-900 tracking-tight">{endpoint.name}</h3>
                                              <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{endpoint.description}</p>
                                          </div>
                                      </div>
                                      <div className="flex items-center gap-3">
                                          <span className={`px-2 py-1 rounded-md text-[9px] font-black uppercase ${endpoint.method === 'GET' ? 'bg-blue-50 text-blue-600' : endpoint.method === 'POST' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>{endpoint.method}</span>
                                          {isExpanded ? <ChevronDown size={20} className="text-slate-300"/> : <ChevronRight size={20} className="text-slate-300"/>}
                                      </div>
                                  </div>
                                  {isExpanded && (
                                      <div className="border-t border-slate-100 p-6 bg-slate-50/50">
                                          <CodeBlock 
                                              label="Execute Request" 
                                              code={generateCurl(endpoint.method, endpoint.path, 'storage', endpoint)} 
                                              onCopy={() => safeCopyToClipboard(generateCurl(endpoint.method, endpoint.path, 'storage', endpoint), endpoint.id)}
                                              copied={copiedUrl === endpoint.id}
                                          />
                                          {endpoint.is_upload && (
                                              <p className="text-[10px] text-slate-400 mt-2 px-1 flex items-center gap-1"><UploadIcon size={10}/> Use Multipart/Form-Data for file uploads.</p>
                                          )}
                                      </div>
                                  )}
                              </div>
                           );
                       })}
                    </div>
                )}

                {/* Tables Section */}
                {visibleItems.tables.length > 0 && (
                    <div className="space-y-8">
                        {visibleItems.tables.map(name => {
                            const path = `/tables/${name}/data`;
                            const isExpanded = expandedItems.has(name);
                            const isParamsExpanded = expandedParams.has(name);
                            const activeOp = tableOperations[name] || 'GET';
                            
                            return (
                                <div key={name} id={`ref-${name}`} className={`bg-white border transition-all rounded-[2rem] overflow-hidden ${isExpanded ? 'border-indigo-200 shadow-xl' : 'border-slate-200 hover:border-indigo-200'}`}>
                                    <div 
                                        onClick={() => toggleItem(name, 'table')}
                                        className="p-6 flex items-center justify-between cursor-pointer bg-white hover:bg-slate-50/50 transition-colors"
                                    >
                                        <div className="flex items-center gap-4">
                                            <div className="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center">
                                                <Database size={20}/>
                                            </div>
                                            <div>
                                                <h3 className="text-lg font-black text-slate-900 tracking-tight">{name}</h3>
                                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">REST Resource</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            {/* Interactive Operation Badges */}
                                            <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                                                <button 
                                                    onClick={() => setTableOperation(name, 'GET')}
                                                    className={`px-2 py-1 rounded-md text-[9px] font-black uppercase transition-all ${activeOp === 'GET' ? 'bg-blue-600 text-white shadow-md' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}
                                                >
                                                    GET
                                                </button>
                                                <button 
                                                    onClick={() => setTableOperation(name, 'POST')}
                                                    className={`px-2 py-1 rounded-md text-[9px] font-black uppercase transition-all ${activeOp === 'POST' ? 'bg-emerald-600 text-white shadow-md' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}
                                                >
                                                    POST
                                                </button>
                                                <button 
                                                    onClick={() => setTableOperation(name, 'PATCH')}
                                                    className={`px-2 py-1 rounded-md text-[9px] font-black uppercase transition-all ${activeOp === 'PATCH' ? 'bg-orange-600 text-white shadow-md' : 'bg-orange-50 text-orange-600 hover:bg-orange-100'}`}
                                                >
                                                    PATCH
                                                </button>
                                                <button 
                                                    onClick={() => setTableOperation(name, 'DELETE')}
                                                    className={`px-2 py-1 rounded-md text-[9px] font-black uppercase transition-all ${activeOp === 'DELETE' ? 'bg-rose-600 text-white shadow-md' : 'bg-rose-50 text-rose-600 hover:bg-rose-100'}`}
                                                >
                                                    DEL
                                                </button>
                                            </div>
                                            {isExpanded ? <ChevronDown size={20} className="text-slate-300"/> : <ChevronRight size={20} className="text-slate-300"/>}
                                        </div>
                                    </div>

                                    {isExpanded && (
                                        <div className="border-t border-slate-100">
                                            <CrudExample 
                                                name={name} 
                                                path={path} 
                                                generateCurl={generateCurl} 
                                                safeCopyToClipboard={safeCopyToClipboard} 
                                                copiedUrl={copiedUrl} 
                                                richData={richMetadata[name]} 
                                                isParamsExpanded={isParamsExpanded}
                                                onToggleParams={() => toggleParams(name)}
                                                activeOp={activeOp}
                                            />
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
                
                {/* Edge Functions Section */}
                {visibleItems.edge.length > 0 && (
                    <div className="space-y-8">
                        {visibleItems.edge.map(name => {
                            const isExpanded = expandedItems.has(name);
                            const path = `/edge/${name}`;
                            
                            return (
                                <div key={name} id={`ref-${name}`} className={`bg-white border transition-all rounded-[2rem] overflow-hidden ${isExpanded ? 'border-emerald-200 shadow-xl' : 'border-slate-200 hover:border-emerald-200'}`}>
                                    <div 
                                        onClick={() => toggleItem(name, 'edge')}
                                        className="p-6 flex items-center justify-between cursor-pointer bg-white hover:bg-slate-50/50 transition-colors"
                                    >
                                        <div className="flex items-center gap-4">
                                            <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-xl flex items-center justify-center">
                                                <Globe size={20}/>
                                            </div>
                                            <div>
                                                <h3 className="text-lg font-black text-slate-900 tracking-tight">{name}</h3>
                                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Serverless Function</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className="px-2 py-1 rounded-md bg-emerald-50 text-emerald-600 text-[9px] font-black uppercase">POST</span>
                                            {isExpanded ? <ChevronDown size={20} className="text-slate-300"/> : <ChevronRight size={20} className="text-slate-300"/>}
                                        </div>
                                    </div>

                                    {isExpanded && (
                                        <div className="border-t border-slate-100 p-6 bg-slate-50/50">
                                            <CodeBlock 
                                                label="Invoke Function" 
                                                code={generateCurl('POST', path, 'edge')} 
                                                onCopy={() => safeCopyToClipboard(generateCurl('POST', path, 'edge'), path)}
                                                copied={copiedUrl === path}
                                            />
                                            <p className="text-[10px] text-slate-400 mt-2 px-1">Edge functions run in an isolated V8 environment and accept JSON payload.</p>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* RPCs Section */}
                {visibleItems.rpcs.length > 0 && (
                    <div className="space-y-8">
                        {visibleItems.rpcs.map(name => {
                            const isExpanded = expandedItems.has(name);
                            const isParamsExpanded = expandedParams.has(name);
                            const path = `/rpc/${name}`;
                            const meta = richMetadata[name];
                            const args = meta?.fields || [];
                            
                            return (
                                <div key={name} id={`ref-${name}`} className={`bg-white border transition-all rounded-[2rem] overflow-hidden ${isExpanded ? 'border-amber-200 shadow-xl' : 'border-slate-200 hover:border-amber-200'}`}>
                                    <div 
                                        onClick={() => toggleItem(name, 'rpc')}
                                        className="p-6 flex items-center justify-between cursor-pointer bg-white hover:bg-slate-50/50 transition-colors"
                                    >
                                        <div className="flex items-center gap-4">
                                            <div className="w-10 h-10 bg-amber-50 text-amber-600 rounded-xl flex items-center justify-center">
                                                <Zap size={20}/>
                                            </div>
                                            <div>
                                                <h3 className="text-lg font-black text-slate-900 tracking-tight">{name}</h3>
                                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Stored Procedure</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className="px-2 py-1 rounded-md bg-emerald-50 text-emerald-600 text-[9px] font-black uppercase">POST</span>
                                            {isExpanded ? <ChevronDown size={20} className="text-slate-300"/> : <ChevronRight size={20} className="text-slate-300"/>}
                                        </div>
                                    </div>

                                    {isExpanded && (
                                        <div className="border-t border-slate-100 p-6 bg-slate-50/50">
                                            {/* Params Table (Collapsible) */}
                                            {args.length > 0 && (
                                                <div className="mb-6 bg-white rounded-xl border border-slate-200 overflow-hidden">
                                                    <div 
                                                        onClick={() => toggleParams(name)}
                                                        className="px-4 py-2 bg-slate-100 border-b border-slate-200 flex justify-between items-center cursor-pointer hover:bg-slate-200/50 transition-colors"
                                                    >
                                                        <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><ListFilter size={12}/> Arguments</span>
                                                        {isParamsExpanded ? <ChevronDown size={14} className="text-slate-400"/> : <ChevronRight size={14} className="text-slate-400"/>}
                                                    </div>
                                                    {isParamsExpanded && (
                                                        <div className="max-h-60 overflow-y-auto">
                                                            <table className="w-full text-left animate-in slide-in-from-top-1">
                                                                <tbody>
                                                                    {args.map((arg: any, idx: number) => (
                                                                        <tr key={idx} className="border-b border-slate-100 last:border-0">
                                                                            <td className="px-4 py-2 text-xs font-bold font-mono text-indigo-700">{arg.name}</td>
                                                                            <td className="px-4 py-2 text-xs font-mono text-slate-500">{arg.type}</td>
                                                                            <td className="px-4 py-2 text-xs font-black uppercase text-slate-400">{arg.mode || 'IN'}</td>
                                                                        </tr>
                                                                    ))}
                                                                </tbody>
                                                            </table>
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            <CodeBlock 
                                                label="Execute Function" 
                                                code={generateCurl('POST', path, 'rpc')} 
                                                onCopy={() => safeCopyToClipboard(generateCurl('POST', path, 'rpc'), path)}
                                                copied={copiedUrl === path}
                                            />
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
          </div>
      )}

      {/* CONNECT TAB (Combined Libraries & Integrations) */}
      {activeTab === 'connect' && (
          <div className="space-y-12 animate-in slide-in-from-right-4">
              
              {/* SDKs Section */}
              <div>
                  <h3 className="text-xl font-black text-slate-900 mb-6 flex items-center gap-2"><Code2 size={24} className="text-indigo-600"/> Client Libraries</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                      {/* Supabase JS */}
                      <div className="bg-white border border-emerald-100 rounded-[2.5rem] p-8 shadow-lg relative overflow-hidden group">
                          <div className="flex items-center gap-4 mb-4">
                              <div className="w-12 h-12 bg-emerald-500 text-white rounded-xl flex items-center justify-center shadow-lg"><Package size={24}/></div>
                              <div>
                                  <h4 className="text-lg font-black text-slate-900">Supabase JS</h4>
                                  <span className="text-[9px] font-bold bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded uppercase">Recommended</span>
                              </div>
                          </div>
                          <p className="text-xs text-slate-500 font-medium mb-6">Fully compatible. Use the official client to interact with Cascata.</p>
                          <div className="bg-slate-900 rounded-2xl p-4 border border-slate-800 relative group/code">
                              <pre className="font-mono text-[10px] text-emerald-400 whitespace-pre-wrap">{supabaseConfigCode.trim()}</pre>
                              <button onClick={() => safeCopyToClipboard(supabaseConfigCode.trim(), 'supacode')} className="absolute top-2 right-2 p-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-all opacity-0 group-hover/code:opacity-100">
                                  {copiedUrl === 'supacode' ? <Check size={12}/> : <Copy size={12}/>}
                              </button>
                          </div>
                      </div>

                      {/* Native Fetch */}
                      <div className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm hover:shadow-md transition-all">
                          <div className="flex items-center gap-4 mb-4">
                              <div className="w-12 h-12 bg-slate-900 text-white rounded-xl flex items-center justify-center shadow-lg"><Terminal size={24}/></div>
                              <div>
                                  <h4 className="text-lg font-black text-slate-900">Native Fetch</h4>
                                  <span className="text-[9px] font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded uppercase">Lightweight</span>
                              </div>
                          </div>
                          <p className="text-xs text-slate-500 font-medium mb-6">Zero dependencies. Use standard HTTP requests.</p>
                          <pre className="bg-slate-50 p-4 rounded-2xl font-mono text-[10px] text-slate-600 border border-slate-100">
{`await fetch('${getBaseUrl()}/tables/users/data', {
  headers: { 'apikey': '${projectData?.anon_key}' }
});`}
                          </pre>
                      </div>
                  </div>
              </div>

              {/* Integrations Section */}
              <div>
                  <h3 className="text-xl font-black text-slate-900 mb-6 flex items-center gap-2"><Blocks size={24} className="text-indigo-600"/> Low-Code Integrations</h3>
                  <div className="bg-indigo-600 text-white rounded-[2.5rem] p-10 shadow-2xl relative overflow-hidden">
                      <div className="absolute top-0 right-0 p-10 opacity-10"><Blocks size={180}/></div>
                      <div className="relative z-10 grid grid-cols-1 lg:grid-cols-2 gap-10">
                          <div>
                              <h4 className="text-2xl font-black tracking-tight mb-2">Connect FlutterFlow & AppSmith</h4>
                              <p className="text-indigo-100 text-sm font-medium mb-6">Use our Swagger/OpenAPI spec to instantly import all your tables and functions into low-code platforms.</p>
                              <div className="flex gap-3">
                                  <a href="https://docs.flutterflow.io/data/api-calls/openapi-import" target="_blank" rel="noreferrer" className="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2"><LinkIcon size={12}/> FlutterFlow Docs</a>
                                  <a href="https://docs.appsmith.com/" target="_blank" rel="noreferrer" className="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2"><LinkIcon size={12}/> AppSmith Docs</a>
                              </div>
                          </div>
                          <div className="bg-white/10 backdrop-blur-md rounded-2xl p-6 border border-white/20 space-y-4">
                              <div>
                                  <label className="text-[10px] font-black uppercase tracking-widest text-indigo-200">Import URL (Swagger)</label>
                                  <div className="flex gap-2 mt-1">
                                      <code className="flex-1 bg-black/20 p-2 rounded-lg font-mono text-[10px] truncate">{getSwaggerUrl()}</code>
                                      <button onClick={() => safeCopyToClipboard(getSwaggerUrl(), 'swagger')} className="p-2 bg-white text-indigo-600 rounded-lg hover:bg-indigo-50"><Copy size={14}/></button>
                                  </div>
                              </div>
                              <div>
                                  <label className="text-[10px] font-black uppercase tracking-widest text-indigo-200">API Key Header</label>
                                  <div className="flex gap-2 mt-1">
                                      <code className="flex-1 bg-black/20 p-2 rounded-lg font-mono text-[10px] truncate">{projectData?.anon_key}</code>
                                      <button onClick={() => safeCopyToClipboard(projectData?.anon_key, 'apikey')} className="p-2 bg-white text-indigo-600 rounded-lg hover:bg-indigo-50"><Copy size={14}/></button>
                                  </div>
                              </div>
                          </div>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {/* GUIDES TAB */}
      {activeTab === 'guides' && (
          <div className="flex gap-10 h-[600px]">
              <div className="w-64 shrink-0 flex flex-col gap-2">
                  <button onClick={() => setShowGenModal(true)} className="w-full bg-indigo-600 text-white py-3 rounded-xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 mb-4">
                      <Sparkles size={14}/> Write with AI
                  </button>
                  {guides.map(g => (
                      <button 
                        key={g.id}
                        onClick={() => setSelectedGuide(g)}
                        className={`text-left px-4 py-3 rounded-xl text-sm font-bold transition-all ${selectedGuide?.id === g.id ? 'bg-white shadow-md text-indigo-600' : 'text-slate-500 hover:bg-white hover:shadow-sm'}`}
                      >
                          {g.title}
                      </button>
                  ))}
                  {guides.length === 0 && <p className="text-center text-slate-400 text-xs py-10 font-bold">No guides yet.</p>}
              </div>
              <div className="flex-1 bg-white border border-slate-200 rounded-[2.5rem] p-10 overflow-y-auto shadow-sm">
                  {selectedGuide ? (
                      <article className="prose prose-slate max-w-none">
                          <h1 className="text-3xl font-black tracking-tight mb-2">{selectedGuide.title}</h1>
                          <p className="text-xs text-slate-400 font-bold uppercase tracking-widest mb-8">Auto-Generated by Cascata Architect</p>
                          <div className="whitespace-pre-wrap font-medium text-slate-600 leading-relaxed text-sm">
                              {selectedGuide.content_markdown}
                          </div>
                      </article>
                  ) : (
                      <div className="h-full flex flex-col items-center justify-center text-slate-300 gap-4">
                          <FileText size={48}/>
                          <span className="font-black uppercase tracking-widest text-xs">Select a guide</span>
                      </div>
                  )}
              </div>
          </div>
      )}

      {/* GENERATE GUIDE MODAL */}
      {showGenModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[600] flex items-center justify-center p-8 animate-in zoom-in-95">
              <div className="bg-white rounded-[3rem] w-full max-w-md p-10 shadow-2xl">
                  <h3 className="text-2xl font-black text-slate-900 mb-6 flex items-center gap-3"><Sparkles className="text-indigo-500"/> AI Technical Writer</h3>
                  <div className="space-y-4 mb-8">
                      <p className="text-xs text-slate-500 font-bold">Select a table to generate a comprehensive integration guide.</p>
                      <div className="grid grid-cols-2 gap-3 max-h-60 overflow-y-auto">
                          {tablesList.map(t => (
                              <button key={t} onClick={() => handleGenerateDoc(t)} className="bg-slate-50 hover:bg-indigo-50 hover:text-indigo-700 text-slate-600 py-3 rounded-xl text-xs font-bold transition-all border border-slate-200 hover:border-indigo-200">
                                  {t}
                              </button>
                          ))}
                      </div>
                  </div>
                  <button onClick={() => setShowGenModal(false)} className="w-full py-4 text-xs font-black text-slate-400 uppercase tracking-widest hover:text-slate-600">Cancel</button>
                  {generating && <div className="absolute inset-0 bg-white/90 flex flex-col items-center justify-center z-10 rounded-[3rem]"><Loader2 className="animate-spin text-indigo-600 mb-4" size={40}/><span className="text-xs font-black uppercase tracking-widest animate-pulse">Writing Documentation...</span></div>}
              </div>
          </div>
      )}
    </div>
  );
};

const CodeBlock: React.FC<{ label: string, code: string, onCopy: () => void, copied: boolean }> = ({ label, code, onCopy, copied }) => (
    <div className="relative group">
        <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">{label}</span>
            <button onClick={onCopy} className="text-indigo-500 text-[10px] font-bold uppercase hover:underline flex items-center gap-1">
                {copied ? <><Check size={10}/> Copied</> : <><Copy size={10}/> Copy</>}
            </button>
        </div>
        <pre className="bg-slate-900 text-slate-300 p-6 rounded-2xl font-mono text-xs overflow-x-auto border border-slate-800 shadow-inner leading-relaxed">
            {code}
        </pre>
    </div>
);

const CrudExample: React.FC<{
    name: string;
    path: string;
    generateCurl: (method: string, path: string, type: 'table' | 'rpc' | 'edge') => string;
    safeCopyToClipboard: (text: string, id: string) => void;
    copiedUrl: string | null;
    richData: any;
    isParamsExpanded: boolean;
    onToggleParams: () => void;
    activeOp: string;
}> = ({ name, path, generateCurl, safeCopyToClipboard, copiedUrl, richData, isParamsExpanded, onToggleParams, activeOp }) => (
    <div className="p-6 bg-slate-50/50 space-y-8 animate-in fade-in slide-in-from-top-2 duration-300">
        {/* Params Table (Collapsible) */}
        {richData?.fields && richData.fields.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div 
                    onClick={onToggleParams}
                    className="px-4 py-2 bg-slate-100 border-b border-slate-200 flex justify-between items-center cursor-pointer hover:bg-slate-200/50 transition-colors"
                >
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><ListFilter size={12}/> Schema Fields</span>
                    {isParamsExpanded ? <ChevronDown size={14} className="text-slate-400"/> : <ChevronRight size={14} className="text-slate-400"/>}
                </div>
                {isParamsExpanded && (
                    <div className="max-h-60 overflow-y-auto">
                        <table className="w-full text-left animate-in slide-in-from-top-1">
                            <tbody>
                                {richData.fields.map((field: any, idx: number) => (
                                    <tr key={idx} className="border-b border-slate-100 last:border-0">
                                        <td className="px-4 py-2 text-xs font-bold font-mono text-indigo-700">{field.name}</td>
                                        <td className="px-4 py-2 text-xs font-mono text-slate-500">{field.type}</td>
                                        <td className="px-4 py-2 text-xs text-slate-400">
                                            {field.isPrimaryKey && <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-[9px] font-black uppercase mr-1">PK</span>}
                                            {field.is_nullable === 'NO' && !field.column_default && !field.isPrimaryKey && <span className="bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded text-[9px] font-black uppercase">REQ</span>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        )}

        <div>
            {activeOp === 'GET' && (
                <CodeBlock 
                    label="List (GET)" 
                    code={generateCurl('GET', path, 'table')} 
                    onCopy={() => safeCopyToClipboard(generateCurl('GET', path, 'table'), `get-${name}`)}
                    copied={copiedUrl === `get-${name}`}
                />
            )}
            {activeOp === 'POST' && (
                <CodeBlock 
                    label="Create (POST)" 
                    code={generateCurl('POST', path, 'table')} 
                    onCopy={() => safeCopyToClipboard(generateCurl('POST', path, 'table'), `post-${name}`)}
                    copied={copiedUrl === `post-${name}`}
                />
            )}
            {activeOp === 'PATCH' && (
                <CodeBlock 
                    label="Update (PATCH)" 
                    code={generateCurl('PATCH', path, 'table')} 
                    onCopy={() => safeCopyToClipboard(generateCurl('PATCH', path, 'table'), `patch-${name}`)}
                    copied={copiedUrl === `patch-${name}`}
                />
            )}
            {activeOp === 'DELETE' && (
                <CodeBlock 
                    label="Delete (DELETE)" 
                    code={generateCurl('DELETE', path, 'table')} 
                    onCopy={() => safeCopyToClipboard(generateCurl('DELETE', path, 'table'), `delete-${name}`)}
                    copied={copiedUrl === `delete-${name}`}
                />
            )}
        </div>
    </div>
);

export default APIDocs;
