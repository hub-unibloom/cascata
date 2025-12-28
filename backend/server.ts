
import express, { Request, RequestHandler, NextFunction } from 'express';
import cors from 'cors';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Buffer } from 'buffer';
import bcrypt from 'bcrypt'; // Added for secure password hashing

// IMPORT SERVICES
import { BackupService } from './services/BackupService.js';
import { ImportService } from './services/ImportService.js';
import { DatabaseService } from './services/DatabaseService.js';
import { AuthService } from './services/AuthService.js';
import { WebhookService } from './services/WebhookService.js';
import { PoolService } from './services/PoolService.js';
import { RateLimitService } from './services/RateLimitService.js';
import { CertificateService } from './services/CertificateService.js';
import { MigrationService } from './services/MigrationService.js';
import { EdgeService } from './services/EdgeService.js';
import { QueueService } from './services/QueueService.js';
import { RealtimeService } from './services/RealtimeService.js';
import { OpenApiService } from './services/OpenApiService.js';
import { AiService } from './services/AiService.js';

dotenv.config();

// --- TYPE EXTENSIONS ---
interface CascataRequest extends Request {
  project?: any;
  projectPool?: pg.Pool;
  user?: any;
  userRole?: 'service_role' | 'authenticated' | 'anon';
  isSystemRequest?: boolean;
  file?: any;
  files?: any;
  body: any;
  params: any;
  query: any;
  path: string;
  method: string;
}

const app = express();

app.use(cors()); 
// JSON Parser limit increased, but Multer will bypass this for multipart
app.use(express.json({ limit: '100mb' }) as any);
app.use(express.urlencoded({ extended: true }) as any);

// --- SECURITY: HARDENING HEADERS ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.removeHeader('X-Powered-By'); 
  next();
});

const { Pool } = pg;
const PORT = process.env.PORT || 3000;
const SYS_SECRET = process.env.SYSTEM_JWT_SECRET || 'insecure_default_secret_please_change';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORAGE_ROOT = path.resolve(__dirname, '../storage');
const MIGRATIONS_ROOT = path.resolve(__dirname, '../migrations');
const NGINX_DYNAMIC_ROOT = '/etc/nginx/conf.d/dynamic';
const TEMP_UPLOAD_ROOT = path.resolve(__dirname, '../temp_uploads');

try {
  if (!fs.existsSync(STORAGE_ROOT)) fs.mkdirSync(STORAGE_ROOT, { recursive: true });
  if (!fs.existsSync(NGINX_DYNAMIC_ROOT)) fs.mkdirSync(NGINX_DYNAMIC_ROOT, { recursive: true });
  if (!fs.existsSync(TEMP_UPLOAD_ROOT)) fs.mkdirSync(TEMP_UPLOAD_ROOT, { recursive: true });
} catch (e) { console.error('[System] Root dir create error:', e); }

// --- MULTER CONFIGURATION (Step 3.2 Fix) ---
// Configured to handle streams correctly before JSON parsing issues
const upload = multer({ 
    dest: path.join(__dirname, '../uploads'),
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB limit per file
        fieldSize: 10 * 1024 * 1024 // 10MB limit for text fields
    }
});

const backupUpload = multer({ 
    dest: TEMP_UPLOAD_ROOT,
    limits: { fileSize: 5 * 1024 * 1024 * 1024 } // 5GB for backups
});

const generateKey = () => crypto.randomBytes(32).toString('hex');

// --- 1. SYSTEM CONTROL PLANE POOL ---
const systemPool = new Pool({ 
  connectionString: process.env.SYSTEM_DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000 
});

systemPool.on('error', (err) => {
    console.error('[SystemPool] Unexpected error on idle client', err);
});

// Initialize Services
RateLimitService.init();
if (process.env.SERVICE_MODE === 'CONTROL_PLANE') {
    QueueService.init(); 
}

// --- UTILS: STORAGE & SECURITY ---

const getSectorForExt = (ext: string): string => {
  const map: Record<string, string[]> = {
    visual: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'avif', 'heic', 'heif'],
    motion: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'm4p', 'amr', 'mid', 'midi', 'opus'],
    docs: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'pages', 'epub', 'mobi', 'azw3'],
    structured: ['csv', 'json', 'xml', 'yaml', 'yml', 'sql', 'xls', 'xlsx', 'ods', 'tsv', 'parquet', 'avro'],
    archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'iso', 'dmg', 'pkg', 'xz', 'zst'],
    exec: ['exe', 'msi', 'bin', 'app', 'deb', 'rpm', 'sh', 'bat', 'cmd', 'vbs', 'ps1'],
    scripts: ['js', 'ts', 'py', 'rb', 'php', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'cs', 'swift', 'kt'],
    config: ['env', 'config', 'ini', 'xml', 'manifest', 'lock', 'gitignore', 'editorconfig', 'toml'],
    telemetry: ['log', 'dump', 'out', 'err', 'crash', 'report', 'audit'],
    messaging: ['eml', 'msg', 'vcf', 'chat', 'ics', 'pbx'],
    ui_assets: ['ttf', 'otf', 'woff', 'woff2', 'eot', 'sketch', 'fig', 'ai', 'psd', 'xd'],
    simulation: ['obj', 'stl', 'fbx', 'dwg', 'dxf', 'dae', 'blend', 'step', 'iges', 'glf', 'gltf', 'glb'],
    backup_sys: ['bak', 'sql', 'snapshot', 'dump', 'db', 'sqlite', 'sqlite3', 'rdb']
  };
  for (const sector in map) {
    if (map[sector].includes(ext)) return sector;
  }
  return 'global';
};

const MAGIC_NUMBERS: Record<string, string[]> = {
    'jpg': ['FFD8FF'],
    'png': ['89504E47'],
    'gif': ['47494638'],
    'pdf': ['25504446'],
    'exe': ['4D5A'], 
    'zip': ['504B0304'],
    'rar': ['52617221'],
    'mp3': ['494433', 'FFF3', 'FFF2'],
    'mp4': ['000000', '66747970'],
};

const validateMagicBytes = (filePath: string, ext: string): boolean => {
    if (['exe', 'sh', 'php', 'pl', 'py', 'rb', 'bat', 'cmd', 'msi', 'vbs'].includes(ext)) {
        return false;
    }
    if (!MAGIC_NUMBERS[ext]) return true;
    try {
        const buffer = Buffer.alloc(4);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, 4, 0);
        fs.closeSync(fd);
        const hex = buffer.toString('hex').toUpperCase();
        return MAGIC_NUMBERS[ext].some(sig => hex.startsWith(sig) || sig.startsWith(hex));
    } catch (e) {
        return false; 
    }
};

const parseBytes = (sizeStr: string): number => {
  if (!sizeStr) return 10 * 1024 * 1024; 
  const match = sizeStr.toString().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
  if (!match) return parseInt(sizeStr) || 0;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  const multipliers: Record<string, number> = { 'B': 1, 'KB': 1024, 'MB': 1024 * 1024, 'GB': 1024 * 1024 * 1024 };
  return Math.floor(num * (multipliers[unit] || 1));
};

const walk = (dir: string, rootPath: string, fileList: any[] = []) => {
  try {
    const files = fs.readdirSync(dir);
    files.forEach((file) => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
      fileList.push({
        name: file,
        type: stat.isDirectory() ? 'folder' : 'file',
        size: stat.size,
        updated_at: stat.mtime.toISOString(),
        path: relativePath
      });
      if (stat.isDirectory()) {
        walk(filePath, rootPath, fileList);
      }
    });
  } catch (e) {
  }
  return fileList;
};

// --- MIDDLEWARES DE INFRAESTRUTURA ---

/**
 * Host Guard (Dashboard Isolation Mode)
 * - Protege o painel administrativo contra acessos via IP ou domínios não autorizados.
 * - Permite "Rescue Routes" (Login, Settings, SSL Check) para evitar lockout acidental.
 * - CORREÇÃO: AllowList expandida para garantir que rotas de infra não sejam bloqueadas.
 */
const hostGuard: RequestHandler = async (req: any, res: any, next: any) => {
    // 1. Always allow Data Plane and Health Checks
    if (req.path === '/' || req.path === '/health' || req.path.startsWith('/api/data/')) {
        return next();
    }

    // 2. Rescue Routes: Always allow these to enable recovery/configuration
    // Isso conserta o erro 404 nas rotas de certificados e projetos
    const allowedPrefixes = [
        '/api/control/auth/login',
        '/api/control/auth/verify',
        '/api/control/system', // Abrange settings, ssl-check, certificates
        '/api/control/projects' // Necessário para listar projetos no dashboard
    ];

    if (allowedPrefixes.some(prefix => req.path.startsWith(prefix))) {
        return next();
    }

    try {
        // 3. Get Configured System Domain
        const settingsRes = await systemPool.query(
            "SELECT settings->>'domain' as domain FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'domain_config'"
        );
        const systemDomain = settingsRes.rows[0]?.domain;

        if (systemDomain) {
            const host = req.headers.host || '';
            const cleanHost = host.split(':')[0]; // Remove port if present
            
            // Allow Localhost/Internal for Docker healthchecks and internal routing
            if (cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost.startsWith('172.') || cleanHost === 'cascata-backend-control') {
                return next();
            }

            // 4. Strict Domain Check
            if (cleanHost.toLowerCase() !== systemDomain.toLowerCase()) {
                console.warn(`[HostGuard] Blocked access to ${req.path} from ${cleanHost}. Expected: ${systemDomain}`);
                // Return 404 to hide the panel existence
                return res.status(404).send('Not Found'); 
            }
        }
    } catch (e) {
        // Fail open safely to avoid crashing entire server on DB glitch
        console.error('[HostGuard] Error checking domain config', e);
    }
    next();
};

