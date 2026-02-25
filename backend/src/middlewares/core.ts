
import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { CascataRequest } from '../types.js';
import { systemPool, SYS_SECRET } from '../config/main.js';
import { PoolService } from '../../services/PoolService.js';
import { RateLimitService } from '../../services/RateLimitService.js';

/**
 * CORE MIDDLEWARE: Project Resolver & Context Initializer
 * This is the entry point for all API requests. It determines:
 * 1. Environment (Live vs Draft)
 * 2. System Authentication (Admin)
 * 3. Project Context (Database Connection)
 * 4. Security Policies (Blocklist, Panic Mode)
 */
export const resolveProject: RequestHandler = async (req: any, res: any, next: any) => {
    // 0. Fast Exit for Health Checks to reduce overhead
    if (req.path === '/' || req.path === '/health') return next();

    const r = req as CascataRequest;
    const host = req.headers.host || '';

    // --- 1. ENVIRONMENT ROUTING LOGIC ---
    // Default is 'live'. We only switch context if '/draft/' is explicitly in the URL path segment.
    let targetEnv = 'live';
    let slugFromUrl = null;

    // Clean parsing of URL segments
    // Expected structure: ['', 'api', 'data', 'slug', 'optional_env_or_resource', ...]
    const pathParts = req.path.split('/');

    if (pathParts.length > 3 && pathParts[1] === 'api' && pathParts[2] === 'data') {
        slugFromUrl = pathParts[3];

        // Strict check: only switch if the segment is exactly 'draft'
        if (pathParts[4] === 'draft') {
            targetEnv = 'draft';

            // CRITICAL: Rewrite URL for downstream Express routers.
            // We remove the '/draft' segment so routes defined as '/tables/:name' match correctly.
            // Using replace on the specific string ensures we don't break query params.
            req.url = req.url.replace('/draft', '');
            req.path = req.path.replace('/draft', '');
        }
        // Implicitly 'live' otherwise. We do not strip other segments.
    }

    // Fallback: Check Header (useful for internal proxying or specific client overrides)
    if (req.headers['x-cascata-env']) {
        targetEnv = req.headers['x-cascata-env'] === 'draft' ? 'draft' : 'live';
    }

    // --- 2. SYSTEM AUTHENTICATION (ADMIN) ---
    // Must happen BEFORE any control plane exit logic.
    // We check for admin tokens to enable "God Mode" capabilities.

    let adminToken: string | null = null;
    let projectToken: string | null = null;

    // Extract from Cookies (Dashboard)
    if (req.headers.cookie) {
        const adminMatch = req.headers.cookie.match(/admin_token=([^;]+)/);
        if (adminMatch) adminToken = adminMatch[1];

        const projMatch = req.headers.cookie.match(/cascata_access_token=([^;]+)/);
        if (projMatch) projectToken = projMatch[1];
    }

    // Extract from Headers (API/CLI)
    const authHeader = req.headers['authorization'];
    let bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : (req.query.token as string);

    r.isSystemRequest = false;

    // Validation Loop: Check if any provided token is a valid System Admin Token
    const systemCandidates = [];
    if (bearerToken) systemCandidates.push(bearerToken);
    if (adminToken) systemCandidates.push(adminToken);

    for (const token of systemCandidates) {
        try {
            const isBlacklisted = await RateLimitService.isTokenBlacklisted(token);
            if (!isBlacklisted && process.env.SYSTEM_JWT_SECRET) {
                jwt.verify(token, process.env.SYSTEM_JWT_SECRET, { algorithms: ['HS256'] });
                r.isSystemRequest = true; // VALID ADMIN DETECTED
                break;
            }
        } catch { }
    }

    // --- 3. PROPOSED CONTROL PLANE BYPASS REMOVED ---
    // Previously, we bypassed project resolution for /api/control/ routes here.
    // However, this caused hostGuard to aggressively 404 Custom Domains trying to hit 
    // root APIs because req.project was never set. Now we resolve it, and let 
    // cascataAuth handle proper 401 blocking.

    // --- 4. PROJECT RESOLUTION (DATA PLANE) ---

    // Determine which token to use for Row Level Security (RLS) downstream.
    if (!bearerToken) {
        if (projectToken) bearerToken = projectToken;
        else if (adminToken) bearerToken = adminToken; // Admin impersonating/debugging
    }

    // Ensure downstream middlewares (cascataAuth) see the chosen token
    if (bearerToken && !req.headers['authorization']) {
        req.headers['authorization'] = `Bearer ${bearerToken}`;
    }

    try {
        let projectResult: pg.QueryResult | undefined;
        let resolutionMethod = 'unknown';

        const projectQuery = `
        SELECT 
            id, name, slug, db_name, custom_domain, ssl_certificate_source, blocklist, metadata, status,
            pgp_sym_decrypt(jwt_secret::bytea, $1::text) as jwt_secret,
            pgp_sym_decrypt(anon_key::bytea, $1::text) as anon_key,
            pgp_sym_decrypt(service_key::bytea, $1::text) as service_key
        FROM system.projects 
    `;

        // Strategy A: Domain Resolution (Custom Domains)
        if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
            projectResult = await systemPool.query(`${projectQuery} WHERE custom_domain = $2`, [SYS_SECRET, host]);
            if ((projectResult.rowCount ?? 0) > 0) resolutionMethod = 'domain';
        }

        // Strategy B: Slug Resolution (Path based)
        if ((!projectResult || (projectResult.rowCount ?? 0) === 0) && slugFromUrl) {
            projectResult = await systemPool.query(`${projectQuery} WHERE slug = $2`, [SYS_SECRET, slugFromUrl]);
            if ((projectResult.rowCount ?? 0) > 0) resolutionMethod = 'slug';
        }

        if (!projectResult || !projectResult.rows[0]) {
            // If it looks like a data API call but no project found, 404 immediately to save resources
            if (req.originalUrl.includes('/api/data/')) {
                res.status(404).json({ error: 'Project Context Not Found (404)' });
                return;
            }
            return next();
        }

        const project = projectResult.rows[0];

        // --- 5. SECURITY GATES ---

        // Panic Mode (Lockdown) - Skip for Admins
        if (!r.isSystemRequest && targetEnv === 'live') {
            const isPanic = await RateLimitService.checkPanic(project.slug);
            if (isPanic) {
                res.status(503).json({ error: 'System is currently in Panic Mode (Locked Down).' });
                return;
            }
        }

        // Domain Locking Policy (Prevent accessing Prod via generic URL if Custom Domain exists)
        if (project.custom_domain && resolutionMethod === 'slug' && targetEnv === 'live') {
            const isDev = host.includes('localhost') || host.includes('127.0.0.1');
            if (!isDev && !r.isSystemRequest) {
                res.status(403).json({ error: 'Domain Locking Policy Active.', hint: `Use https://${project.custom_domain}` });
                return;
            }
        }

        // Firewall (Blocklist)
        const forwarded = req.headers['x-forwarded-for'];
        const realIp = req.headers['x-real-ip'];
        const socketIp = req.socket?.remoteAddress;
        let clientIp = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
        clientIp = clientIp.replace('::ffff:', '');

        if (project.blocklist && project.blocklist.includes(clientIp)) {
            res.status(403).json({ error: 'Firewall: Access Denied' });
            return;
        }

        r.project = project;

        // --- 6. DATABASE CONNECTION STRATEGY ---
        try {
            const dbConfig = project.metadata?.db_config || {};
            let targetConnectionString: string | undefined = undefined;

            // External DB Logic (BYOD)
            if (project.metadata?.external_db_url) {
                targetConnectionString = project.metadata.external_db_url;
            }
            // Read Replica Logic (Scaling)
            if (targetEnv === 'live' && req.method === 'GET' && project.metadata?.read_replica_url) {
                targetConnectionString = project.metadata.read_replica_url;
            }

            // Live vs Draft Routing
            let targetDbName = project.db_name;

            if (targetEnv === 'draft') {
                if (project.metadata?.external_db_url) {
                    // Drafts on external DBs require schema suffixing or separate DBs (not auto-managed)
                    // Current behavior: Fail safely if not configured
                } else {
                    targetDbName = `${project.db_name}_draft`;
                }
            }

            // Initialize or Retrieve Pool
            r.projectPool = PoolService.get(targetDbName, {
                max: dbConfig.max_connections,
                idleTimeoutMillis: dbConfig.idle_timeout_seconds ? dbConfig.idle_timeout_seconds * 1000 : undefined,
                connectionString: targetConnectionString
            });

        } catch (err: any) {
            if (targetEnv === 'draft') {
                // Specific error to help frontend UI detect missing draft env
                res.status(404).json({ error: 'Draft Environment Not Initialized', code: 'DRAFT_MISSING' });
                return;
            }
            console.error(`[ProjectResolution] DB Connect Error:`, err);
            res.status(502).json({ error: 'Database Connection Failed' });
            return;
        }

        next();
    } catch (e) {
        console.error("[Resolution] Internal Error", e);
        res.status(500).json({ error: 'Internal Resolution Error' });
    }
};

