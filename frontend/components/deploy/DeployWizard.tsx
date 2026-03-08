
import React, { useState, useEffect, useMemo } from 'react';
import { 
  GitMerge, RefreshCcw, Loader2, X, CheckCircle2, AlertOctagon, 
  ShieldCheck, Database, Plus, GitCompare, ChevronDown, ChevronRight,
  AlertTriangle, ArrowRight, GripVertical, FileText, Code
} from 'lucide-react';

interface DeployWizardProps {
  projectId: string;
  onClose: () => void;
  onSuccess: () => void;
}

interface DataStrategy {
  table: string;
  strategy: 'ignore' | 'append' | 'upsert' | 'overwrite';
}

const DeployWizard: React.FC<DeployWizardProps> = ({ projectId, onClose, onSuccess }) => {
  // STATE
  const [step, setStep] = useState<'strategy' | 'diff' | 'data' | 'review' | 'executing' | 'success'>('strategy');
  const [deployStrategy, setDeployStrategy] = useState<'merge' | 'swap'>('merge');
  const [diffData, setDiffData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // GRANULAR DATA PLAN
  const [tableStrategies, setTableStrategies] = useState<Record<string, 'ignore' | 'append' | 'upsert' | 'overwrite'>>({});
  
  // UI Tabs for Diff View
  const [activeTab, setActiveTab] = useState<'schema' | 'security' | 'sql'>('schema');

  // FETCH DIFF
  useEffect(() => {
    if (step === 'diff' || step === 'data') {
        const loadDiff = async () => {
            setLoading(true);
            try {
                const res = await fetch(`/api/data/${projectId}/branch/diff`, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
                });
                const data = await res.json();
                setDiffData(data.diff);
                
                // Initialize strategies based on server recommendation or default
                const initStrategies: any = {};
                if (data.diff.data_summary) {
                    data.diff.data_summary.forEach((sum: any) => {
                        // Intelligent Default: If schema changed, maybe ignore? If only new rows, append.
                        // Default to 'ignore' for safety, let user opt-in.
                        initStrategies[sum.table] = 'ignore';
                    });
                }
                setTableStrategies(initStrategies);
            } catch (e) { setError("Failed to load diff."); }
            finally { setLoading(false); }
        };
        loadDiff();
    }
  }, [step, projectId]);

  // EXECUTE DEPLOY
  const handleDeploy = async () => {
      setStep('executing');
      try {
          await fetch(`/api/data/${projectId}/branch/deploy`, {
              method: 'POST',
              headers: { 
                  'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`, 
                  'Content-Type': 'application/json' 
              },
              body: JSON.stringify({ 
                  strategy: deployStrategy,
                  sql: diffData?.generated_sql,
                  dry_run: false,
                  data_plan: tableStrategies // SEND GRANULAR PLAN
              })
          });
          setStep('success');
      } catch (e: any) {
          setError(e.message || "Deploy failed.");
          setStep('review');
      }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[900] flex items-center justify-center p-8 animate-in zoom-in-95 font-sans">
        <div className="bg-white rounded-[2.5rem] w-full max-w-5xl h-[85vh] flex flex-col shadow-2xl border border-slate-200 overflow-hidden relative">
            
            {/* HEADER */}
            <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                <div className="flex items-center gap-4">
                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-white shadow-lg ${deployStrategy === 'swap' ? 'bg-rose-500' : 'bg-indigo-600'}`}>
                        {deployStrategy === 'swap' ? <RefreshCcw size={24}/> : <GitMerge size={24}/>}
                    </div>
                    <div>
                        <h3 className="text-2xl font-black text-slate-900 tracking-tight">Deploy Manager</h3>
                        <div className="flex items-center gap-2 mt-1">
                            {['Strategy', 'Schema Diff', 'Data Control', 'Review'].map((s, i) => (
                                <div key={s} className={`flex items-center text-[10px] font-bold uppercase tracking-widest ${
                                    ['strategy', 'diff', 'data', 'review'].indexOf(step) >= i ? 'text-indigo-600' : 'text-slate-300'
                                }`}>
                                    {i > 0 && <ChevronRight size={12} className="mx-1 text-slate-300"/>}
                                    {s}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                <button onClick={onClose} className="p-3 hover:bg-slate-200 rounded-full text-slate-400"><X size={20}/></button>
            </div>

            {/* BODY */}
            <div className="flex-1 overflow-y-auto p-8 bg-[#FAFBFC]">
                
                {/* STEP 1: STRATEGY SELECTION */}
                {step === 'strategy' && (
                    <div className="h-full flex flex-col items-center justify-center gap-8">
                        <h2 className="text-3xl font-black text-slate-900 text-center max-w-md">Choose your deployment strategy</h2>
                        <div className="grid grid-cols-2 gap-6 w-full max-w-3xl">
                            <button 
                                onClick={() => { setDeployStrategy('merge'); setStep('diff'); }}
                                className="group relative p-8 bg-white border-2 border-slate-200 rounded-[2rem] hover:border-indigo-500 hover:shadow-xl transition-all text-left flex flex-col"
                            >
                                <div className="w-12 h-12 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600 mb-4 group-hover:scale-110 transition-transform"><GitMerge size={24}/></div>
                                <h4 className="text-lg font-black text-slate-900 mb-2">Safe Merge (Smart)</h4>
                                <p className="text-sm text-slate-500 font-medium leading-relaxed">
                                    Applies schema changes intelligently. Allows granular control over data insertion (Append/Upsert) without losing live data.
                                </p>
                                <span className="mt-6 text-xs font-black text-indigo-600 uppercase tracking-widest flex items-center gap-2">Recommended <ArrowRight size={12}/></span>
                            </button>

                            <button 
                                onClick={() => { setDeployStrategy('swap'); setStep('review'); }}
                                className="group relative p-8 bg-white border-2 border-slate-200 rounded-[2rem] hover:border-rose-500 hover:shadow-xl transition-all text-left flex flex-col"
                            >
                                <div className="w-12 h-12 bg-rose-50 rounded-2xl flex items-center justify-center text-rose-600 mb-4 group-hover:scale-110 transition-transform"><RefreshCcw size={24}/></div>
                                <h4 className="text-lg font-black text-slate-900 mb-2">Destructive Swap</h4>
                                <p className="text-sm text-slate-500 font-medium leading-relaxed">
                                    Replaces the entire Live environment with Draft. <span className="text-rose-600 font-bold">ALL LIVE DATA WILL BE LOST.</span> Use only for full resets.
                                </p>
                            </button>
                        </div>
                    </div>
                )}

                {/* STEP 2: SCHEMA DIFF */}
                {step === 'diff' && (
                    <div className="space-y-6">
                        {loading ? <div className="py-20 flex justify-center"><Loader2 className="animate-spin text-indigo-600" size={40}/></div> : (
                            <>
                                <div className="flex bg-slate-100 p-1 rounded-xl w-fit">
                                    <button onClick={() => setActiveTab('schema')} className={`px-6 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab==='schema' ? 'bg-white shadow text-indigo-600' : 'text-slate-400'}`}>Schema</button>
                                    <button onClick={() => setActiveTab('security')} className={`px-6 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab==='security' ? 'bg-white shadow text-indigo-600' : 'text-slate-400'}`}>Security</button>
                                    <button onClick={() => setActiveTab('sql')} className={`px-6 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab==='sql' ? 'bg-white shadow text-indigo-600' : 'text-slate-400'}`}>Raw SQL</button>
                                </div>
                                
                                <div className="bg-white border border-slate-200 rounded-[2rem] p-8 min-h-[400px]">
                                    {activeTab === 'schema' && (
                                        <div className="space-y-4">
                                            {diffData?.added_tables?.map((t: string) => (
                                                <div key={t} className="bg-emerald-50 border border-emerald-100 p-4 rounded-xl flex items-center gap-3">
                                                    <div className="w-8 h-8 bg-emerald-100 rounded-lg flex items-center justify-center text-emerald-600"><Plus size={16}/></div>
                                                    <span className="font-bold text-emerald-900 text-sm">New Table: {t}</span>
                                                </div>
                                            ))}
                                            {diffData?.modified_tables?.map((m: any) => (
                                                <div key={m.table} className="bg-white border border-indigo-100 p-4 rounded-xl shadow-sm">
                                                    <div className="font-bold text-sm text-slate-800 mb-2 flex items-center gap-2"><GitCompare size={14} className="text-indigo-500"/> {m.table}</div>
                                                    <div className="flex gap-2 flex-wrap">
                                                        {m.added_cols?.map((c: string) => <span key={c} className="text-[10px] bg-emerald-50 text-emerald-700 px-2 py-1 rounded font-bold">+ {c}</span>)}
                                                        {m.renamed_cols?.map((c: any) => <span key={c.from} className="text-[10px] bg-amber-50 text-amber-700 px-2 py-1 rounded font-bold">{c.from} ➔ {c.to}</span>)}
                                                    </div>
                                                </div>
                                            ))}
                                            {(!diffData?.added_tables?.length && !diffData?.modified_tables?.length) && (
                                                <p className="text-center text-slate-400 font-bold uppercase text-xs py-20">No schema changes detected.</p>
                                            )}
                                        </div>
                                    )}
                                    {activeTab === 'sql' && (
                                        <pre className="bg-slate-900 text-emerald-400 p-6 rounded-2xl font-mono text-xs overflow-auto max-h-[500px]">
                                            {diffData?.generated_sql || '-- No SQL generated'}
                                        </pre>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* STEP 3: DATA CONTROL (THE KILLER FEATURE) */}
                {step === 'data' && (
                    <div className="space-y-6 animate-in slide-in-from-right-4">
                        <div className="flex items-center justify-between">
                            <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3">
                                <Database size={20} className="text-indigo-600"/> Granular Data Control
                            </h3>
                            <div className="text-xs text-slate-500 font-medium bg-slate-100 px-3 py-1 rounded-lg">
                                Configure how data from Draft merges into Live.
                            </div>
                        </div>

                        <div className="space-y-3">
                            {diffData?.data_summary?.map((sum: any) => (
                                <div key={sum.table} className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex items-center justify-between group hover:border-indigo-200 transition-all">
                                    <div className="flex-1">
                                        <div className="flex items-center gap-3 mb-2">
                                            <h4 className="font-black text-sm text-slate-900">{sum.table}</h4>
                                            <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded font-bold uppercase">Live: {sum.total_target} rows</span>
                                        </div>
                                        <div className="flex gap-4 text-xs font-medium">
                                            <span className={`flex items-center gap-1 ${sum.new_rows > 0 ? 'text-emerald-600 font-bold' : 'text-slate-400'}`}>
                                                <Plus size={12}/> {sum.new_rows} New
                                            </span>
                                            <span className={`flex items-center gap-1 ${sum.conflicts > 0 ? 'text-amber-600 font-bold' : 'text-slate-400'}`}>
                                                <AlertTriangle size={12}/> {sum.conflicts} Conflicts (ID Match)
                                            </span>
                                            <span className="text-slate-400 flex items-center gap-1">
                                                <X size={12}/> {sum.missing_rows} Missing in Draft
                                            </span>
                                        </div>
                                    </div>

                                    {/* Strategy Selector */}
                                    <div className="flex gap-2">
                                        {[
                                            { id: 'ignore', label: 'Ignore', color: 'bg-slate-100 text-slate-500', desc: 'Do nothing' },
                                            { id: 'append', label: 'Append (Safe)', color: 'bg-emerald-50 text-emerald-700', desc: 'Add new rows only' },
                                            { id: 'upsert', label: 'Upsert', color: 'bg-amber-50 text-amber-700', desc: 'Update existing & Add new' },
                                            { id: 'overwrite', label: 'Overwrite', color: 'bg-rose-50 text-rose-700', desc: 'Replace table completely' }
                                        ].map(opt => (
                                            <button 
                                                key={opt.id}
                                                onClick={() => setTableStrategies({...tableStrategies, [sum.table]: opt.id as any})}
                                                className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase transition-all flex flex-col items-center gap-1 min-w-[80px] border-2 ${
                                                    tableStrategies[sum.table] === opt.id 
                                                    ? `${opt.color} border-current` 
                                                    : 'bg-white border-transparent text-slate-400 hover:bg-slate-50'
                                                }`}
                                                title={opt.desc}
                                            >
                                                {opt.label}
                                                {tableStrategies[sum.table] === opt.id && <CheckCircle2 size={12}/>}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}
                            {(!diffData?.data_summary || diffData.data_summary.length === 0) && (
                                <div className="text-center py-20 text-slate-400 font-bold text-xs uppercase">
                                    No data differences detected or tables are empty.
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* STEP 4: SUCCESS */}
                {step === 'success' && (
                    <div className="h-full flex flex-col items-center justify-center text-center">
                        <div className="w-24 h-24 bg-emerald-100 rounded-full flex items-center justify-center mb-6 animate-in zoom-in"><CheckCircle2 size={48} className="text-emerald-600"/></div>
                        <h2 className="text-3xl font-black text-slate-900 mb-2">Deploy Successful</h2>
                        <p className="text-slate-500 font-medium mb-8">Your changes are now live in production.</p>
                        <button onClick={() => { onSuccess(); onClose(); }} className="bg-slate-900 text-white px-8 py-3 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-indigo-600 transition-all">Done</button>
                    </div>
                )}
            </div>

            {/* FOOTER ACTIONS */}
            {step !== 'success' && (
                <div className="p-8 border-t border-slate-100 bg-white flex justify-between items-center shrink-0">
                    <button onClick={onClose} className="px-6 py-3 rounded-2xl text-xs font-black text-slate-400 uppercase tracking-widest hover:bg-slate-50">Cancel</button>
                    
                    <div className="flex gap-4">
                        {step === 'diff' && (
                            <button onClick={() => setStep('data')} className="bg-indigo-600 text-white px-8 py-3 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-indigo-700 transition-all flex items-center gap-2">
                                Next: Data Control <ArrowRight size={14}/>
                            </button>
                        )}
                        {(step === 'data' || step === 'review') && (
                            <button onClick={handleDeploy} disabled={loading} className={`px-8 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 text-white shadow-xl ${deployStrategy === 'swap' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
                                {loading ? <Loader2 className="animate-spin" size={14}/> : (deployStrategy === 'swap' ? <AlertOctagon size={14}/> : <Rocket size={14}/>)}
                                {deployStrategy === 'swap' ? 'Confirm Swap' : 'Execute Merge'}
                            </button>
                        )}
                        {step === 'strategy' && deployStrategy === 'merge' && (
                            <button onClick={() => setStep('diff')} className="bg-indigo-600 text-white px-8 py-3 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-indigo-700 transition-all">
                                Analyze Changes
                            </button>
                        )}
                    </div>
                </div>
            )}

        </div>
    </div>
  );
};

// Import Helper for the Icon (Missing in imports above)
import { Rocket } from 'lucide-react';

export default DeployWizard;