const controlPlaneFirewall: RequestHandler = async (req: any, res: any, next: any) => {
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

const resolveProject: RequestHandler = async (req: any, res: any, next: any) => {
  if (req.path.startsWith('/api/control/')) return next();
  if (req.path === '/' || req.path === '/health') return next(); 
  
  const r = req as CascataRequest;
  const host = req.headers.host || '';
  
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : (req.query.token as string);
  r.isSystemRequest = false;
  
  if (bearerToken) {
    try {
      jwt.verify(bearerToken, process.env.SYSTEM_JWT_SECRET || 'fallback_secret');
      r.isSystemRequest = true;
    } catch { }
  }

  const pathParts = req.path.split('/');
  const slugFromUrl = (pathParts.length > 3 && pathParts[1] === 'api' && pathParts[2] === 'data') ? pathParts[3] : null;

  try {
    let projectResult: pg.QueryResult | undefined;
    let resolutionMethod = 'unknown';

    // DECRYPT KEYS ON READ
    const projectQuery = `
        SELECT 
            id, name, slug, db_name, custom_domain, ssl_certificate_source, blocklist, metadata, status,
            pgp_sym_decrypt(jwt_secret::bytea, $2) as jwt_secret,
            pgp_sym_decrypt(anon_key::bytea, $2) as anon_key,
            pgp_sym_decrypt(service_key::bytea, $2) as service_key
        FROM system.projects 
    `;

    if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
      projectResult = await systemPool.query(`${projectQuery} WHERE custom_domain = $1`, [host, SYS_SECRET]);
      if ((projectResult.rowCount ?? 0) > 0) resolutionMethod = 'domain';
    }

    if ((!projectResult || (projectResult.rowCount ?? 0) === 0) && slugFromUrl) {
      projectResult = await systemPool.query(`${projectQuery} WHERE slug = $1`, [slugFromUrl, SYS_SECRET]);
      if ((projectResult.rowCount ?? 0) > 0) resolutionMethod = 'slug';
    }

    if (!projectResult || !projectResult.rows[0]) {
      if (req.path.startsWith('/api/data/')) {
        res.status(404).json({ error: 'Project Context Not Found (404)' });
        return;
      }
      return next(); 
    }

    const project = projectResult.rows[0];

    if (!r.isSystemRequest) {
        const isPanic = await RateLimitService.checkPanic(project.slug);
        if (isPanic) {
            console.warn(`[PanicShield] Blocked request to ${req.url} for project ${project.slug} (REDIS)`);
            res.status(503).json({ error: 'System is currently in Panic Mode (Locked Down). Please contact administrator.' });
            return;
        }
    }

    // Domain Locking Policy (Disabled for Dev/Localhost)
    if (project.custom_domain && resolutionMethod === 'slug') {
      const isDev = host.includes('localhost') || host.includes('127.0.0.1');
      if (!isDev && !r.isSystemRequest) {
        res.status(403).json({ 
          error: 'Domain Locking Policy: This project accepts requests only via its configured custom domain.',
          hint: 'Use the custom domain API endpoint.'
        });
        return;
      }
    }

    if (resolutionMethod === 'domain' && !req.url.startsWith('/api/data/')) {
      req.url = `/api/data/${project.slug}${req.url}`;
    }

    const forwarded = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    const socketIp = req.socket?.remoteAddress;
    let clientIp = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
    clientIp = clientIp.replace('::ffff:', '');
    
    if (project.blocklist && project.blocklist.includes(clientIp)) {
      res.status(403).json({ error: 'Firewall: Access Denied (Blocked Origin)' });
      return;
    }

    r.project = project;

    try {
      r.projectPool = PoolService.get(project.db_name);
    } catch (err) {
      res.status(502).json({ error: 'Database Connection Failed' });
      return;
    }

    next();
  } catch (e) {
    res.status(500).json({ error: 'Internal Resolution Error' });
  }
};

const dynamicRateLimiter: RequestHandler = async (req: any, res: any, next: any) => {
    if (!req.project) return next();
    const forwarded = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    const socketIp = req.socket?.remoteAddress;
    let clientIp = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
    clientIp = clientIp.replace('::ffff:', '');
    if (clientIp === '127.0.0.1' || clientIp === '::1') return next();

    const r = req as CascataRequest;
    const result = await RateLimitService.check(r.project.slug, req.path.replace(`/api/data/${r.project.slug}`, '') || '/', req.method, r.userRole || 'anon', clientIp, systemPool);

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

const cascataAuth: RequestHandler = async (req: any, res: any, next: any) => {
  const r = req as CascataRequest;

  if (req.path.startsWith('/api/control/')) {
    if (req.path.endsWith('/auth/login') || req.path.endsWith('/auth/verify') || req.path.includes('/system/ssl-check')) return next();
    
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        if (req.path.includes('/export') && req.query.token) return next();
        res.status(401).json({ error: 'Missing Admin Token' }); 
        return; 
    }
    try {
      const token = authHeader.split(' ')[1];
      jwt.verify(token, process.env.SYSTEM_JWT_SECRET || 'fallback_secret');
      return next();
    } catch { 
      res.status(401).json({ error: 'Invalid Admin Token' });
      return;
    }
  }

  if (!r.project) { 
      if (req.path === '/' || req.path === '/health') return next();
      res.status(404).json({ error: 'No Project Context' }); 
      return; 
  }

  if (r.isSystemRequest) {
    r.userRole = 'service_role';
    return next();
  }

  const apiKey = (req.headers['apikey'] as string) || (req.query.apikey as string);
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : (req.query.token as string);

  if (apiKey === r.project.service_key || bearerToken === r.project.service_key) {
    r.userRole = 'service_role';
    return next();
  }

  if (bearerToken) {
    try {
      const decoded = jwt.verify(bearerToken, r.project.jwt_secret);
      r.user = decoded;
      r.userRole = 'authenticated';
      return next();
    } catch (e) { /* Fallback to anon */ }
  }

  if (apiKey === r.project.anon_key) {
    r.userRole = 'anon';
    return next();
  }

  if (req.path.includes('/auth/providers/') || req.path.includes('/auth/callback') || req.path.includes('/auth/passwordless/') || req.path.includes('/auth/token/refresh')) {
      r.userRole = 'anon';
      return next();
  }

  if (req.path.includes('/auth/users') || req.path.includes('/auth/token')) {
      r.userRole = 'anon';
      return next();
  }

  if (req.path.includes('/edge/')) {
      r.userRole = 'anon';
      return next();
  }

  res.status(401).json({ error: 'Unauthorized: Invalid API Key or JWT.' });
};

const detectSemanticAction = (method: string, path: string): string | null => {
    if (path.includes('/tables') && method === 'POST' && path.endsWith('/rows')) return 'INSERT_ROWS';
    if (path.includes('/tables') && method === 'POST') return 'CREATE_TABLE';
    if (path.includes('/tables') && method === 'DELETE' && !path.includes('/rows')) return 'DROP_TABLE';
    if (path.includes('/tables') && method === 'DELETE' && path.includes('/rows')) return 'DELETE_ROWS';
    if (path.includes('/tables') && method === 'PUT') return 'UPDATE_ROWS';
    if (path.includes('/auth/token') && !path.includes('refresh')) return 'AUTH_LOGIN';
    if (path.includes('/auth/token/refresh')) return 'AUTH_REFRESH';
    if (path.includes('/auth/callback')) return 'AUTH_CALLBACK'; 
    if (path.includes('/auth/passwordless/start')) return 'AUTH_OTP_REQUEST'; 
    if (path.includes('/auth/passwordless/verify')) return 'AUTH_OTP_VERIFY'; 
    if (path.includes('/auth/users') && method === 'POST') return 'AUTH_REGISTER';
    if (path.includes('/storage') && method === 'POST' && path.includes('/upload')) return 'UPLOAD_FILE';
    if (path.includes('/storage') && method === 'DELETE') return 'DELETE_FILE';
    if (path.includes('/edge/')) return 'EDGE_INVOKE';
    return null;
};