/**
 * AUTH MIDDLEWARE: Role Assignment & Token Verification
 * Handles hierarchy: Admin > Service Key > Anon Key > User Token
 */
export const cascataAuth: RequestHandler = async (req: any, res: any, next: any) => {
    const r = req as CascataRequest;

    // 1. SYSTEM ADMIN / DASHBOARD ACCESS
    // If the request was identified as a System Request in resolveProject,
    // we immediately grant full 'service_role' privileges.
    if (r.isSystemRequest) {
        r.userRole = 'service_role';
        return next();
    }

    // 2. PROJECT DATA ACCESS
    if (r.project) {
        const authHeader = req.headers['authorization'];
        // Support both Bearer token and 'apikey' header
        const apiKey = req.headers['apikey'] || (authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : req.query.token);

        if (apiKey) {
            // A. Service Key (Root Access)
            if (apiKey === r.project.service_key) {
                r.userRole = 'service_role';
                return next();
            }
            // B. Anon Key (Public Access)
            if (apiKey === r.project.anon_key) {
                r.userRole = 'anon';
                return next();
            }

            // C. User JWT (RLS Access)
            try {
                // Check blacklist/revocation first
                const isBlacklisted = await RateLimitService.isTokenBlacklisted(apiKey as string);
                if (isBlacklisted) return res.status(401).json({ error: 'Token Revoked' });

                // Verify against Project Secret — algorithm pinned to HS256 to prevent 'none' bypass.
                const decoded: any = jwt.verify(apiKey as string, r.project.jwt_secret, { algorithms: ['HS256'] });
                r.user = decoded;
                r.userRole = decoded.role || 'authenticated';
                return next();
            } catch (e) {
                // Invalid tokens fall through to 401
            }
        }
    }

    // 3. FAIL-SAFE: CONTROL PLANE PROTECTION
    // Double check to prevent unauthorized access to control routes if logic slipped through
    if (req.baseUrl.includes('/control')) {
        return res.status(401).json({ error: 'Unauthorized: Admin Access Required' });
    }

    // 4. DEFAULT DENY
    return res.status(401).json({ error: 'Unauthorized' });
};
