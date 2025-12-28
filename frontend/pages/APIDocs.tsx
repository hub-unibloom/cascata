
import React, { useState, useEffect } from 'react';
import { 
  BookOpen, Copy, Globe, Database, Code2, 
  ChevronRight, ChevronDown, Loader2, FileText, 
  Sparkles, Plus, Edit3, Search, Check, Terminal
} from 'lucide-react';

interface APIDocsProps {
  projectId: string;
}

const APIDocs: React.FC<APIDocsProps> = ({ projectId }) => {
  const [activeTab, setActiveTab] = useState<'reference' | 'guides'>('reference');
  const [spec, setSpec] = useState<any>(null);
  const [guides, setGuides] = useState<any[]>([]);
  const [selectedGuide, setSelectedGuide] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  
  // Search & Copy State
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [projectData, setProjectData] = useState<any>(null);

  // AI Generation State
  const [tables, setTables] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [showGenModal, setShowGenModal] = useState(false);

  useEffect(() => {
    fetchData();
  }, [projectId]);

  const fetchData = async () => {
    try {
      const token = localStorage.getItem('cascata_token');
      const headers = { 'Authorization': `Bearer ${token}` };
      
      const [specRes, guidesRes, tablesRes, projectRes] = await Promise.all([
        fetch(`/api/data/${projectId}/docs/openapi`, { headers }),
        fetch(`/api/data/${projectId}/docs/pages`, { headers }),
        fetch(`/api/data/${projectId}/tables`, { headers }),
        fetch('/api/control/projects', { headers })
      ]);
      
      setSpec(await specRes.json());
      const g = await guidesRes.json();
      setGuides(g);
      if(g.length > 0 && !selectedGuide) setSelectedGuide(g[0]);
      
      const t = await tablesRes.json();
      setTables(t.map((r: any) => r.name));

      const projects = await projectRes.json();
      const current = projects.find((p: any) => p.slug === projectId);
      setProjectData(current);
      
    } catch (e) {
      console.error("Failed to load docs");
    } finally {
      setLoading(false);
    }
  };

  const generateCurl = (method: string, path: string, bodySchema: any) => {
      let baseUrl = spec?.servers?.[0]?.url;
      
      // Intelligent Protocol/Host Resolution
      if (projectData?.custom_domain) {
          baseUrl = `https://${projectData.custom_domain}`;
      } else if (baseUrl && baseUrl.startsWith('/')) {
          baseUrl = `${window.location.origin}${baseUrl}`;
      }

      const url = `${baseUrl}${path}`;
      const anonKey = projectData?.anon_key || '<YOUR_ANON_KEY>';
      
      let cmd = `curl -X ${method.toUpperCase()} "${url}" \\\n`;
      cmd += `  -H "apikey: ${anonKey}" \\\n`;
      cmd += `  -H "Content-Type: application/json"`;

      if (method !== 'get' && method !== 'delete') {
          let body = '{}';
          if (bodySchema) {
              const example: any = {};
              Object.keys(bodySchema).forEach(key => {
                  example[key] = bodySchema[key].type === 'integer' ? 0 : bodySchema[key].type === 'boolean' ? false : "string";
              });
              body = JSON.stringify(example);
          }
          cmd += ` \\\n  -d '${body}'`;
      }

      return cmd;
  };

  const safeCopyToClipboard = (text: string, id: string = 'global') => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
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
        } catch (err) {}
        document.body.removeChild(textArea);
    }
    setCopiedUrl(id);
    setTimeout(() => setCopiedUrl(null), 2000);
  };

  const handleGenerateDoc = async (tableName: string) => {
      setGenerating(true);
      try {
          const token = localStorage.getItem('cascata_token');
          const res = await fetch(`/api/data/${projectId}/ai/draft-doc`, {
              method: 'POST',
              headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}` 
              },
              body: JSON.stringify({ tableName })
          });
          const newDoc = await res.json();
          setGuides([...guides, newDoc]);
          setSelectedGuide(newDoc);
          setShowGenModal(false);
          setActiveTab('guides');
      } catch(e) {
          alert("Erro na geração.");
      } finally {
          setGenerating(false);
      }
  };

  const togglePath = (path: string) => {
    const next = new Set(expandedPaths);
    if (next.has(path)) next.delete(path); else next.add(path);
    setExpandedPaths(next);
  };

  // Filter paths
  const filteredPaths = spec ? Object.entries(spec.paths).filter(([path]) => 
    path.toLowerCase().includes(searchQuery.toLowerCase())
  ) : [];

  if (loading) return <div className="p-20 flex justify-center"><Loader2 className="animate-spin text-indigo-600" /></div>;

  return (
    <div className="p-10 max-w-7xl mx-auto w-full space-y-10 pb-40">
      <header className="flex flex-col gap-8">
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-emerald-600 text-white rounded-[1.5rem] flex items-center justify-center shadow-xl">
                <BookOpen size={28} />
            </div>
            <div>
                <h1 className="text-4xl font-black text-slate-900 tracking-tighter">Documentation</h1>
                <p className="text-slate-500 font-medium">Single Source of Truth</p>
            </div>
            </div>
            
            <div className="flex bg-slate-100 p-1.5 rounded-2xl">
                <button onClick={() => setActiveTab('reference')} className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'reference' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}>API Reference</button>
                <button onClick={() => setActiveTab('guides')} className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'guides' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-400 hover:text-slate-600'}`}>Guides & Manuals</button>
            </div>
        </div>
        
        {activeTab === 'reference' && (
            <div className="bg-slate-900 text-white p-6 rounded-[2rem] flex items-center justify-between shadow-2xl">
            <div className="flex items-center gap-4">
                <Globe className="text-emerald-400" />
                <div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Base URL</span>
                    <code className="block font-mono text-sm font-bold mt-1">
                        {projectData?.custom_domain 
                            ? `https://${projectData.custom_domain}` 
                            : spec?.servers?.[0]?.url.startsWith('/') 
                                ? `${window.location.origin}${spec?.servers?.[0]?.url}` 
                                : spec?.servers?.[0]?.url
                        }
                    </code>
                </div>
            </div>
            <button onClick={() => safeCopyToClipboard(spec?.servers?.[0]?.url)} className="p-3 bg-white/10 hover:bg-white/20 rounded-xl transition-all">
                {copiedUrl === 'global' ? <Check size={18} className="text-emerald-400"/> : <Copy size={18}/>}
            </button>
            </div>
        )}
      </header>

      {activeTab === 'reference' ? (
          <div className="space-y-6">
            <div className="relative">
                <Search className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400" size={18}/>
                <input 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search endpoints..." 
                    className="w-full pl-14 pr-6 py-4 bg-white border border-slate-200 rounded-[2rem] text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/20" 
                />
            </div>

            {filteredPaths.map(([path, methods]: [string, any]) => {
            const isExpanded = expandedPaths.has(path);
            return (
                <div key={path} className="bg-white border border-slate-200 rounded-[2.5rem] overflow-hidden shadow-sm hover:shadow-md transition-all">
                    <div 
                    onClick={() => togglePath(path)}
                    className="p-6 flex items-center justify-between cursor-pointer bg-slate-50 hover:bg-white transition-colors"
                    >
                    <div className="flex items-center gap-4">
                        {isExpanded ? <ChevronDown size={20} className="text-slate-400"/> : <ChevronRight size={20} className="text-slate-400"/>}
                        <span className="font-mono text-sm font-bold text-slate-700">{path}</span>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="flex gap-2">
                            {Object.keys(methods).map(m => (
                                <span key={m} className={`text-[9px] font-black uppercase px-2 py-1 rounded-lg ${m === 'get' ? 'bg-blue-100 text-blue-700' : m === 'post' ? 'bg-emerald-100 text-emerald-700' : m === 'delete' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>
                                    {m}
                                </span>
                            ))}
                        </div>
                    </div>
                    </div>

                    {isExpanded && (
                    <div className="p-8 border-t border-slate-100 space-y-8 animate-in slide-in-from-top-2">
                        {Object.entries(methods).map(([method, detail]: [string, any]) => {
                            const params = detail.parameters || [];
                            const bodySchema = detail.requestBody?.content?.['application/json']?.schema?.properties;
                            const requiredParams = detail.requestBody?.content?.['application/json']?.schema?.required || [];
                            const curlCommand = generateCurl(method, path, bodySchema);

                            return (
                            <div key={method} className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <span className={`text-xs font-black uppercase px-3 py-1.5 rounded-xl ${method === 'get' ? 'bg-blue-600 text-white' : method === 'post' ? 'bg-emerald-600 text-white' : method === 'delete' ? 'bg-rose-600 text-white' : 'bg-amber-600 text-white'}`}>
                                            {method}
                                        </span>
                                        <span className="text-sm font-bold text-slate-900">{detail.summary}</span>
                                    </div>
                                    <button 
                                        onClick={() => safeCopyToClipboard(curlCommand, `${method}-${path}`)} 
                                        className="bg-slate-900 text-white hover:bg-indigo-600 px-4 py-2 rounded-xl flex items-center gap-2 text-[10px] font-bold uppercase transition-all shadow-lg"
                                    >
                                        {copiedUrl === `${method}-${path}` ? <Check size={14} className="text-emerald-400"/> : <Terminal size={14}/>} Copy cURL
                                    </button>
                                </div>
                                
                                {/* Parameters Table */}
                                {(params.length > 0 || bodySchema) && (
                                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200">
                                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Request Parameters</h4>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-left">
                                            <thead>
                                                <tr className="border-b border-slate-200 text-[10px] font-black text-slate-500 uppercase">
                                                    <th className="pb-2">Name</th>
                                                    <th className="pb-2">Type</th>
                                                    <th className="pb-2">Required</th>
                                                    <th className="pb-2">Description</th>
                                                </tr>
                                            </thead>
                                            <tbody className="text-xs text-slate-700">
                                                {params.map((p: any) => (
                                                    <tr key={p.name} className="border-b border-slate-100 last:border-0">
                                                        <td className="py-2 font-mono font-bold">{p.name}</td>
                                                        <td className="py-2 text-indigo-600">{p.schema?.type}</td>
                                                        <td className="py-2">{p.required ? 'Yes' : 'No'}</td>
                                                        <td className="py-2 text-slate-500">{p.description || '-'}</td>
                                                    </tr>
                                                ))}
                                                {bodySchema && Object.entries(bodySchema).map(([key, prop]: [string, any]) => {
                                                    if (prop.properties) {
                                                        return Object.entries(prop.properties).map(([subKey, subProp]: [string, any]) => (
                                                            <tr key={subKey} className="border-b border-slate-100 last:border-0">
                                                                <td className="py-2 font-mono font-bold">{subKey}</td>
                                                                <td className="py-2 text-indigo-600">{subProp.type}</td>
                                                                <td className="py-2">{requiredParams.includes(subKey) ? 'Yes' : 'No'}</td>
                                                                <td className="py-2 text-slate-500">{subProp.description || '-'}</td>
                                                            </tr>
                                                        ));
                                                    }
                                                    return (
                                                        <tr key={key} className="border-b border-slate-100 last:border-0">
                                                            <td className="py-2 font-mono font-bold">{key}</td>
                                                            <td className="py-2 text-indigo-600">{prop.type}</td>
                                                            <td className="py-2">{requiredParams.includes(key) ? 'Yes' : 'No'}</td>
                                                            <td className="py-2 text-slate-500">{prop.description || '-'}</td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                                )}

                                {/* Response & Example */}
                                <div className="grid grid-cols-1 gap-4">
                                    <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
                                        <h4 className="text-[10px] font-black text-emerald-400 uppercase tracking-widest mb-4">Response (200 OK)</h4>
                                        <pre className="font-mono text-xs text-slate-300 whitespace-pre-wrap">
                                            {JSON.stringify(detail.responses['200'] || detail.responses['201'], null, 2)}
                                        </pre>
                                    </div>
                                </div>
                            </div>
                        )})}
                    </div>
                    )}
                </div>
            );
            })}
            
            {filteredPaths.length === 0 && (
                <div className="text-center py-20 text-slate-400">
                    <Search size={48} className="mx-auto mb-4 opacity-20"/>
                    <p className="font-bold text-sm">No endpoints found matching "{searchQuery}"</p>
                </div>
            )}
          </div>
      ) : (
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

      {showGenModal && (
          <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[600] flex items-center justify-center p-8 animate-in zoom-in-95">
              <div className="bg-white rounded-[3rem] w-full max-w-md p-10 shadow-2xl">
                  <h3 className="text-2xl font-black text-slate-900 mb-6 flex items-center gap-3"><Sparkles className="text-indigo-500"/> AI Technical Writer</h3>
                  <div className="space-y-4 mb-8">
                      <p className="text-xs text-slate-500 font-bold">Select a table to generate a comprehensive integration guide.</p>
                      <div className="grid grid-cols-2 gap-3 max-h-60 overflow-y-auto">
                          {tables.map(t => (
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

export default APIDocs;