const auditLogger: RequestHandler = (req: any, res: any, next: any) => {
  const start = Date.now();
  const oldJson = res.json;
  const r = req as CascataRequest;

  if (req.path.includes('/realtime')) return next();

  (res as any).json = function(data: any) {
    if (r.project) {
       const duration = Date.now() - start;
       const isUpload = req.headers['content-type']?.includes('multipart/form-data');
       const payload = isUpload ? { type: 'binary_upload' } : req.body;
       const forwarded = req.headers['x-forwarded-for'];
       const realIp = req.headers['x-real-ip'];
       const socketIp = (req as any).socket?.remoteAddress;
       let clientIp = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
       clientIp = clientIp.replace('::ffff:', '');
       const isInternal = req.headers['x-cascata-client'] === 'dashboard' || r.isSystemRequest;
       const semanticAction = detectSemanticAction(req.method, req.path);
       const geoInfo = { is_internal: isInternal, auth_status: res.statusCode >= 400 ? 'SECURITY_ALERT' : 'GRANTED', semantic_action: semanticAction };

       if (res.statusCode === 401 && r.project.metadata?.security?.auto_block_401) {
          const isSafeIp = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.startsWith('172.') || clientIp.startsWith('10.') || clientIp.startsWith('192.168.'); 
          if (!isSafeIp && !r.project.blocklist?.includes(clientIp)) {
             systemPool.query('UPDATE system.projects SET blocklist = array_append(blocklist, $1) WHERE slug = $2', [clientIp, r.project.slug]).catch(err => console.error("Auto-block failed", err));
          }
       }

       systemPool.query(
        `INSERT INTO system.api_logs (project_slug, method, path, status_code, client_ip, duration_ms, user_role, payload, headers, geo_info) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [r.project.slug, req.method, req.path, res.statusCode, clientIp, duration, r.userRole || 'unauthorized', JSON.stringify(payload).substring(0, 2000), JSON.stringify({ referer: req.headers.referer, userAgent: req.headers['user-agent'] }), JSON.stringify(geoInfo)]
       ).catch(() => {});
       
       if (res.statusCode >= 200 && res.statusCode < 300 && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
           let tableName = '*';
           if (req.path.includes('/tables/')) { const parts = req.path.split('/tables/'); if (parts[1]) tableName = parts[1].split('/')[0]; }
           WebhookService.dispatch(r.project.slug, tableName, semanticAction || req.method, payload, systemPool, r.project.jwt_secret);
       }
    }
    return oldJson.apply(res, arguments as any);
  }
  next();
};

const cleanTempUploads = () => {
    const tempDir = process.env.TEMP_UPLOAD_ROOT || path.resolve(__dirname, '../temp_uploads');
    if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(tempDir, file);
            try { if (now - fs.statSync(filePath).mtimeMs > 3600 * 1000) fs.rmSync(filePath, { recursive: true, force: true }); } catch (e) { }
        });
    }
};

const quoteId = (identifier: string) => {
  if (typeof identifier !== 'string') throw new Error("Invalid identifier");
  return `"${identifier.replace(/"/g, '""')}"`;
};

// --- CRITICAL SECURITY: ROLE SWITCHING & RLS ---
const queryWithRLS = async (req: CascataRequest, callback: (client: pg.PoolClient) => Promise<any>) => {
  if (!req.projectPool) throw new Error("Database connection not initialized");
  
  const client = await req.projectPool.connect();
  try {
    if (req.isSystemRequest) {
        // Dashboard/Admin Access: Uses original connection (superuser/admin owner)
        // No role switch needed, allowing DDL (CREATE TABLE) and direct access.
        await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)");
    } else {
        // Public API Access: Force Sandbox
        // Switch to the restricted role that CANNOT create tables or drop objects
        await client.query("SET ROLE cascata_api_role");
        
        // RLS Context
        if (req.userRole === 'service_role') {
            await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)");
        } else if (req.user && req.user.sub) {
            await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [req.user.sub]);
            await client.query("SELECT set_config('request.jwt.claim.role', $1, true)", [req.userRole]);
        } else {
            await client.query("SELECT set_config('request.jwt.claim.role', 'anon', true)");
        }
    }
    const result = await callback(client);
    return result;
  } catch (e) {
    throw e;
  } finally {
    // Reset session before returning to pool
    try { await client.query("RESET ROLE; DISCARD ALL"); } catch(err) { }
    client.release();
  }
};

const waitForDatabase = async (retries = 30, delay = 1000): Promise<boolean> => {
  for (let i = 0; i < retries; i++) {
    try {
      const client = await systemPool.connect();
      client.release();
      console.log('[System] Database connected successfully.');
      return true;
    } catch (err: any) {
      if(i % 5 === 0) console.warn(`[System] Waiting for database... (${i + 1}/${retries})`);
      await new Promise(res => setTimeout(res, delay));
    }
  }
  return false;
};

// APPLY MIDDLEWARES
app.use(hostGuard as any); // FIRST: Check for Dashboard Isolation violations
app.use(resolveProject as any);
app.use(controlPlaneFirewall as any);
app.use(dynamicRateLimiter as any); 
app.use(auditLogger as any); 
app.use(cascataAuth as any);

// Health Check
app.get('/', (req, res) => { res.send('Cascata Engine OK'); });
app.get('/health', (req, res) => { res.json({ status: 'ok', time: new Date() }); });

app.get('/api/data/:slug/realtime', (req, res) => RealtimeService.handleConnection(req, res));

// --- DATA PLANE: TABLES ---

app.get('/api/data/:slug/tables/:tableName/data', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    try {
        const safeTable = quoteId(req.params.tableName);
        const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
        const offset = parseInt(req.query.offset) || 0;
        
        const result = await queryWithRLS(r, async (client) => {
            return await client.query(`SELECT * FROM public.${safeTable} LIMIT $1 OFFSET $2`, [limit, offset]);
        });
        res.json(result.rows);
    } catch (e: any) { next(e); }
});

// Insert
app.post('/api/data/:slug/tables/:tableName/rows', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    try {
        const safeTable = quoteId(req.params.tableName);
        const { data } = req.body;
        if (!data) throw new Error("No data provided");
        
        const rows = Array.isArray(data) ? data : [data];
        if (rows.length === 0) return res.json([]);

        const keys = Object.keys(rows[0]);
        const columns = keys.map(quoteId).join(', ');
        const valuesPlaceholder = rows.map((_, i) => 
            `(${keys.map((_, j) => `$${i * keys.length + j + 1}`).join(', ')})`
        ).join(', ');
        const flatValues = rows.flatMap(row => keys.map(k => row[k]));

        const result = await queryWithRLS(r, async (client) => {
            return await client.query(
                `INSERT INTO public.${safeTable} (${columns}) VALUES ${valuesPlaceholder} RETURNING *`,
                flatValues
            );
        });
        res.status(201).json(result.rows);
    } catch (e: any) { next(e); }
});

// Update
app.put('/api/data/:slug/tables/:tableName/rows', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    try {
        const safeTable = quoteId(req.params.tableName);
        const { data, pkColumn, pkValue } = req.body;
        
        if (!data || !pkColumn || pkValue === undefined) throw new Error("Missing data or PK");

        const updates = Object.keys(data).map((k, i) => `${quoteId(k)} = $${i + 1}`).join(', ');
        const values = Object.values(data);
        const pkValIndex = values.length + 1;

        const result = await queryWithRLS(r, async (client) => {
            return await client.query(
                `UPDATE public.${safeTable} SET ${updates} WHERE ${quoteId(pkColumn)} = $${pkValIndex} RETURNING *`,
                [...values, pkValue]
            );
        });
        res.json(result.rows);
    } catch (e: any) { next(e); }
});

// Delete
app.delete('/api/data/:slug/tables/:tableName/rows', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    try {
        const safeTable = quoteId(req.params.tableName);
        const { ids, pkColumn } = req.body;
        
        if (!ids || !Array.isArray(ids) || !pkColumn) throw new Error("Invalid delete request");

        const result = await queryWithRLS(r, async (client) => {
            return await client.query(
                `DELETE FROM public.${safeTable} WHERE ${quoteId(pkColumn)} = ANY($1) RETURNING *`,
                [ids]
            );
        });
        res.json(result.rows);
    } catch (e: any) { next(e); }
});

// --- DATA PLANE: TABLE MANAGEMENT & METADATA ---

app.get('/api/data/:slug/tables', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    try {
        const result = await queryWithRLS(r, async (client) => {
            return await client.query(`
                SELECT table_name as name, table_schema as schema 
                FROM information_schema.tables 
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
                AND table_name NOT LIKE '_deleted_%'
            `);
        });
        res.json(result.rows);
    } catch (e: any) { next(e); }
});

app.get('/api/data/:slug/tables/:tableName/columns', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    try {
        const result = await queryWithRLS(r, async (client) => {
            return await client.query(`
                SELECT column_name as name, data_type as type, is_nullable, column_default as "defaultValue",
                EXISTS (
                    SELECT 1 FROM information_schema.key_column_usage kcu 
                    WHERE kcu.table_name = $1 AND kcu.column_name = c.column_name
                ) as "isPrimaryKey"
                FROM information_schema.columns c 
                WHERE table_schema = 'public' AND table_name = $1
            `, [req.params.tableName]);
        });
        res.json(result.rows);
    } catch (e: any) { next(e); }
});

