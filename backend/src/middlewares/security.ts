
import { RequestHandler } from 'express';
import express from 'express';
import { CascataRequest } from '../types.js';
import { systemPool } from '../config/main.js';
import { parseBytes, formatBytes } from '../utils/index.js';
import { RateLimitService } from '../../services/RateLimitService.js';

export const dynamicCors: RequestHandler = (req: any, res: any, next: any) => {
    const origin = req.headers.origin;
    
    // Headers padrão para suportar PostgREST/Supabase Clients
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,apikey,x-cascata-client,Prefer,Range,x-client-info,x-supabase-auth,content-profile,accept-profile,x-supabase-api-version,x-cascata-signature,x-cascata-event');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, X-Total-Count, Link');

    // SECURITY FIX: Removed implicit trust for FlutterFlow/AppSmith.
    // Logic now depends entirely on `req.project` context resolved by the previous middleware.
    
    if (!req.project) {
        // Pre-flight check para rotas do sistema/dashboard (sem projeto associado)
        // Permite acesso se a origem bater com o domínio do sistema configurado (implícito),
        // mas não libera para origens arbitrárias.
        if (req.method === 'OPTIONS') return res.status(200).end();
        return next();
    }

    // 3. Project Security Policy (Carregado do Banco via resolveProject)
    const allowedOrigins = req.project.metadata?.allowed_origins || [];
    const safeOrigins = allowedOrigins.map((o: any) => typeof o === 'string' ? o : o.url);
    
    if (safeOrigins.length === 0) {
        // MODO PÚBLICO (Dev): Permite localhost de forma ESTRITA
        // Regex fixa para evitar 'evil-localhost.com'
        const isLocalhost = /^http:\/\/localhost(:\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
        
        if (isLocalhost) {
             res.setHeader('Access-Control-Allow-Origin', origin);
        }
    } 
    else {
        // MODO ESTRITO (Prod): Verifica Whitelist do Banco
        // FlutterFlow/AppSmith devem ser adicionados explicitamente aqui pelo usuário.
        if (origin && safeOrigins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
        }
    }

    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
};

export const hostGuard: RequestHandler = async (req: any, res: any, next: any) => {
    if (req.project) return next();
    if (req.path === '/' || req.path === '/health') return next();

    try {
        const settingsRes = await systemPool.query(
            "SELECT settings->>'domain' as domain FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'domain_config'"
        );
        const systemDomain = settingsRes.rows[0]?.domain;
        const host = req.headers.host?.split(':')[0] || ''; 

        const isIp = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host); 
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host === 'cascata-backend-control' || host.startsWith('172.') || host.startsWith('10.');

        if (isIp || isLocal) return next();

        if (systemDomain) {
            if (host.toLowerCase() === systemDomain.toLowerCase()) return next();
        } else {
            return next();
        }

        console.warn(`[HostGuard] 404 Stealth Block: ${req.path} via ${host}. System Domain: ${systemDomain || 'None'}`);
        return res.status(404).send('Not Found');

    } catch (e) { next(); }
};

export const controlPlaneFirewall: RequestHandler = async (req: any, res: any, next: any) => {
  if (req.method !== 'OPTIONS' && req.path.startsWith('/api/control/projects/')) {
    const slug = req.path.split('/')[4]; 
    if (slug) {
        const forwarded = req.headers['x-forwarded-for'];
        const realIp = req.headers['x-real-ip'];
        const socketIp = req.socket?.remoteAddress;
        let clientIp = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
        clientIp = clientIp.replace('::ffff:', '');

        if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.startsWith('172.') || clientIp.startsWith('10.')) {
            return next();
        }

        try {
            const result = await systemPool.query('SELECT blocklist FROM system.projects WHERE slug = $1', [slug]);
            if (result.rows.length > 0) {
                const blocklist = result.rows[0].blocklist || [];
                if (blocklist.includes(clientIp)) {
                    res.status(403).json({ error: 'Firewall: Access Denied' });
                    return;
                }
            }
        } catch (e) { }
    }
  }
  next();
};

export const dynamicBodyParser: RequestHandler = (req, res, next) => {
    const SYSTEM_HARD_CAP_BYTES = 50 * 1024 * 1024; 
    let limitStr = '2mb'; 

    const proj = (req as any).project;
    if (proj?.metadata?.security?.max_json_size) {
        limitStr = proj.metadata.security.max_json_size;
    } else if (req.path.includes('/edge/')) {
        limitStr = '10mb'; 
    } else if (req.path.includes('/import/')) {
        limitStr = '10mb'; 
    }

    const requestedBytes = parseBytes(limitStr);
    const safeLimit = Math.min(requestedBytes, SYSTEM_HARD_CAP_BYTES);

    express.json({ limit: safeLimit })(req, res, (err) => {
        if (err) {
            return res.status(413).json({
                error: 'Payload Too Large',
                message: `Request body exceeds the limit of ${formatBytes(safeLimit)}`,
                code: 'PAYLOAD_TOO_LARGE'
            });
        }
        express.urlencoded({ extended: true, limit: safeLimit })(req, res, next);
    });
};

export const dynamicRateLimiter: RequestHandler = async (req: any, res: any, next: any) => {
    if (!req.project) return next();
    
    // 1. IP Extraction
    const forwarded = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    const socketIp = req.socket?.remoteAddress;
    let clientIp = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
    clientIp = clientIp.replace('::ffff:', '');
    if (clientIp === '127.0.0.1' || clientIp === '::1') return next();

    const r = req as CascataRequest;
    
    // 2. Global RPS Tracking (For Dashboard Graph)
    // This feeds the 'Traffic Pulse' chart with real-time data
    await RateLimitService.trackGlobalRPS(r.project.slug);

    // 3. Path Normalization (The Window/Door Fix)
    // Converts /rest/v1/users AND /tables/users/data -> table:users
    let logicalResource = req.path.replace(`/api/data/${r.project.slug}`, '') || '/';
    
    // Detect Resource Type for Logical Matching
    if (logicalResource.includes('/tables/')) {
        const parts = logicalResource.split('/tables/');
        if (parts[1]) {
            const tableName = parts[1].split('/')[0];
            logicalResource = `table:${tableName}`;
        }
    } else if (logicalResource.includes('/rest/v1/')) {
        const parts = logicalResource.split('/rest/v1/');
        if (parts[1]) {
            // Check if RPC call in PostgREST
            if (parts[1].startsWith('rpc/')) {
                const rpcName = parts[1].replace('rpc/', '').split('/')[0];
                logicalResource = `rpc:${rpcName}`;
            } else {
                const tableName = parts[1].split(/[/?]/)[0]; // Handle query params
                logicalResource = `table:${tableName}`;
            }
        }
    } else if (logicalResource.includes('/auth/')) {
        logicalResource = 'auth:*'; // Blanket auth rule matching
    } else if (logicalResource.includes('/rpc/')) {
        const rpcName = logicalResource.replace('/rpc/', '').split('/')[0];
        logicalResource = `rpc:${rpcName}`;
    }

    // 4. Check Limits
    const result = await RateLimitService.check(
        r.project.slug, 
        logicalResource, 
        req.method, 
        r.userRole || 'anon', 
        clientIp, 
        systemPool
    );

    if (result.blocked) {
        res.setHeader('Retry-After', result.retryAfter || 60);
        res.status(429).json({ error: result.customMessage || 'Too Many Requests', retryAfter: result.retryAfter });
        return;
    }
    if (result.limit) {
        res.setHeader('X-RateLimit-Limit', result.limit);
        res.setHeader('X-RateLimit-Remaining', result.remaining || 0);
    }
    next();
};
