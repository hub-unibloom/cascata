
import ivm from 'isolated-vm';
import { Pool } from 'pg';
import crypto from 'crypto';
import { Buffer } from 'buffer';
import axios from 'axios';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import dns from 'dns';
import fs from 'fs';
import path from 'path';
import { validateTargetUrl, isPrivateIP } from '../src/utils/index.js';
import { systemPool } from '../src/config/main.js';

// --- CONFIG ---
const MAX_CACHE_SIZE = 500; 
const MAX_MODULE_SIZE = 1024 * 1024 * 5; // 5MB Limit per module source
const moduleCache = new Map<string, string>(); // Memory L1 Cache

// CACHE ROOT (Filesystem L2 Cache)
const CACHE_ROOT = path.resolve(process.cwd(), 'system_cache', 'deps');
if (!fs.existsSync(CACHE_ROOT)) {
    fs.mkdirSync(CACHE_ROOT, { recursive: true });
}

function addToCache(key: string, value: string) {
    if (moduleCache.size >= MAX_CACHE_SIZE) {
        const firstKey = moduleCache.keys().next().value;
        if (firstKey) moduleCache.delete(firstKey);
    }
    moduleCache.set(key, value);
}

export class EdgeService {
    
    /**
     * Module Resolver: Fetches code from external URLs (e.g. esm.sh) with security and caching.
     */
    private static async fetchModuleSource(specifier: string): Promise<string> {
        // 1. URL Normalization
        let url = specifier;
        if (!specifier.startsWith('http://') && !specifier.startsWith('https://') && !specifier.startsWith('.')) {
            // If not URL or relative, assume NPM package via esm.sh
            url = `https://esm.sh/${specifier}?target=deno`;
        }

        // 2. Check L1 Cache (Memory)
        if (moduleCache.has(url)) {
            return moduleCache.get(url)!;
        }

        // 3. Check L2 Cache (Disk)
        const urlHash = crypto.createHash('md5').update(url).digest('hex');
        const cacheFilePath = path.join(CACHE_ROOT, `${urlHash}.js`);
        
        if (fs.existsSync(cacheFilePath)) {
            try {
                const cachedSource = fs.readFileSync(cacheFilePath, 'utf-8');
                addToCache(url, cachedSource);
                return cachedSource;
            } catch(e) {
                console.warn(`[EdgeService] Cache read failed for ${url}, re-fetching.`);
            }
        }

        // 4. Security Validation (SSRF)
        await validateTargetUrl(url);

        // 5. Fetch
        console.log(`[EdgeService] Resolving dependency: ${url}`);
        try {
            const res = await axios.get(url, { 
                responseType: 'text', 
                timeout: 5000,
                maxContentLength: MAX_MODULE_SIZE
            });
            
            const source = res.data;
            
            // 6. Save to Cache
            addToCache(url, source);
            try { fs.writeFileSync(cacheFilePath, source); } catch(e) {}
            
            return source;
        } catch (e: any) {
            console.error(`[EdgeService] Failed to fetch module ${url}: ${e.message}`);
            throw new Error(`Dependency Error: Could not resolve '${specifier}'. ${e.message}`);
        }
    }