// Create Table (Enhanced with Validation)
app.post('/api/data/:slug/tables', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    // Only dashboard/admin can create tables
    if (!r.isSystemRequest) { res.status(403).json({ error: 'Only Dashboard can create tables.' }); return; }

    const { name, columns, description } = req.body;
    if (!name || !columns) { res.status(400).json({ error: 'Missing table def' }); return; }

    try {
        // SECURITY CHECK: Validate Schema & Foreign Keys before executing DDL
        if (r.projectPool) {
            await DatabaseService.validateTableDefinition(r.projectPool, name, columns);
        }

        const safeName = quoteId(name);
        const colDefs = columns.map((c: any) => {
            let def = `${quoteId(c.name)} ${c.type}`;
            if (c.primaryKey) def += ' PRIMARY KEY';
            if (!c.nullable && !c.primaryKey) def += ' NOT NULL';
            if (c.default) def += ` DEFAULT ${c.default}`;
            if (c.isUnique) def += ' UNIQUE';
            if (c.foreignKey) def += ` REFERENCES ${quoteId(c.foreignKey.table)}(${quoteId(c.foreignKey.column)})`;
            return def;
        }).join(', ');

        const sql = `CREATE TABLE public.${safeName} (${colDefs});`;
        
        await r.projectPool!.query(sql);
        await r.projectPool!.query(`ALTER TABLE public.${safeName} ENABLE ROW LEVEL SECURITY`);
        
        // Add trigger
        await r.projectPool!.query(`
            CREATE TRIGGER ${name}_changes
            AFTER INSERT OR UPDATE OR DELETE ON public.${safeName}
            FOR EACH ROW EXECUTE FUNCTION public.notify_changes();
        `);

        if (description) {
            await r.projectPool!.query(`COMMENT ON TABLE public.${safeName} IS $1`, [description]);
        }

        res.json({ success: true });
    } catch (e: any) { next(e); }
});

app.delete('/api/data/:slug/tables/:table', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  if (!r.isSystemRequest) { res.status(403).json({ error: 'Only Dashboard can delete tables.' }); return; }
  const { mode } = req.body;
  try {
    if (mode === 'CASCADE' || mode === 'RESTRICT') {
        const cascadeSql = mode === 'CASCADE' ? 'CASCADE' : '';
        await r.projectPool!.query(`DROP TABLE public.${quoteId(req.params.table)} ${cascadeSql}`);
    } else {
        const deletedName = `_deleted_${Date.now()}_${req.params.table}`;
        await r.projectPool!.query(`ALTER TABLE public.${quoteId(req.params.table)} RENAME TO ${quoteId(deletedName)}`);
    }
    res.json({ success: true });
  } catch (e: any) { next(e); }
});

app.get('/api/data/:slug/recycle-bin', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  if (!r.isSystemRequest) { res.status(403).json({ error: 'Unauthorized' }); return; }
  try {
    const result = await r.projectPool!.query(
      "SELECT table_name as name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '_deleted_%'"
    );
    res.json(result.rows);
  } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/recycle-bin/:table/restore', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  if (!r.isSystemRequest) { res.status(403).json({ error: 'Unauthorized' }); return; }
  const tableName = req.params.table;
  try {
    const originalName = tableName.replace(/^_deleted_\d+_/, '');
    await r.projectPool!.query(`ALTER TABLE public.${quoteId(tableName)} RENAME TO ${quoteId(originalName)}`);
    res.json({ success: true, restoredName: originalName });
  } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/query', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const { sql } = req.body;
  if (r.userRole !== 'service_role') { res.status(403).json({ error: 'Only Service Role can execute raw SQL' }); return; }
  const start = Date.now();
  try {
    const result = await r.projectPool!.query(sql);
    res.json({ rows: result.rows, rowCount: result.rowCount, command: result.command, duration: Date.now() - start });
  } catch (e: any) { next(e); }
});

app.get('/api/data/:slug/stats', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  if (!r.isSystemRequest) { res.status(403).json({ error: 'Unauthorized' }); return; }
  try {
    const [tables, users, size] = await Promise.all([
      r.projectPool!.query("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE '_deleted_%'"),
      r.projectPool!.query("SELECT count(*) FROM auth.users"),
      r.projectPool!.query("SELECT pg_size_pretty(pg_database_size(current_database()))")
    ]);
    res.json({
      tables: parseInt(tables.rows[0].count),
      users: parseInt(users.rows[0].count),
      size: size.rows[0].pg_size_pretty
    });
  } catch (e: any) { next(e); }
});

// --- DATA PLANE: RPC & ASSETS ---

app.get('/api/data/:slug/assets', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  try {
    const result = await systemPool.query('SELECT * FROM system.assets WHERE project_slug = $1', [r.project.slug]);
    res.json(result.rows);
  } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/assets', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const { id, name, type, parent_id, metadata } = req.body;
  try {
    if (id) {
       const upd = await systemPool.query('UPDATE system.assets SET name=$1, metadata=$2 WHERE id=$3 RETURNING *', [name, metadata, id]);
       res.json(upd.rows[0]);
    } else {
       const ins = await systemPool.query('INSERT INTO system.assets (project_slug, name, type, parent_id, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING *', [r.project.slug, name, type, parent_id, metadata]);
       res.json(ins.rows[0]);
    }
  } catch (e: any) { next(e); }
});

app.delete('/api/data/:slug/assets/:id', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  try { await systemPool.query('DELETE FROM system.assets WHERE id=$1', [req.params.id]); res.json({ success: true }); } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/rpc/:name', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const params = req.body || {};
  const placeholders = Object.keys(params).map((_, i) => `$${i + 1}`).join(', ');
  const values = Object.values(params);
  try {
    const rows = await queryWithRLS(r, async (client) => {
        const result = await client.query(
            `SELECT * FROM public.${quoteId(req.params.name)}(${placeholders})`, 
            values
        );
        return result.rows;
    });
    res.json(rows);
  } catch (e: any) { next(e); }
});

app.get('/api/data/:slug/functions', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  try { const result = await r.projectPool!.query(`
    SELECT routine_name as name 
    FROM information_schema.routines 
    WHERE routine_schema = 'public'
    AND routine_name NOT LIKE 'uuid_%' 
    AND routine_name NOT LIKE 'pgp_%'
    AND routine_name NOT LIKE 'armor%'
    AND routine_name NOT LIKE 'crypt%'
    AND routine_name NOT LIKE 'digest%'
    AND routine_name NOT LIKE 'hmac%'
    AND routine_name NOT LIKE 'gen_random%'
    AND routine_name NOT LIKE 'gen_salt%'
    AND routine_name NOT LIKE 'encrypt%'
    AND routine_name NOT LIKE 'decrypt%'
  `); res.json(result.rows); } catch (e: any) { next(e); }
});

app.get('/api/data/:slug/triggers', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  try { const result = await r.projectPool!.query(`SELECT trigger_name as name FROM information_schema.triggers`); res.json(result.rows); } catch (e: any) { next(e); }
});

// --- DATA PLANE: AUTH MANAGEMENT ---

app.get('/api/data/:slug/auth/users', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  if (!r.isSystemRequest) { res.status(403).json({ error: 'Unauthorized' }); return; }
  try {
    const result = await r.projectPool!.query(`SELECT u.id, u.created_at, u.banned, u.last_sign_in_at, jsonb_agg(jsonb_build_object('id', i.id, 'provider', i.provider, 'identifier', i.identifier)) as identities FROM auth.users u LEFT JOIN auth.identities i ON u.id = i.user_id GROUP BY u.id ORDER BY u.created_at DESC`);
    res.json(result.rows);
  } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/auth/users', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const { strategies, profileData } = req.body; 
  try {
    // Basic user creation via admin api
    const client = await r.projectPool!.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('INSERT INTO auth.users (raw_user_meta_data) VALUES ($1) RETURNING id', [profileData || {}]);
        const userId = userRes.rows[0].id;
        if (strategies) {
            for (const s of strategies) {
                // SECURITY: Hash password before storing in auth.identities
                let passwordHash = s.password;
                if (s.password) {
                    passwordHash = await bcrypt.hash(s.password, 10);
                }
                
                await client.query(
                    'INSERT INTO auth.identities (user_id, provider, identifier, password_hash) VALUES ($1, $2, $3, $4)', 
                    [userId, s.provider, s.identifier, passwordHash]
                );
            }
        }
        await client.query('COMMIT');
        res.json({ success: true, id: userId });
    } finally { client.release(); }
  } catch (e: any) { next(e); }
});

app.patch('/api/data/:slug/auth/users/:id/status', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    if (!r.isSystemRequest) { res.status(403).json({ error: 'Unauthorized' }); return; }
    try { await r.projectPool!.query('UPDATE auth.users SET banned = $1 WHERE id = $2', [req.body.banned, req.params.id]); res.json({ success: true }); } catch (e: any) { next(e); }
});

