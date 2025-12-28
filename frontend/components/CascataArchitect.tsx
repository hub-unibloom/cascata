
import React, { useState, useEffect, useRef } from 'react';
import { 
  Sparkles, Send, Mic, MicOff, X, 
  Terminal, Database, Play, Check, Loader2, Volume2, 
  Copy, Maximize2, Move
} from 'lucide-react';

interface ArchitectProps {
  projectId: string;
}

// Helper robusto para gerar UUIDs em ambientes HTTP/HTTPS
const getUUID = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID(); } catch(e) { /* ignore */ }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

const CascataArchitect: React.FC<ArchitectProps> = ({ projectId }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant', content: string, type?: 'text' | 'sql' | 'json', actionData?: any }[]>([]);
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionId, setSessionId] = useState('');
  
  // AI Config State
  const [aiSettings, setAiSettings] = useState<any>({ active_listening: false, wake_word: 'Cascata' });
  const [isActiveListeningMode, setIsActiveListeningMode] = useState(false); // Mode enabled in settings
  const [isWakeWordDetected, setIsWakeWordDetected] = useState(false); // Currently capturing after wake word

  // Resize State
  const [dimensions, setDimensions] = useState({ width: 400, height: 600 });
  const [isResizing, setIsResizing] = useState(false);

  // Voice Recognition Setup
  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const silenceTimer = useRef<any>(null);
  const transcriptBuffer = useRef<string>(''); // Holds FINALIZED text only
  const inputRef = useRef<string>(''); // Holds current visible input for timer access

  // Sync ref with state
  useEffect(() => { inputRef.current = input; }, [input]);

  // Handle Resize
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const newWidth = window.innerWidth - e.clientX - 32; // 32px margin
      const newHeight = window.innerHeight - e.clientY - 32;
      setDimensions({
        width: Math.max(300, Math.min(newWidth, 800)),
        height: Math.max(400, Math.min(newHeight, 900))
      });
    };
    const handleMouseUp = () => setIsResizing(false);
    
    if (isResizing) {
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Initialize Session & Config
  useEffect(() => {
    let storedSession = localStorage.getItem(`ai_session_${projectId}`);
    if (!storedSession) {
      storedSession = getUUID(); 
      localStorage.setItem(`ai_session_${projectId}`, storedSession);
    }
    setSessionId(storedSession);
    loadHistory(storedSession);
    loadConfig();
  }, [projectId]);

  useEffect(() => {
    if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  const loadConfig = async () => {
      try {
          const res = await fetch('/api/control/system/settings', {
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          const data = await res.json();
          if (data.ai) {
              setAiSettings(data.ai);
              setIsActiveListeningMode(data.ai.active_listening);
              if (data.ai.active_listening) {
                  startContinuousListening();
              }
          }
      } catch (e) {}
  };

  const loadHistory = async (sid: string) => {
    try {
        const token = localStorage.getItem('cascata_token');
        const res = await fetch(`/api/data/${projectId}/ai/history/${sid}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        const formatted = data.map((msg: any) => ({
            role: msg.role,
            content: msg.content,
            type: msg.content.includes('"action": "create_table"') ? 'json' : msg.content.includes('```sql') ? 'sql' : 'text',
            actionData: msg.content.includes('"action": "create_table"') ? extractJSON(msg.content) : null
        }));
        setMessages(formatted);
    } catch (e) { console.error("History load failed"); }
  };

  const extractJSON = (text: string) => {
      try {
          const match = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/{[\s\S]*}/);
          if (match) return JSON.parse(match[1] || match[0]);
      } catch (e) { return null; }
      return null;
  };

  const playPing = () => {
      try {
          const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          const oscillator = audioCtx.createOscillator();
          const gainNode = audioCtx.createGain();
          oscillator.connect(gainNode);
          gainNode.connect(audioCtx.destination);
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); 
          gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
          oscillator.start();
          oscillator.stop(audioCtx.currentTime + 0.15);
      } catch(e) {}
  };

  const startContinuousListening = () => {
    if (!('webkitSpeechRecognition' in window)) return;
    if (recognitionRef.current) return; // Already running

    const recognition = new (window as any).webkitSpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'pt-BR'; 

    recognition.onresult = (event: any) => {
        if (silenceTimer.current) clearTimeout(silenceTimer.current);

        let interimTranscript = '';
        let finalTranscript = '';

        // Separate final results from interim results to prevent duplication
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript + ' ';
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }

        // Append final results to the persistent buffer
        if (finalTranscript) {
            transcriptBuffer.current += finalTranscript;
        }

        // Construct the FULL current phrase (History + Live Interim)
        const fullCurrentString = (transcriptBuffer.current + interimTranscript).trim();

        // Logic Branch: Active Listening vs Passive Waiting
        if (isActiveListeningMode) {
            const wakeWord = (aiSettings.wake_word || 'Cascata').toLowerCase();
            const lowerFull = fullCurrentString.toLowerCase();

            // 1. Check for Wake Word
            if (lowerFull.includes(wakeWord)) {
                // Ensure UI is Open
                setIsOpen(true);

                if (!isWakeWordDetected) {
                    setIsWakeWordDetected(true);
                    playPing();
                }

                // EXTRACT COMMAND: Everything AFTER the wake word
                // We use lastIndexOf to ensure we get the latest command if spoken multiple times
                const splitIndex = lowerFull.lastIndexOf(wakeWord) + wakeWord.length;
                const command = fullCurrentString.substring(splitIndex).trim();
                
                // UPDATE UI: Show only the clean command
                setInput(command);

                // Silence detection to auto-send
                silenceTimer.current = setTimeout(() => {
                    handleSend(undefined, true); // Force send
                    // Reset state for next command
                    setIsWakeWordDetected(false);
                    transcriptBuffer.current = ''; 
                }, 2500); // 2.5s silence triggers send
            } else {
                // Buffer management if no wake word (keep it short)
                if (transcriptBuffer.current.length > 500) {
                    transcriptBuffer.current = transcriptBuffer.current.slice(-200);
                }
            }
        } else {
            // Standard Push-to-Talk Logic: Just show exactly what is heard
            setInput(fullCurrentString);
        }
    };

    recognition.onerror = (e: any) => {
        if (isActiveListeningMode) {
            // Restart if it crashes in always-on mode
            setTimeout(() => { try { recognition.start(); } catch(e){} }, 1000);
        } else {
            setIsListening(false);
        }
    };

    recognition.onend = () => {
        if (isActiveListeningMode) {
            try { recognition.start(); } catch(e){} // Auto-restart
        } else {
            setIsListening(false);
        }
    };

    recognition.start();
    recognitionRef.current = recognition;
    if (!isActiveListeningMode) setIsListening(true);
  };

  const toggleListening = () => {
    if (isActiveListeningMode) {
        // Force stop logic if user manually clicks button in active mode
        setIsWakeWordDetected(!isWakeWordDetected);
        if(!isWakeWordDetected) playPing();
    } else {
        // Standard Toggle
        if (isListening) {
            recognitionRef.current?.stop();
            recognitionRef.current = null;
            setIsListening(false);
        } else {
            transcriptBuffer.current = ''; // Clear buffer on fresh start
            startContinuousListening();
        }
    }
  };

  const handleSend = async (e?: any, force: boolean = false) => {
    if (e) e.preventDefault();
    
    // Get text from ref to ensure we have the latest value inside timeouts
    const textToSend = force ? inputRef.current : input;
    
    if (!textToSend?.trim()) return;
    
    const newMsg = { role: 'user' as const, content: textToSend.trim() };
    setMessages(prev => [...prev, newMsg]);
    setInput('');
    setIsProcessing(true);

    try {
      const token = localStorage.getItem('cascata_token');
      
      const res = await fetch(`/api/data/${projectId}/ai/chat`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}` 
        },
        body: JSON.stringify({
          session_id: sessionId,
          messages: messages.concat(newMsg).map(m => ({ role: m.role, content: m.content })),
          config: {} 
        })
      });

      const data = await res.json();
      
      if (data.choices && data.choices[0]) {
        const content = data.choices[0].message.content;
        
        let type: 'text' | 'sql' | 'json' = 'text';
        let actionData = null;

        if (content.includes('```sql')) type = 'sql';
        if (content.includes('"action": "create_table"')) {
            type = 'json';
            actionData = extractJSON(content);
        }
        
        setMessages(prev => [...prev, { role: 'assistant', content, type, actionData }]);
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: "Desculpe, não consegui processar a resposta." }]);
      }

    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: "Erro de conexão com o cérebro da IA." }]);
    } finally {
      setIsProcessing(false);
    }
  };

  const executeSQL = async (sql: string) => {
    const cleanSql = sql.replace(/```sql/g, '').replace(/```/g, '').trim();
    if (!confirm("Executar este SQL no banco de dados?")) return;

    try {
      const token = localStorage.getItem('cascata_token');
      await fetch(`/api/data/${projectId}/query`, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ sql: cleanSql })
      });
      alert("Comando executado com sucesso!");
    } catch (e) {
      alert("Erro na execução.");
    }
  };

  const executeJSONAction = async (data: any) => {
      if (data.action === 'create_table') {
          try {
              const token = localStorage.getItem('cascata_token');
              await fetch(`/api/data/${projectId}/tables`, {
                  method: 'POST',
                  headers: { 
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${token}`
                  },
                  body: JSON.stringify({
                      name: data.name,
                      description: data.description,
                      columns: data.columns.map((c: any) => ({
                          name: c.name,
                          type: c.type,
                          primaryKey: c.isPrimaryKey,
                          description: c.description
                      }))
                  })
              });
              alert(`Tabela ${data.name} criada com sucesso!`);
          } catch(e) {
              alert("Erro ao criar tabela.");
          }
      }
  };

  // Simple Markdown Renderer to clean up bold/code syntax
  const renderMarkdown = (text: string) => {
      const lines = text.split('\n');
      return lines.map((line, idx) => {
          // Bold **text**
          let processed = line.split(/(\*\*.*?\*\*)/g).map((part, i) => {
              if (part.startsWith('**') && part.endsWith('**')) {
                  return <strong key={i}>{part.slice(2, -2)}</strong>;
              }
              // Inline Code `text`
              return part.split(/(`.*?`)/g).map((subPart, j) => {
                  if (subPart.startsWith('`') && subPart.endsWith('`')) {
                      return <code key={`${i}-${j}`} className="bg-slate-200 px-1 py-0.5 rounded text-indigo-700 font-mono text-[10px]">{subPart.slice(1, -1)}</code>;
                  }
                  return subPart;
              });
          });

          // List Items
          if (line.trim().startsWith('- ')) {
              return <li key={idx} className="ml-4 list-disc marker:text-indigo-400">{processed}</li>;
          }
          if (line.trim() === '') return <br key={idx} />;
          
          return <p key={idx} className="mb-1">{processed}</p>;
      });
  };

  if (!isOpen) {
    return (
      <button 
        onClick={() => setIsOpen(true)}
        className={`fixed bottom-8 right-8 w-16 h-16 rounded-full shadow-2xl flex items-center justify-center hover:scale-110 transition-transform z-[100] group ${isWakeWordDetected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-900 text-white'}`}
      >
        {isWakeWordDetected ? <Mic size={24} className="text-white"/> : <Sparkles size={24} className="group-hover:animate-spin" />}
      </button>
    );
  }

  return (
    <div 
      className="fixed bottom-8 right-8 bg-white rounded-[2rem] shadow-2xl border border-slate-200 flex flex-col z-[100] animate-in slide-in-from-bottom-10 fade-in duration-300 overflow-hidden font-sans"
      style={{ width: dimensions.width, height: dimensions.height }}
    >
      {/* Resize Handle (Top-Left Corner for bottom-right alignment) */}
      <div 
        onMouseDown={(e) => { e.stopPropagation(); setIsResizing(true); }}
        className="absolute top-0 left-0 w-6 h-6 cursor-nwse-resize z-50 flex items-center justify-center group"
      >
          <div className="w-2 h-2 bg-slate-300 rounded-full group-hover:bg-indigo-500 transition-colors"></div>
      </div>

      {/* Header */}
      <div 
        className={`p-6 text-white flex justify-between items-center transition-colors ${isWakeWordDetected ? 'bg-emerald-600' : 'bg-slate-900'}`}
        onDoubleClick={() => setIsResizing(false)} // Reset if needed, or simple prevention
      >
        <div className="flex items-center gap-3 select-none">
          <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center shadow-lg backdrop-blur-sm">
            {isWakeWordDetected ? <Volume2 size={20} className="animate-pulse"/> : <Sparkles size={20} />}
          </div>
          <div>
            <h3 className="font-black text-lg tracking-tight">Architect</h3>
            <p className="text-[10px] font-medium opacity-80 uppercase tracking-widest">{isWakeWordDetected ? 'Listening to Command...' : 'AI Context Aware'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
            <button 
                onClick={() => setDimensions({ width: 400, height: 600 })} 
                className="p-2 hover:bg-white/10 rounded-full transition-colors text-white/50 hover:text-white"
                title="Reset Size"
            >
                <Maximize2 size={14}/>
            </button>
            <button onClick={() => setIsOpen(false)} className="p-2 hover:bg-white/10 rounded-full transition-colors"><X size={20}/></button>
        </div>
      </div>

      {/* Chat Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50">
        {messages.length === 0 && (
          <div className="text-center mt-20 opacity-50">
            <Sparkles size={48} className="mx-auto text-indigo-300 mb-4" />
            <p className="text-sm font-bold text-slate-400">Como posso ajudar a construir hoje?</p>
            {aiSettings.active_listening && <p className="text-[10px] text-emerald-500 font-bold mt-4 uppercase tracking-widest">Listening for "{aiSettings.wake_word}"</p>}
          </div>
        )}
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[90%] rounded-2xl p-4 text-sm shadow-sm ${msg.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-700'}`}>
              {(!msg.type || msg.type === 'text') && (
                  <div className="whitespace-pre-wrap leading-relaxed">
                      {msg.role === 'assistant' ? renderMarkdown(msg.content) : msg.content}
                  </div>
              )}
              
              {msg.type === 'sql' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-slate-400">
                    <span className="flex items-center gap-2"><Terminal size={12}/> Sugestão SQL</span>
                    <button 
                        onClick={() => {
                            navigator.clipboard.writeText(msg.content.replace(/```(sql|json)?/g, '').replace(/```/g, ''));
                            alert("SQL Copiado!");
                        }}
                        className="hover:text-indigo-600 transition-colors"
                        title="Copiar SQL"
                    >
                        <Copy size={12} />
                    </button>
                  </div>
                  <pre className="bg-slate-900 text-emerald-400 p-3 rounded-xl overflow-x-auto font-mono text-xs">
                    {msg.content.replace(/```(sql|json)?/g, '').replace(/```/g, '')}
                  </pre>
                  <button 
                    onClick={() => executeSQL(msg.content)}
                    className="w-full py-2 bg-emerald-50 text-emerald-600 font-bold text-xs rounded-lg hover:bg-emerald-100 flex items-center justify-center gap-2 transition-colors border border-emerald-100"
                  >
                    <Play size={12}/> Executar Agora
                  </button>
                </div>
              )}

              {msg.type === 'json' && msg.actionData && (
                  <div className="space-y-3">
                      <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-indigo-500">
                        <Database size={12}/> {msg.actionData.action.replace('_', ' ')}
                      </div>
                      <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                          <h4 className="font-bold text-slate-900">{msg.actionData.name}</h4>
                          <p className="text-xs text-slate-500 mb-2">{msg.actionData.description}</p>
                          <div className="space-y-1">
                              {msg.actionData.columns.map((c: any) => (
                                  <div key={c.name} className="flex justify-between text-xs bg-white p-2 rounded border border-slate-100">
                                      <span className="font-mono font-bold">{c.name}</span>
                                      <span className="text-slate-400">{c.type}</span>
                                  </div>
                              ))}
                          </div>
                      </div>
                      <button 
                        onClick={() => executeJSONAction(msg.actionData)}
                        className="w-full py-2 bg-indigo-600 text-white font-bold text-xs rounded-lg hover:bg-indigo-700 flex items-center justify-center gap-2 transition-colors shadow-lg shadow-indigo-100"
                      >
                        <Check size={14}/> Approve & Build
                      </button>
                  </div>
              )}
            </div>
          </div>
        ))}
        {isProcessing && (
          <div className="flex justify-start">
            <div className="bg-white border border-slate-200 rounded-2xl p-4 flex gap-2 items-center">
              <div className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce"></div>
              <div className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce delay-75"></div>
              <div className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce delay-150"></div>
            </div>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="p-4 bg-white border-t border-slate-100">
        <div className="relative flex items-center gap-2">
          <input 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder={isWakeWordDetected ? "Ouvindo comando..." : "Digite ou fale..."} 
            className={`w-full border-none rounded-2xl py-4 pl-6 pr-12 text-sm font-medium outline-none focus:ring-2 transition-all ${isWakeWordDetected ? 'bg-emerald-50 focus:ring-emerald-500/20' : 'bg-slate-50 focus:ring-indigo-500/20'}`}
          />
          <div className="absolute right-2 flex items-center gap-1">
            <button 
              onClick={toggleListening}
              className={`p-2 rounded-xl transition-all ${isWakeWordDetected || isListening ? 'bg-rose-500 text-white animate-pulse shadow-lg shadow-rose-500/40' : 'text-slate-400 hover:text-indigo-600 hover:bg-slate-100'}`}
            >
              {(isListening || isWakeWordDetected) ? (
                  <span className="relative flex h-4 w-4">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-200 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-4 w-4 bg-white/20 items-center justify-center"><MicOff size={12}/></span>
                  </span>
              ) : <Mic size={18}/>}
            </button>
            <button 
              id="ai-architect-send"
              onClick={(e) => handleSend(e)}
              disabled={!input.trim() || isProcessing}
              className="p-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all disabled:opacity-50"
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CascataArchitect;