    public static async execute(
        code: string,
        context: any,
        envVars: Record<string, string>,
        projectPool: Pool,
        timeoutMs: number = 5000,
        projectSlug: string 
    ): Promise<{ status: number, body: any }> {
        
        // Increased memory limit for module compilation
        const isolate = new ivm.Isolate({ memoryLimit: 256 }); 
        const scriptContext = await isolate.createContext();
        const jail = scriptContext.global;
        
        try {
            await jail.set('global', jail.derefInto());
            
            // --- GLOBALS INJECTION ---
            
            const safeLog = (type: string, ...args: any[]) => {
                const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
                const truncated = msg.length > 2000 ? msg.substring(0, 2000) + '... [TRUNCATED]' : msg;
                if (type === 'log') console.log(`[EDGE:${projectSlug}]`, truncated);
                else console.error(`[EDGE:${projectSlug}]`, truncated);
            };

            await jail.set('console', new ivm.Reference({
                log: new ivm.Callback((...args: any[]) => safeLog('log', ...args)),
                error: new ivm.Callback((...args: any[]) => safeLog('error', ...args)),
                warn: new ivm.Callback((...args: any[]) => safeLog('log', ...args))
            }));

            const projectRes = await systemPool.query('SELECT metadata FROM system.projects WHERE slug = $1', [projectSlug]);
            const timezone = projectRes.rows[0]?.metadata?.timezone || 'UTC';
            const enhancedEnv = { ...envVars, TZ: timezone };
            await jail.set('env', new ivm.ExternalCopy(enhancedEnv).copyInto());

            // Crypto Proxy
            await jail.set('_crypto_proxy', new ivm.Reference({
                randomUUID: () => crypto.randomUUID(),
                randomBytes: (size: number) => {
                    const buf = crypto.randomBytes(size);
                    return new ivm.ExternalCopy(buf.toString('hex')).copyInto();
                }
            }));

            // Encoding Proxy
            await jail.set('_encoding_proxy', new ivm.Reference({
                btoa: (str: string) => Buffer.from(str).toString('base64'),
                atob: (str: string) => Buffer.from(str, 'base64').toString('binary'),
                fromHex: (hex: string) => new ivm.ExternalCopy(Buffer.from(hex, 'hex')).copyInto(),
                toHex: (str: string) => Buffer.from(str).toString('hex')
            }));

            // Database Proxy
            await jail.set('db', new ivm.Reference({
                query: new ivm.Reference(async (sql: string, params: any[]) => {
                    let client;
                    try {
                        client = await projectPool.connect();
                        await client.query(`SET TIME ZONE '${timezone}'`);
                        await client.query(`SET statement_timeout = 5000`); 
                        const result = await client.query(sql, params);
                        // Deep copy to detach from PG client
                        return new ivm.ExternalCopy(JSON.parse(JSON.stringify(result.rows))).copyInto();
                    } catch (e: any) { throw e; } 
                    finally { if (client) client.release(); }
                })
            }));

            // HTTP Client Proxy (Hardened)
            const safeLookup = (hostname: string, options: any, callback: (err: Error | null, address: string, family: number) => void) => {
                dns.lookup(hostname, options, (err, address, family) => {
                    if (err) return callback(err, address, family);
                    if (typeof address === 'string' && isPrivateIP(address)) {
                        return callback(new Error(`DNS Rebinding Blocked: ${hostname} -> ${address}`), address, family);
                    }
                    callback(null, address, family);
                });
            };
            const httpAgent = new HttpAgent({ lookup: safeLookup });
            const httpsAgent = new HttpsAgent({ lookup: safeLookup });

            await jail.set('fetch', new ivm.Reference(async (url: string, initStr: any) => {
                let init = {};
                try { init = initStr ? JSON.parse(initStr) : {}; } catch(e) {}
                await validateTargetUrl(url); 
                
                const response = await axios.request({
                    url,
                    method: (init as any).method || 'GET',
                    headers: (init as any).headers || {},
                    data: (init as any).body,
                    maxRedirects: 3, 
                    validateStatus: () => true,
                    httpAgent, httpsAgent,
                    responseType: 'arraybuffer', // Handle binary safely
                    timeout: 4000 
                });
                
                if (response.data.length > 5 * 1024 * 1024) throw new Error("Response too large (Max 5MB)");

                const headers: Record<string, string> = {};
                Object.keys(response.headers).forEach(k => {
                    const val = response.headers[k];
                    if (val) headers[k] = String(val);
                });

                return new ivm.ExternalCopy({ 
                    status: response.status, 
                    statusText: response.statusText, 
                    headers, 
                    text: response.data.toString('utf-8') 
                }).copyInto();
            }));

            // --- POLYFILLS SCRIPT ---
            const polyfills = `
                global.process = { env: env };
                global.crypto = {
                    randomUUID: () => _crypto_proxy.applySync(undefined, [], { result: { copy: true } }),
                    randomBytes: (size) => _crypto_proxy.applySync(undefined, ['randomBytes', size], { result: { copy: true } })
                };
                global.btoa = (s) => _encoding_proxy.applySync(undefined, ['btoa', s], { result: { copy: true } });
                global.atob = (s) => _encoding_proxy.applySync(undefined, ['atob', s], { result: { copy: true } });
                global.$db = {
                    query: async (sql, params) => db.get('query').apply(undefined, [sql, params || []], { arguments: { copy: true }, result: { promise: true } })
                };
                global.$fetch = async (url, init) => {
                    const initStr = init ? JSON.stringify(init) : undefined;
                    const res = await fetch.apply(undefined, [url, initStr], { arguments: { copy: true }, result: { promise: true } });
                    return {
                        status: res.status,
                        headers: res.headers,
                        text: async () => res.text,
                        json: async () => JSON.parse(res.text)
                    };
                };
            `;
            
            await isolate.compileScript(polyfills).then(s => s.run(scriptContext));

            // --- MODULE COMPILATION & LINKING (CORE UPGRADE) ---
            
            const module = await isolate.compileModule(code);
            
            // Linker: Resolves imports recursively
            await module.instantiate(scriptContext, async (specifier, referrer) => {
                const source = await EdgeService.fetchModuleSource(specifier);
                return await isolate.compileModule(source);
            });

            await module.evaluate({ timeout: timeoutMs });

            const namespace = module.namespace;
            
            // Support 'export default function...'
            const defaultExport = await namespace.get('default', { reference: true });

            if (defaultExport.typeof !== 'function') {
                return { status: 500, body: { error: "Edge Function must export a default function." } };
            }

            // Prepare Request Context
            const reqCopy = new ivm.ExternalCopy(context).copyInto();
            
            // Execute Default Function
            const resultRef = await defaultExport.apply(undefined, [reqCopy], { result: { promise: true, copy: true } });
            
            return { status: 200, body: resultRef };

        } catch (e: any) {
            console.error(`[Edge:${projectSlug}] Execution Error:`, e.message);
            // Error Sanitization
            const safeError = e.message.replace(/\/app\/backend\/services\//g, '[System]');
            
            if (e.message.includes('isolate is disposed') || e.message.includes('timeout')) {
                 return { status: 504, body: { error: `Execution Timed Out (${timeoutMs}ms limit)` } };
            }
            return { status: 500, body: { error: `Runtime Error: ${safeError}` } };
        } finally {
            try { 
                scriptContext.release(); 
                if (!isolate.isDisposed) isolate.dispose(); 
            } catch(cleanupErr) {}
        }
    }
}