app.delete('/api/data/:slug/auth/users/:id', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    if (!r.isSystemRequest) { res.status(403).json({ error: 'Unauthorized' }); return; }
    try { await r.projectPool!.query('DELETE FROM auth.users WHERE id = $1', [req.params.id]); res.json({ success: true }); } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/auth/token', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    const { provider, identifier, password } = req.body;
    try {
        // SECURITY: Verify password using bcrypt
        const idRes = await r.projectPool!.query('SELECT * FROM auth.identities WHERE provider = $1 AND identifier = $2', [provider, identifier]);
        
        if (!idRes.rows[0]) { 
            return res.status(401).json({ error: 'Invalid credentials' }); 
        }

        const storedHash = idRes.rows[0].password_hash;
        
        // Handle Auto-Migration for Data Plane Users (Optional but consistent)
        // If stored password is NOT a bcrypt hash, assume plain text from legacy import
        let isValid = false;
        
        if (!storedHash.startsWith('$2')) {
            if (storedHash === password) {
                isValid = true;
                // Upgrade to Hash
                const newHash = await bcrypt.hash(password, 10);
                await r.projectPool!.query('UPDATE auth.identities SET password_hash = $1 WHERE id = $2', [newHash, idRes.rows[0].id]);
            }
        } else {
            isValid = await bcrypt.compare(password, storedHash);
        }

        if (!isValid) { 
            return res.status(401).json({ error: 'Invalid credentials' }); 
        }

        const session = await AuthService.createSession(idRes.rows[0].user_id, r.projectPool!, r.project.jwt_secret);
        res.json(session);
    } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/auth/link', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const { linked_tables, authStrategies, authConfig } = req.body;
  try {
    const metaUpdates: any = {};
    if (authStrategies) metaUpdates.auth_strategies = authStrategies;
    if (authConfig) metaUpdates.auth_config = authConfig;
    if (linked_tables) metaUpdates.linked_tables = linked_tables;

    await systemPool.query(`UPDATE system.projects SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE slug = $2`, [JSON.stringify(metaUpdates), r.project.slug]);
    
    if (linked_tables && Array.isArray(linked_tables) && linked_tables.length > 0) {
        const client = await r.projectPool!.connect();
        try {
            await client.query('BEGIN');
            for (const table of linked_tables) {
                await client.query(
                    `ALTER TABLE public.${quoteId(table)} 
                     ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL`
                );
                await client.query(
                    `CREATE INDEX IF NOT EXISTS ${quoteId('idx_' + table + '_user_id')} ON public.${quoteId(table)} (user_id)`
                );
            }
            await client.query('COMMIT');
        } catch (dbErr: any) {
            await client.query('ROLLBACK');
            console.error("Link Table Error:", dbErr);
        } finally {
            client.release();
        }
    }
    res.json({ success: true });
  } catch (e: any) { next(e); }
});

// --- DATA PLANE: STORAGE ---

app.get('/api/data/:slug/storage/search', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const { q, bucket } = req.query;
  const searchTerm = (q as string || '').toLowerCase();
  const projectRoot = path.join(STORAGE_ROOT, r.project.slug);
  const searchRoot = bucket ? path.join(projectRoot, bucket as string) : projectRoot;
  if (!fs.existsSync(searchRoot)) { res.json({ items: [] }); return; }
  if (!searchRoot.startsWith(projectRoot)) { res.status(403).json({ error: 'Access Denied' }); return; }
  try {
    let allFiles = walk(searchRoot, bucket ? searchRoot : projectRoot, []);
    if (searchTerm) {
      allFiles = allFiles.filter(f => f.name.toLowerCase().includes(searchTerm));
    }
    res.json({ items: allFiles });
  } catch (e: any) {
    next(e);
  }
});

app.get('/api/data/:slug/storage/buckets', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const p = path.join(STORAGE_ROOT, r.project.slug);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  const items = fs.readdirSync(p).filter(f => fs.lstatSync(path.join(p, f)).isDirectory());
  res.json(items.map(name => ({ name })));
});

app.post('/api/data/:slug/storage/buckets', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const p = path.join(STORAGE_ROOT, r.project.slug, req.body.name);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  res.json({ success: true });
});

app.patch('/api/data/:slug/storage/buckets/:name', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const oldPath = path.join(STORAGE_ROOT, r.project.slug, req.params.name);
  const newPath = path.join(STORAGE_ROOT, r.project.slug, req.body.newName);
  if (!fs.existsSync(oldPath)) { res.status(404).json({ error: 'Bucket not found' }); return; }
  if (fs.existsSync(newPath)) { res.status(400).json({ error: 'Name already exists' }); return; }
  fs.renameSync(oldPath, newPath);
  res.json({ success: true });
});

app.delete('/api/data/:slug/storage/buckets/:name', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const bucketPath = path.join(STORAGE_ROOT, r.project.slug, req.params.name);
  if (!fs.existsSync(bucketPath)) { res.status(404).json({ error: 'Bucket not found' }); return; }
  if (!bucketPath.startsWith(path.join(STORAGE_ROOT, r.project.slug))) { res.status(403).json({ error: 'Access denied' }); return; }
  try {
      fs.rmSync(bucketPath, { recursive: true, force: true });
      res.json({ success: true });
  } catch (e: any) {
      res.status(500).json({ error: e.message });
  }
});

app.post('/api/data/:slug/storage/:bucket/folder', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const { name, path: relativePath } = req.body;
  const bucketPath = path.join(STORAGE_ROOT, r.project.slug, req.params.bucket);
  const folderPath = path.join(bucketPath, relativePath || '', name);
  if (!folderPath.startsWith(bucketPath)) { res.status(403).json({ error: 'Access Denied' }); return; }
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Folder exists' });
  }
});

app.get('/api/data/:slug/storage/:bucket/list', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const { path: queryPath } = req.query;
  const bucketPath = path.join(STORAGE_ROOT, r.project.slug, req.params.bucket);
  const targetPath = path.join(bucketPath, (queryPath as string) || '');
  if (!targetPath.startsWith(bucketPath)) { res.status(403).json({ error: 'Access Denied' }); return; }
  if (!fs.existsSync(targetPath)) { res.json({ items: [] }); return; }
  try {
    const files = fs.readdirSync(targetPath);
    const items = files.map(file => {
      const filePath = path.join(targetPath, file);
      const stat = fs.statSync(filePath);
      return {
        name: file,
        type: stat.isDirectory() ? 'folder' : 'file',
        size: stat.size,
        updated_at: stat.mtime.toISOString(),
        path: path.relative(bucketPath, filePath).replace(/\\/g, '/')
      };
    });
    res.json({ items });
  } catch (e: any) { next(e); }
});

app.get('/api/data/:slug/storage/:bucket/object/*', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const relativePath = req.params[0]; 
  const bucketPath = path.join(STORAGE_ROOT, r.project.slug, req.params.bucket);
  const filePath = path.join(bucketPath, relativePath);
  if (!filePath.startsWith(bucketPath)) { res.status(403).json({ error: 'Path Traversal Detected' }); return; }
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File Not Found' }); return; }
  res.sendFile(filePath);
});

// STEP 3.2: Secure Upload Route (Robust Error Handling)
app.post('/api/data/:slug/storage/:bucket/upload', async (req: any, res: any, next: NextFunction) => {
    // Manually invoking multer to catch specific upload errors before they bubble up
    // and to ensure we are in control of the response format.
    (upload.single('file') as any)(req, res, async (err: any) => {
        if (err) {
            // Multer specific errors (Limit exceeded, etc)
            if (err instanceof multer.MulterError) {
                return res.status(400).json({ error: `Upload Error: ${err.message}`, code: err.code });
            }
            return next(err); // Pass other errors to global handler
        }

        const r = req as CascataRequest;
        if (!r.file) { 
            return res.status(400).json({ error: 'No file found in request body.' }); 
        }

        try {
            const governance = r.project.metadata?.storage_governance || {};
            const ext = path.extname(r.file.originalname).replace('.', '').toLowerCase();
            const sector = getSectorForExt(ext);
            const rule = governance[sector] || governance['global'] || { max_size: '10MB', allowed_exts: [] };
            
            // Security Checks
            if (rule.allowed_exts && rule.allowed_exts.length > 0) {
                if (!rule.allowed_exts.includes(ext)) {
                    fs.unlinkSync(r.file.path);
                    return res.status(403).json({ error: `Policy Violation: Extension .${ext} is not allowed.` });
                }
            }
            
            if (!validateMagicBytes(r.file.path, ext)) {
                fs.unlinkSync(r.file.path);
                return res.status(400).json({ error: 'Security Alert: File signature mismatch (Spoofing detected).' });
            }

            const maxBytes = parseBytes(rule.max_size);
            if (r.file.size > maxBytes) {
                fs.unlinkSync(r.file.path);
                return res.status(403).json({ error: `Policy Violation: File size exceeds limit of ${rule.max_size}.` });
            }

            const dest = path.join(STORAGE_ROOT, r.project.slug, req.params.bucket, r.body.path || '', r.file.originalname);
            if (!fs.existsSync(path.dirname(dest))) fs.mkdirSync(path.dirname(dest), { recursive: true });
            
            // Atomic move
            fs.renameSync(r.file.path, dest);
            res.json({ success: true, path: dest.replace(STORAGE_ROOT, '') });

        } catch (e: any) {
            // Ensure temp file is cleaned up on error
            if (r.file && fs.existsSync(r.file.path)) fs.unlinkSync(r.file.path);
            next(e);
        }
    });
});

