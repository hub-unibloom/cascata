
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
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { validateTargetUrl, isPrivateIP } from '../src/utils/index.js';
import { systemPool } from '../src/config/main.js';
import process from 'process';

const MAX_CACHE_SIZE = 500; 
const MAX_MODULE_SIZE = 1024 * 1024 * 5; 
const moduleCache = new Map<string, string>(); 
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
    
    private static async fetchModuleSource(specifier: string): Promise<string> {
        let url = specifier;
        if (!specifier.startsWith('http://') && !specifier.startsWith('https://') && !specifier.startsWith('.')) {
            url = `https://esm.sh/${specifier}?target=deno`;
        }
        if (moduleCache.has(url)) return moduleCache.get(url)!;
        const urlHash = crypto.createHash('md5').update(url).digest('hex');
        const cacheFilePath = path.join(CACHE_ROOT, `${urlHash}.js`);
        if (fs.existsSync(cacheFilePath)) {
            try {
                const cachedSource = fs.readFileSync(cacheFilePath, 'utf-8');
                addToCache(url, cachedSource);
                return cachedSource;
            } catch(e) {}
        }
        await validateTargetUrl(url);
        try {
            const res = await axios.get(url, { responseType: 'text', timeout: 5000, maxContentLength: MAX_MODULE_SIZE });
            const source = res.data;
            addToCache(url, source);
            try { fs.writeFileSync(cacheFilePath, source); } catch(e) {}
            return source;
        } catch (e: any) {
            throw new Error(`Dependency Error: Could not resolve '${specifier}'. ${e.message}`);
        }
    }

    public static async execute(code: string, context: any, envVars: Record<string, string>, projectPool: Pool, timeoutMs: number = 5000, projectSlug: string): Promise<{ status: number, body: any }> {
        const isolate = new ivm.Isolate({ memoryLimit: 256 }); 
        const scriptContext = await isolate.createContext();
        const jail = scriptContext.global;
        
        try {
            await jail.set('global', jail.derefInto());
            const user = context.user || {};
            const userRole = user.role || (user.sub ? 'authenticated' : 'anon');
            const safeLog = (type: string, ...args: any[]) => {
                const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
                const truncated = msg.length > 2000 ? msg.substring(0, 2000) + '...' : msg;
                if (type === 'log') console.log(`[EDGE:${projectSlug}]`, truncated);
                else console.error(`[EDGE:${projectSlug}]`, truncated);
            };
            await jail.set('console', new ivm.Reference({
                log: new ivm.Callback((...args: any[]) => safeLog('log', ...args)),
                error: new ivm.Callback((...args: any[]) => safeLog('error', ...args)),
                warn: new ivm.Callback((...args: any[]) => safeLog('log', ...args))
            }));
            const projectRes = await systemPool.query('SELECT metadata FROM system.projects WHERE slug = $1', [projectSlug]);
            const metadata = projectRes.rows[0]?.metadata || {};
            const timezone = metadata.timezone || 'UTC';
            const governance = metadata.ai_governance || {};
            const isReadOnly = governance.mode === 'read_only';
            const enhancedEnv = { ...envVars, TZ: timezone };
            await jail.set('env', new ivm.ExternalCopy(enhancedEnv).copyInto());
            await jail.set('_crypto_proxy', new ivm.Reference({
                randomUUID: () => crypto.randomUUID(),
                randomBytes: (size: number) => { const buf = crypto.randomBytes(size); return new ivm.ExternalCopy(buf.toString('hex')).copyInto(); }
            }));
            await jail.set('_encoding_proxy', new ivm.Reference({
                btoa: (str: string) => Buffer.from(str).toString('base64'),
                atob: (str: string) => Buffer.from(str, 'base64').toString('binary'),
                fromHex: (hex: string) => new ivm.ExternalCopy(Buffer.from(hex, 'hex')).copyInto(),
                toHex: (str: string) => Buffer.from(str).toString('hex')
            }));
            await jail.set('_cascata_utils', new ivm.Reference({
                bcryptHash: async (plain: string) => { const hash = await bcrypt.hash(plain, 10); return new ivm.ExternalCopy(hash).copyInto(); },
                bcryptCompare: async (plain: string, hash: string) => { const match = await bcrypt.compare(plain, hash); return new ivm.ExternalCopy(match).copyInto(); },
                jwtSign: (payload: any, secret: string, options: any) => { const opts = { expiresIn: '1h', ...options }; const token = jwt.sign(payload, secret, opts); return new ivm.ExternalCopy(token).copyInto(); },
                jwtVerify: (token: string, secret: string) => { try { const decoded = jwt.verify(token, secret); return new ivm.ExternalCopy(decoded).copyInto(); } catch(e) { return new ivm.ExternalCopy(null).copyInto(); } }
            }));
            await jail.set('db', new ivm.Reference({
                query: new ivm.Reference(async (sql: string, params: any[]) => {
                    let client;
                    try {
                        client = await projectPool.connect();
                        await client.query('BEGIN');
                        if (isReadOnly) await client.query('SET TRANSACTION READ ONLY');
                        await client.query(`SET LOCAL ROLE cascata_api_role`);
                        const claims = { 'request.jwt.claim.sub': user.sub || '', 'request.jwt.claim.role': userRole, 'request.jwt.claim.email': user.email || '' };
                        for (const [key, value] of Object.entries(claims)) { if (value) await client.query(`SELECT set_config($1, $2, true)`, [key, String(value)]); }
                        await client.query(`SET TIME ZONE '${timezone}'`);
                        await client.query(`SET statement_timeout = 5000`); 
                        const result = await client.query(sql, params);
                        await client.query('COMMIT');
                        return new ivm.ExternalCopy(JSON.parse(JSON.stringify(result.rows))).copyInto();
                    } catch (e: any) { 
                        if (client) await client.query('ROLLBACK').catch(() => {});
                        throw e; 
                    } finally { if (client) client.release(); }
                })
            }));
            const safeLookup = (hostname: string, options: any, callback: any) => {
                dns.lookup(hostname, options, (err, address, family) => {
                    if (err) return callback(err, address, family);
                    if (typeof address === 'string' && isPrivateIP(address)) return callback(new Error(`DNS Block: ${hostname}`), address, family);
                    callback(null, address, family);
                });
            };
            const httpAgent = new HttpAgent({ lookup: safeLookup });
            const httpsAgent = new HttpsAgent({ lookup: safeLookup });
            await jail.set('fetch', new ivm.Reference(async (url: string, initStr: any) => {
                let init = {}; try { init = initStr ? JSON.parse(initStr) : {}; } catch(e) {}
                await validateTargetUrl(url); 
                const response = await axios.request({ url, method: (init as any).method || 'GET', headers: (init as any).headers || {}, data: (init as any).body, maxRedirects: 3, validateStatus: () => true, httpAgent, httpsAgent, responseType: 'arraybuffer', timeout: 4000 });
                const headers: Record<string, string> = {};
                Object.keys(response.headers).forEach(k => { const val = response.headers[k]; if (val) headers[k] = String(val); });
                return new ivm.ExternalCopy({ status: response.status, statusText: response.statusText, headers, text: response.data.toString('utf-8') }).copyInto();
            }));

            const polyfills = `
                global.process = { env: env };
                global.Cascata = { auth: { hashPassword: async (p) => _cascata_utils.apply(undefined, ['bcryptHash', p], { result: { promise: true, copy: true } }), verifyPassword: async (p, h) => _cascata_utils.apply(undefined, ['bcryptCompare', p, h], { result: { promise: true, copy: true } }), signToken: (p, s, o) => _cascata_utils.applySync(undefined, ['jwtSign', p, s, o], { result: { copy: true } }), verifyToken: (t, s) => _cascata_utils.applySync(undefined, ['jwtVerify', t, s], { result: { copy: true } }) } };
                global.crypto = { randomUUID: () => _crypto_proxy.applySync(undefined, [], { result: { copy: true } }), randomBytes: (size) => _crypto_proxy.applySync(undefined, ['randomBytes', size], { result: { copy: true } }) };
                global.btoa = (s) => _encoding_proxy.applySync(undefined, ['btoa', s], { result: { copy: true } });
                global.atob = (s) => _encoding_proxy.applySync(undefined, ['atob', s], { result: { copy: true } });
                global.TextEncoder = class TextEncoder { encode(str) { return new Uint8Array(Buffer.from(str)); } };
                global.TextDecoder = class TextDecoder { decode(arr) { return Buffer.from(arr).toString('utf-8'); } };
                global.Buffer = { from: (data, enc) => { if (typeof data === 'string' && enc === 'hex') { return _encoding_proxy.applySync(undefined, ['fromHex', data], { result: { copy: true } }); } return data; } };
                global.$db = { query: async (sql, params) => db.get('query').apply(undefined, [sql, params || []], { arguments: { copy: true }, result: { promise: true } }) };
                global.$fetch = async (url, init) => { const initStr = init ? JSON.stringify(init) : undefined; const res = await fetch.apply(undefined, [url, initStr], { arguments: { copy: true }, result: { promise: true } }); return { status: res.status, headers: res.headers, text: async () => res.text, json: async () => JSON.parse(res.text) }; };
            `;
            await isolate.compileScript(polyfills).then(s => s.run(scriptContext));
            const module = await isolate.compileModule(code);
            await module.instantiate(scriptContext, async (specifier) => {
                const source = await EdgeService.fetchModuleSource(specifier);
                return await isolate.compileModule(source);
            });
            await module.evaluate({ timeout: timeoutMs });
            const namespace = module.namespace;
            const defaultExport = await namespace.get('default', { reference: true });
            if (defaultExport.typeof !== 'function') return { status: 500, body: { error: "Edge Function must export a default function." } };
            const reqCopy = new ivm.ExternalCopy(context).copyInto();
            const resultRef = await defaultExport.apply(undefined, [reqCopy], { result: { promise: true, copy: true } });
            return { status: 200, body: resultRef };
        } catch (e: any) {
            console.error(`[Edge:${projectSlug}] Execution Error:`, e.message);
            if (e.message.includes('isolate is disposed') || e.message.includes('timeout')) return { status: 504, body: { error: `Execution Timed Out (${timeoutMs}ms limit)` } };
            return { status: 500, body: { error: `Runtime Error: ${e.message.replace(/\/app\/backend\/services\//g, '[System]')}` } };
        } finally { try { scriptContext.release(); if (!isolate.isDisposed) isolate.dispose(); } catch(cleanupErr) {} }
    }
}