app.post('/api/data/:slug/storage/move', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const { bucket, paths, destination } = req.body; 
  const root = path.join(STORAGE_ROOT, r.project.slug);
  const destPath = path.join(root, destination.bucket || bucket, destination.path || '');
  if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
  let movedCount = 0;
  for (const itemPath of paths) {
      const source = path.join(root, bucket, itemPath);
      const itemName = path.basename(itemPath);
      const target = path.join(destPath, itemName);
      if (fs.existsSync(source)) {
          fs.renameSync(source, target);
          movedCount++;
      }
  }
  res.json({ success: true, moved: movedCount });
});

app.delete('/api/data/:slug/storage/:bucket/object', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const { path: queryPath } = req.query;
  const filePath = path.join(STORAGE_ROOT, r.project.slug, req.params.bucket, (queryPath as string));
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { recursive: true, force: true });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// --- DATA PLANE: DOCS & AI ---

app.get('/api/data/:slug/docs/pages', async (req: any, res: any, next: NextFunction) => {
    try {
        const result = await systemPool.query(
            `SELECT * FROM system.doc_pages WHERE project_slug = $1 ORDER BY title ASC`,
            [req.params.slug]
        );
        res.json(result.rows);
    } catch (e: any) { next(e); }
});

app.get('/api/data/:slug/docs/openapi', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    try {
        const host = req.headers.host || 'localhost';
        const spec = await OpenApiService.generate(r.project.slug, r.project.db_name, r.projectPool!, host);
        res.json(spec);
    } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/ai/chat', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    // Get System Settings to fetch API Key
    const settingsRes = await systemPool.query("SELECT settings FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'ai_config'");
    const systemSettings = settingsRes.rows[0]?.settings || {};
    
    try {
        const response = await AiService.chat(r.project.slug, r.projectPool!, systemSettings, req.body);
        
        // Save history
        const { session_id, messages } = req.body;
        const lastUserMsg = messages[messages.length - 1];
        if (session_id) {
            await systemPool.query(
                `INSERT INTO system.ai_history (project_slug, session_id, role, content) 
                 VALUES ($1, $2, 'user', $3), ($1, $2, 'assistant', $4)`,
                [r.project.slug, session_id, lastUserMsg.content, response.choices[0].message.content]
            ).catch(e => console.error("Failed to save AI history", e));
        }
        
        res.json(response);
    } catch (e: any) {
        next(e);
    }
});

app.get('/api/data/:slug/ai/history/:session_id', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    try {
        const result = await systemPool.query(
            `SELECT role, content, created_at FROM system.ai_history 
             WHERE project_slug = $1 AND session_id = $2 
             ORDER BY created_at ASC`,
            [r.project.slug, req.params.session_id]
        );
        res.json(result.rows);
    } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/ai/draft-doc', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    const { tableName } = req.body;
    const settingsRes = await systemPool.query("SELECT settings FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'ai_config'");
    const systemSettings = settingsRes.rows[0]?.settings || {};

    try {
        const doc = await AiService.draftDoc(r.project.slug, r.projectPool!, systemSettings, tableName);
        
        // Save to doc_pages
        const saveRes = await systemPool.query(
            `INSERT INTO system.doc_pages (project_slug, slug, title, content_markdown)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (project_slug, slug) DO UPDATE 
             SET title = EXCLUDED.title, content_markdown = EXCLUDED.content_markdown, updated_at = NOW()
             RETURNING *`,
            [r.project.slug, doc.id, doc.title, doc.content_markdown]
        );
        
        res.json(saveRes.rows[0]);
    } catch (e: any) { next(e); }
});

// --- DATA PLANE: SECURITY & RATE LIMITS ---

app.get('/api/data/:slug/security/status', async (req: any, res: any, next: NextFunction) => {
    try {
        // Mock RPS for now until Stats service is fully implemented
        const panicMode = await RateLimitService.checkPanic(req.params.slug);
        res.json({ current_rps: 0, panic_mode: panicMode });
    } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/security/panic', async (req: any, res: any, next: NextFunction) => {
    const { enabled } = req.body;
    try {
        await RateLimitService.setPanic(req.params.slug, enabled);
        await systemPool.query(
            `UPDATE system.projects 
             SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{security,panic_mode}', $1) 
             WHERE slug = $2`, 
            [JSON.stringify(enabled), req.params.slug]
        );
        res.json({ success: true, panic_mode: enabled });
    } catch (e: any) { next(e); }
});

app.get('/api/data/:slug/rate-limits', async (req: any, res: any, next: NextFunction) => {
    try {
        const result = await systemPool.query('SELECT * FROM system.rate_limits WHERE project_slug = $1 ORDER BY created_at DESC', [req.params.slug]);
        res.json(result.rows);
    } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/rate-limits', async (req: any, res: any, next: NextFunction) => {
    const { route_pattern, method, rate_limit, burst_limit, window_seconds, message_anon, message_auth } = req.body;
    try {
        const result = await systemPool.query(
            `INSERT INTO system.rate_limits (project_slug, route_pattern, method, rate_limit, burst_limit, window_seconds, message_anon, message_auth)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (project_slug, route_pattern, method) 
             DO UPDATE SET 
                rate_limit = EXCLUDED.rate_limit,
                burst_limit = EXCLUDED.burst_limit,
                window_seconds = EXCLUDED.window_seconds,
                message_anon = EXCLUDED.message_anon,
                message_auth = EXCLUDED.message_auth,
                updated_at = NOW()
             RETURNING *`,
            [req.params.slug, route_pattern, method, rate_limit, burst_limit, window_seconds || 1, message_anon, message_auth]
        );
        RateLimitService.clearRules(req.params.slug);
        res.json(result.rows[0]);
    } catch (e: any) { next(e); }
});

app.delete('/api/data/:slug/rate-limits/:id', async (req: any, res: any, next: NextFunction) => {
    try {
        await systemPool.query('DELETE FROM system.rate_limits WHERE id = $1 AND project_slug = $2', [req.params.id, req.params.slug]);
        RateLimitService.clearRules(req.params.slug);
        res.json({ success: true });
    } catch (e: any) { next(e); }
});

app.get('/api/data/:slug/policies', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  try { const result = await r.projectPool!.query("SELECT * FROM pg_policies"); res.json(result.rows); } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/policies', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  const { name, table, command, role, using, withCheck } = req.body;
  const sql = `CREATE POLICY ${quoteId(name)} ON public.${quoteId(table)} FOR ${command} TO ${role} USING (${using}) ${withCheck ? `WITH CHECK (${withCheck})` : ''}`;
  try { await r.projectPool!.query(sql); res.json({ success: true }); } catch (e: any) { next(e); }
});

app.delete('/api/data/:slug/policies/:table/:name', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  try { await r.projectPool!.query(`DROP POLICY ${quoteId(req.params.name)} ON public.${quoteId(req.params.table)}`); res.json({ success: true }); } catch (e: any) { next(e); }
});

app.get('/api/data/:slug/ui-settings/:table', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  try { const result = await systemPool.query('SELECT settings FROM system.ui_settings WHERE project_slug = $1 AND table_name = $2', [r.project.slug, req.params.table]); res.json(result.rows[0]?.settings || {}); } catch (e: any) { next(e); }
});

app.post('/api/data/:slug/ui-settings/:table', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  try { await systemPool.query(`INSERT INTO system.ui_settings (project_slug, table_name, settings) VALUES ($1, $2, $3) ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $3`, [r.project.slug, req.params.table, req.body.settings]); res.json({ success: true }); } catch (e: any) { next(e); }
});

app.get('/api/data/:slug/logs', async (req: any, res: any, next: NextFunction) => {
  const r = req as CascataRequest;
  try {
    const result = await systemPool.query('SELECT * FROM system.api_logs WHERE project_slug = $1 ORDER BY created_at DESC LIMIT 100', [r.project.slug]);
    res.json(result.rows);
  } catch (e: any) { next(e); }
});

// --- CONTROL PLANE: PROJECTS (With Security Upgrade - No Auto Decrypt) ---
app.get('/api/control/projects', async (req: any, res: any, next: NextFunction) => {
  try {
    // This route is critical for the dashboard listing.
    // If HostGuard blocks it, the dashboard shows empty or errors out.
    const result = await systemPool.query(`
        SELECT 
            id, name, slug, db_name, custom_domain, ssl_certificate_source, blocklist, metadata, status, created_at,
            '******' as jwt_secret,
            '******' as anon_key,
            '******' as service_key
        FROM system.projects ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (e: any) { next(e); }
});

// --- NEW SECURE ROUTE: REVEAL KEY (Sudo Mode) ---
app.post('/api/control/projects/:slug/reveal-key', async (req: any, res: any, next: NextFunction) => {
    const { password, keyType } = req.body;
    const { slug } = req.params;

    if (!password || !keyType) return res.status(400).json({ error: "Missing credentials" });
    if (!['jwt_secret', 'anon_key', 'service_key'].includes(keyType)) return res.status(400).json({ error: "Invalid key type" });

    try {
        // 1. Verify Admin Password (Re-Auth)
        const adminRes = await systemPool.query('SELECT * FROM system.admin_users LIMIT 1');
        const admin = adminRes.rows[0];
        
        let isValid = false;
        if (!admin.password_hash.startsWith('$2')) {
            isValid = admin.password_hash === password;
        } else {
            isValid = await bcrypt.compare(password, admin.password_hash);
        }

        if (!isValid) return res.status(403).json({ error: "Invalid Sudo Password" });

        // 2. Decrypt specific key
        const keyRes = await systemPool.query(
            `SELECT pgp_sym_decrypt(${keyType}::bytea, $2) as decrypted_key FROM system.projects WHERE slug = $1`,
            [slug, SYS_SECRET]
        );

        if (keyRes.rows.length === 0) return res.status(404).json({ error: "Project not found" });

        res.json({ key: keyRes.rows[0].decrypted_key });

    } catch (e: any) {
        next(e);
    }
});

app.post('/api/control/projects', async (req: any, res: any, next: NextFunction) => {
  const { name, slug } = req.body;
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const dbName = `cascata_db_${safeSlug.replace(/-/g, '_')}`;
  
  let tempClient: pg.Client | null = null;

  try {
    const keys = { anon: generateKey(), service: generateKey(), jwt: generateKey() };
    
    // Insert with Encryption
    const insertRes = await systemPool.query(
      `INSERT INTO system.projects (name, slug, db_name, anon_key, service_key, jwt_secret, metadata) 
       VALUES ($1, $2, $3, pgp_sym_encrypt($4, $7), pgp_sym_encrypt($5, $7), pgp_sym_encrypt($6, $7), '{}') RETURNING *`,
      [name, safeSlug, dbName, keys.anon, keys.service, keys.jwt, SYS_SECRET]
    );

    await systemPool.query(`CREATE DATABASE ${quoteId(dbName)}`);

    const baseUrl = process.env.SYSTEM_DATABASE_URL || '';
    const newDbUrl = baseUrl.replace(/\/[^\/?]+(\?.*)?$/, `/${dbName}$1`);
    
    tempClient = new pg.Client({ connectionString: newDbUrl });
    await tempClient.connect();

    await DatabaseService.initProjectDb(tempClient);

    res.json({ ...insertRes.rows[0], anon_key: keys.anon, service_key: keys.service, jwt_secret: keys.jwt });
  } catch (e: any) {
    if (tempClient) await tempClient.end();
    await systemPool.query('DELETE FROM system.projects WHERE slug = $1', [safeSlug]).catch(() => {});
    next(e);
  } finally {
    if (tempClient) await tempClient.end();
  }
});

app.delete('/api/control/projects/:slug', async (req: any, res: any, next: NextFunction) => {
  const { slug } = req.params;
  try {
    const result = await systemPool.query('SELECT * FROM system.projects WHERE slug = $1', [slug]);
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Project not found' }); return; }
    
    const project = result.rows[0];
    await PoolService.close(project.db_name);

    try {
        await systemPool.query(`DROP DATABASE IF EXISTS ${quoteId(project.db_name)}`);
    } catch (dbErr: any) {
        await systemPool.query(`
            SELECT pg_terminate_backend(pg_stat_activity.pid)
            FROM pg_stat_activity
            WHERE pg_stat_activity.datname = $1
            AND pid <> pg_backend_pid()`, [project.db_name]);
        await systemPool.query(`DROP DATABASE IF EXISTS ${quoteId(project.db_name)}`);
    }

    await systemPool.query('DELETE FROM system.projects WHERE slug = $1', [slug]);
    await systemPool.query('DELETE FROM system.assets WHERE project_slug = $1', [slug]);
    await systemPool.query('DELETE FROM system.webhooks WHERE project_slug = $1', [slug]);
    await systemPool.query('DELETE FROM system.api_logs WHERE project_slug = $1', [slug]);
    await systemPool.query('DELETE FROM system.ui_settings WHERE project_slug = $1', [slug]);
    await systemPool.query('DELETE FROM system.rate_limits WHERE project_slug = $1', [slug]);
    await systemPool.query('DELETE FROM system.doc_pages WHERE project_slug = $1', [slug]);
    await systemPool.query('DELETE FROM system.ai_history WHERE project_slug = $1', [slug]);

    const storagePath = path.join(STORAGE_ROOT, slug);
    if (fs.existsSync(storagePath)) {
        fs.rmSync(storagePath, { recursive: true, force: true });
    }
    
    await CertificateService.rebuildNginxConfigs(systemPool);

    res.json({ success: true });
  } catch (e: any) { next(e); }
});

app.patch('/api/control/projects/:slug', async (req: any, res: any, next: NextFunction) => {
  const { custom_domain, log_retention_days, metadata, ssl_certificate_source } = req.body;
  try {
    let metadataQueryPart = 'metadata'; 
    const safeDomain = custom_domain ? custom_domain.trim().toLowerCase() : undefined;
    const safeSource = ssl_certificate_source ? ssl_certificate_source.trim().toLowerCase() : undefined;

    const params: any[] = [safeDomain, log_retention_days, req.params.slug, safeSource];
    let paramIdx = 5;

    if (metadata) {
        metadataQueryPart = `COALESCE(metadata, '{}'::jsonb) || $${paramIdx}::jsonb`;
        params.push(JSON.stringify(metadata));
    }

    const result = await systemPool.query(
      `UPDATE system.projects 
       SET custom_domain = COALESCE($1, custom_domain), 
           log_retention_days = COALESCE($2, log_retention_days),
           ssl_certificate_source = COALESCE($4, ssl_certificate_source),
           metadata = ${metadataQueryPart},
           updated_at = now() 
       WHERE slug = $3 RETURNING *`,
      params
    );
    
    await CertificateService.rebuildNginxConfigs(systemPool);
    res.json(result.rows[0]);
  } catch (e: any) { next(e); }
});

// Key Rotation (With Encryption)
app.post('/api/control/projects/:slug/rotate-keys', async (req: any, res: any, next: NextFunction) => {
  const { type } = req.body;
  const newKey = generateKey();
  let column = '';
  if (type === 'anon') column = 'anon_key';
  else if (type === 'service') column = 'service_key';
  else if (type === 'jwt') column = 'jwt_secret';
  else { res.status(400).json({ error: 'Invalid key type' }); return; }

  try {
    await systemPool.query(
      `UPDATE system.projects SET ${column} = pgp_sym_encrypt($1, $3) WHERE slug = $2`,
      [newKey, req.params.slug, SYS_SECRET]
    );
    res.json({ success: true, type, newKey: 'HIDDEN_IN_RESPONSE' });
  } catch (e: any) { next(e); }
});

app.post('/api/control/projects/:slug/block-ip', async (req: any, res: any, next: NextFunction) => {
  const { ip } = req.body;
  try {
    await systemPool.query(
      'UPDATE system.projects SET blocklist = array_append(blocklist, $1) WHERE slug = $2', 
      [ip, req.params.slug]
    );
    res.json({ success: true });
  } catch (e: any) { next(e); }
});

app.delete('/api/control/projects/:slug/blocklist/:ip', async (req: any, res: any, next: NextFunction) => {
  const { ip } = req.params;
  try {
    await systemPool.query(
      'UPDATE system.projects SET blocklist = array_remove(blocklist, $1) WHERE slug = $2', 
      [ip, req.params.slug]
    );
    res.json({ success: true });
  } catch (e: any) { next(e); }
});

app.get('/api/control/me/ip', (req: any, res: any) => {
  const forwarded = req.headers['x-forwarded-for'];
  const realIp = req.headers['x-real-ip'];
  const socketIp = req.socket.remoteAddress;
  let ip = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
  res.json({ ip });
});

// --- CONTROL PLANE: SYSTEM & SETTINGS ---

app.post('/api/control/auth/login', async (req: any, res: any, next: NextFunction) => {
  const { email, password } = req.body;
  try {
    const result = await systemPool.query('SELECT * FROM system.admin_users WHERE email = $1', [email]);
    const user = result.rows[0];
    
    if (!user) {
        return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    // Auto-Migration for Plaintext Passwords
    // If the stored password isn't a hash (bcrypt hashes start with $2b$ or $2a$), verify as plaintext and upgrade
    if (!user.password_hash.startsWith('$2')) {
        if (user.password_hash === password) {
            const newHash = await bcrypt.hash(password, 10);
            await systemPool.query('UPDATE system.admin_users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);
            // Allow login this time
        } else {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }
    } else {
        // Standard bcrypt check
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const token = jwt.sign({ sub: user.id, role: 'superadmin' }, process.env.SYSTEM_JWT_SECRET!, { expiresIn: '12h' });
    res.json({ token });
  } catch (e: any) { next(e); }
});

app.post('/api/control/auth/verify', async (req: any, res: any, next: NextFunction) => {
  const { password } = req.body;
  try {
    const result = await systemPool.query('SELECT * FROM system.admin_users LIMIT 1');
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'System not initialized' });

    if (!user.password_hash.startsWith('$2')) {
        if (user.password_hash === password) return res.json({ success: true });
    } else {
        const match = await bcrypt.compare(password, user.password_hash);
        if (match) return res.json({ success: true });
    }
    
    res.status(401).json({ error: 'Senha incorreta' });
  } catch (e: any) { next(e); }
});

app.put('/api/control/auth/profile', async (req: any, res: any, next: NextFunction) => {
  const { email, password } = req.body;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await systemPool.query('UPDATE system.admin_users SET email = $1, password_hash = $2', [email, hash]);
    } else {
      await systemPool.query('UPDATE system.admin_users SET email = $1', [email]);
    }
    res.json({ success: true });
  } catch (e: any) { next(e); }
});

app.get('/api/control/system/settings', async (req: any, res: any, next: NextFunction) => {
  try {
    const result = await systemPool.query(
      "SELECT table_name, settings FROM system.ui_settings WHERE project_slug = '_system_root_'"
    );
    const output: any = {};
    result.rows.forEach(r => {
        if(r.table_name === 'domain_config') output.domain = r.settings.domain;
        if(r.table_name === 'ai_config') output.ai = r.settings;
    });
    res.json(output);
  } catch (e: any) { next(e); }
});

app.post('/api/control/system/settings', async (req: any, res: any, next: NextFunction) => {
  const { domain, ai_config } = req.body;
  try {
    if (domain !== undefined) {
        const safeDomain = domain?.trim().toLowerCase() || null;
        await systemPool.query(
          `INSERT INTO system.ui_settings (project_slug, table_name, settings) 
           VALUES ('_system_root_', 'domain_config', $1) 
           ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $1`,
          [JSON.stringify({ domain: safeDomain })]
        );
    }
    if (ai_config !== undefined) {
        await systemPool.query(
          `INSERT INTO system.ui_settings (project_slug, table_name, settings) 
           VALUES ('_system_root_', 'ai_config', $1) 
           ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $1`,
          [JSON.stringify(ai_config)]
        );
    }
    res.json({ success: true });
  } catch (e: any) { next(e); }
});

app.post('/api/control/system/ssl-check', async (req: any, res: any, next: NextFunction) => {
  const { domain } = req.body;
  if (!domain) { res.status(400).json({ error: 'Domain required' }); return; }
  
  const safeDomain = domain.trim().toLowerCase();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    await fetch(`https://${safeDomain}`, { 
        method: 'HEAD', 
        signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    res.json({ status: 'active' });
  } catch (e: any) {
    res.json({ status: 'inactive', error: e.message });
  }
});

app.get('/api/control/system/certificates/status', async (req: any, res: any, next: NextFunction) => {
  try {
    const status = await CertificateService.detectEnvironment();
    res.json(status);
  } catch (e: any) { next(e); }
});

app.post('/api/control/system/certificates', async (req: any, res: any, next: NextFunction) => {
  const { domain, email, cert, key, provider, isSystem } = req.body;
  const safeDomain = domain.trim().toLowerCase();
  
  try {
    const result = await CertificateService.requestCertificate(
        safeDomain, 
        email, 
        provider, 
        systemPool,
        { cert, key },
        isSystem
    );
    res.json(result);
  } catch (e: any) { next(e); }
});

app.delete('/api/control/system/certificates/:domain', async (req: any, res: any, next: NextFunction) => {
    try {
        await CertificateService.deleteCertificate(req.params.domain, systemPool);
        res.json({ success: true });
    } catch (e: any) { next(e); }
});

// --- CONTROL PLANE: WEBHOOKS & LOGS ---

app.get('/api/control/projects/:slug/webhooks', async (req: any, res: any, next: NextFunction) => {
  try {
    const result = await systemPool.query('SELECT * FROM system.webhooks WHERE project_slug = $1', [req.params.slug]);
    res.json(result.rows);
  } catch (e: any) { next(e); }
});

app.post('/api/control/projects/:slug/webhooks', async (req: any, res: any, next: NextFunction) => {
  const { target_url, event_type, table_name } = req.body;
  try {
    await systemPool.query(
      'INSERT INTO system.webhooks (project_slug, target_url, event_type, table_name) VALUES ($1, $2, $3, $4)',
      [req.params.slug, target_url, event_type, table_name]
    );
    res.json({ success: true });
  } catch (e: any) { next(e); }
});

app.delete('/api/control/projects/:slug/logs', async (req: any, res: any, next: NextFunction) => {
  const { days } = req.query;
  try {
    await systemPool.query(
      `DELETE FROM system.api_logs WHERE project_slug = $1 AND created_at < now() - interval '${Number(days)} days'`,
      [req.params.slug]
    );
    res.json({ success: true });
  } catch (e: any) { next(e); }
});

// --- DATA PLANE: EDGE FUNCTIONS (NEW) ---
app.post('/api/data/:slug/edge/:name', async (req: any, res: any, next: NextFunction) => {
    const r = req as CascataRequest;
    try {
        const assetRes = await systemPool.query(
            'SELECT * FROM system.assets WHERE project_slug = $1 AND name = $2 AND type = \'edge_function\'', 
            [r.project.slug, req.params.name]
        );
        
        if (assetRes.rows.length === 0) throw new Error("Edge Function Not Found");
        const asset = assetRes.rows[0];
        
        const context = {
            method: req.method,
            body: req.body,
            query: req.query,
            headers: req.headers,
            user: r.user
        };

        const result = await EdgeService.execute(
            asset.metadata.sql, // The JS Code
            context,
            asset.metadata.env_vars || {},
            r.projectPool!,
            (asset.metadata.timeout || 5) * 1000
        );

        res.status(result.status).json(result.body);
    } catch (e: any) { next(e); }
});

// --- GLOBAL ERROR HANDLER (STEP 3.1: Enhanced Error Mapping) ---
app.use((err: any, req: any, res: any, next: NextFunction) => {
    // Only log actual errors, not user validation issues to keep logs clean
    if (!err.code?.startsWith('2') && !err.code?.startsWith('4')) {
        console.error(`[Global Error] ${req.method} ${req.path}:`, err);
    }
    
    // 1. Multer & Upload Errors
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File too large. Check storage limits.', code: err.code });
        }
        return res.status(400).json({ error: `Upload Error: ${err.message}`, code: err.code });
    }

    // 2. Postgres Error Mapping (Code to HTTP Status)
    if (err.code) {
        switch(err.code) {
            case '23505': // unique_violation
                return res.status(409).json({ 
                    error: 'Conflict: Record already exists.', 
                    hint: err.detail, 
                    code: err.code 
                });
            case '23503': // foreign_key_violation
                return res.status(400).json({ 
                    error: 'Foreign Key Violation: Referenced record does not exist or has dependencies.', 
                    hint: err.detail, 
                    code: err.code 
                });
            case '42P01': // undefined_table
                return res.status(404).json({ 
                    error: 'Resource Not Found: Table does not exist.', 
                    code: err.code 
                });
            case '42703': // undefined_column
                return res.status(400).json({ 
                    error: 'Bad Request: Invalid column reference.', 
                    hint: err.hint, 
                    code: err.code 
                });
            case '23502': // not_null_violation
                return res.status(400).json({ 
                    error: 'Validation Error: Missing required field.', 
                    hint: `Column: ${err.column}`, 
                    code: err.code 
                });
            case '22P02': // invalid_text_representation
                return res.status(400).json({ 
                    error: 'Invalid Input Syntax (Type Mismatch).', 
                    code: err.code 
                });
        }
    }

    // 3. JSON Parse Errors
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    // 4. Default Fallback
    const statusCode = err.status || 500;
    const message = err.message || 'Internal Server Error';
    
    // Sanitization: Don't leak stack traces in production responses
    res.status(statusCode).json({
        error: message,
        code: err.code || 'INTERNAL_ERROR',
        hint: process.env.NODE_ENV === 'development' ? 'Check backend logs for details' : undefined
    });
});

// STARTUP SEQUENCE
(async () => {
  try {
    console.log('[System] Starting Cascata Secure Engine v8.2 (Full Hardening)...');
    cleanTempUploads();
    app.listen(PORT, () => console.log(`[CASCATA SECURE ENGINE] Listening on port ${PORT}`));
    CertificateService.ensureSystemCert().catch(e => console.error("Cert Init Error:", e));
    waitForDatabase(30, 2000).then(async (ready) => {
        if (ready) await MigrationService.run(systemPool, MIGRATIONS_ROOT);
        else console.error('[System] CRITICAL: Main Database Unreachable.');
    });
  } catch (e) { console.error('[System] FATAL BOOT ERROR:', e); }
})();
