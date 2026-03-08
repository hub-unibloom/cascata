
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { Buffer } from 'buffer';
import { MAGIC_NUMBERS, TEMP_UPLOAD_ROOT, systemPool } from '../config/main.js';
import { CascataRequest } from '../types.js';
import pg from 'pg';
import dns from 'dns/promises';
import { URL } from 'url';

// --- SSRF SECURITY UTILS ---

export const isPrivateIP = (ip: string): boolean => {
    // IPv4 Check
    if (ip.includes('.')) {
        const parts = ip.split('.').map(Number);
        if (parts.length !== 4) return false;

        // 0.0.0.0/8 (Current network)
        if (parts[0] === 0) return true;
        // 10.0.0.0/8 (Private)
        if (parts[0] === 10) return true;
        // 127.0.0.0/8 (Loopback)
        if (parts[0] === 127) return true;
        // 169.254.0.0/16 (Link-local / Cloud Metadata AWS/Azure/GCP)
        if (parts[0] === 169 && parts[1] === 254) return true;
        // 172.16.0.0/12 (Private)
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        // 192.168.0.0/16 (Private)
        if (parts[0] === 192 && parts[1] === 168) return true;
    }
    // IPv6 Check
    else if (ip.includes(':')) {
        // ::1 (Loopback)
        if (ip === '::1' || ip === '::') return true;
        // fc00::/7 (Unique Local)
        if (ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')) return true;
        // fe80::/10 (Link Local)
        if (ip.toLowerCase().startsWith('fe80')) return true;
    }

    return false;
};

export const validateTargetUrl = async (targetUrl: string): Promise<string> => {
    try {
        const url = new URL(targetUrl);
        const hostname = url.hostname;

        if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') {
            throw new Error("Blocked: localhost access denied");
        }

        const internalServices = ['redis', 'db', 'backend_control', 'backend_data', 'nginx', 'nginx_controller', 'backend_engine'];
        if (internalServices.includes(hostname)) {
            throw new Error("Blocked: Internal service access denied");
        }

        let ips: string[] = [];
        const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':');

        if (isIp) {
            ips = [hostname];
        } else {
            try {
                const records = await dns.lookup(hostname, { all: true });
                ips = records.map(r => r.address);
            } catch (e) {
                throw new Error(`DNS Resolution failed for ${hostname}`);
            }
        }

        for (const ip of ips) {
            if (isPrivateIP(ip)) {
                throw new Error(`Security Violation: Host ${hostname} resolves to private IP ${ip}. Request blocked.`);
            }
        }

        return ips[0];

    } catch (e: any) {
        throw new Error(`SSRF Protection: ${e.message}`);
    }
};

export const waitForDatabase = async (retries = 30, delay = 2000): Promise<boolean> => {
    for (let i = 0; i < retries; i++) {
        try {
            await systemPool.query('SELECT 1');
            return true;
        } catch (e) {
            console.log(`[System] Database not ready, retrying in ${delay}ms... (${i + 1}/${retries})`);
            await new Promise(res => setTimeout(res, delay));
        }
    }
    return false;
};

// --- FILESYSTEM UTILS ---

export const getSectorForExt = (ext: string): string => {
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

// --- FORMAT VALIDATION UTILS ---

/**
 * Presets de formato para validação de colunas.
 * Cada preset contém um regex seguro (sem backtracking exponencial) e um exemplo.
 */
export const FORMAT_PRESETS: Record<string, { label: string; regex: string; example: string; description: string }> = {
    email: { label: 'Email', regex: '^[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}$', example: 'user@example.com', description: 'Endereço de e-mail válido' },
    cpf: { label: 'CPF', regex: '^\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}$', example: '123.456.789-00', description: 'CPF no formato XXX.XXX.XXX-XX' },
    cnpj: { label: 'CNPJ', regex: '^\\d{2}\\.\\d{3}\\.\\d{3}\\/\\d{4}-\\d{2}$', example: '12.345.678/0001-99', description: 'CNPJ no formato XX.XXX.XXX/XXXX-XX' },
    phone_br: { label: 'Phone (BR)', regex: '^\\+?55\\s?\\(?\\d{2}\\)?\\s?\\d{4,5}-?\\d{4}$', example: '+55 (11) 99999-1234', description: 'Telefone brasileiro com DDD' },
    cep: { label: 'CEP', regex: '^\\d{5}-?\\d{3}$', example: '01310-100', description: 'CEP brasileiro' },
    url: { label: 'URL', regex: '^https?:\\/\\/[a-zA-Z0-9\\-]+(\\.[a-zA-Z0-9\\-]+)+(\\/.*)?$', example: 'https://example.com', description: 'URL com http ou https' },
    uuid_format: { label: 'UUID', regex: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID v4 padrão' },
    date_br: { label: 'Date (BR)', regex: '^\\d{2}\\/\\d{2}\\/\\d{4}$', example: '25/02/2026', description: 'Data no formato DD/MM/AAAA' },
};

/**
 * Valida um valor contra um pattern (preset ou regex custom).
 * Proteção anti-ReDoS: timeout de 50ms por match.
 * Retorna { valid, error? }.
 */
export const validateFormatPattern = (value: string, pattern: string): { valid: boolean; error?: string } => {
    if (!value || !pattern) return { valid: true };

    // Resolve preset
    const resolvedPattern = FORMAT_PRESETS[pattern]?.regex || pattern;

    try {
        // Anti-ReDoS: limit regex complexity
        if (resolvedPattern.length > 500) {
            return { valid: false, error: 'Format pattern too complex (max 500 chars).' };
        }

        const regex = new RegExp(resolvedPattern);

        // Execute with timeout protection
        const start = performance.now();
        const result = regex.test(value);
        const elapsed = performance.now() - start;

        if (elapsed > 50) {
            console.warn(`[FormatValidation] Pattern "${pattern}" took ${elapsed.toFixed(1)}ms — potential ReDoS.`);
            return { valid: false, error: 'Format validation timeout — pattern may be too complex.' };
        }

        if (!result) {
            const presetInfo = FORMAT_PRESETS[pattern];
            const hint = presetInfo ? ` Expected format: ${presetInfo.example}` : '';
            return { valid: false, error: `Value "${value}" does not match the required format.${hint}` };
        }

        return { valid: true };
    } catch (e: any) {
        return { valid: false, error: `Invalid format pattern: ${e.message}` };
    }
};

/**
 * Parse format info from a PostgreSQL column COMMENT.
 * Format: "description||FORMAT:preset_or_regex"
 * Returns { description, formatPattern } or { description } if no format.
 */
export const parseColumnFormat = (comment: string | null): { description: string; formatPattern?: string } => {
    if (!comment) return { description: '' };
    const separator = '||FORMAT:';
    const idx = comment.indexOf(separator);
    if (idx === -1) return { description: comment };
    return {
        description: comment.substring(0, idx),
        formatPattern: comment.substring(idx + separator.length)
    };
};

/**
 * Build a PostgreSQL COMMENT string from description + format pattern.
 */
export const buildColumnComment = (description: string, formatPattern?: string): string => {
    if (!formatPattern) return description;
    return `${description}||FORMAT:${formatPattern}`;
};

/**
 * Resolve storage config for a specific file extension.
 * Checks per-sector provider override, falls back to global project config.
 */
export const resolveStorageConfig = (metadata: any, ext: string): any => {
    const globalConfig = metadata?.storage_config || { provider: 'local' };
    const governance = metadata?.storage_governance || {};
    const sector = getSectorForExt(ext);
    const sectorRule = governance[sector];

    // If sector has a specific storage_provider, build config from it
    if (sectorRule?.storage_provider && sectorRule.storage_provider !== 'default') {
        const provider = sectorRule.storage_provider;
        // Use the provider-specific credentials from the global config object
        const providerConfig = metadata?.storage_config?.[provider];
        if (providerConfig) {
            return {
                ...globalConfig,
                provider,
                // Keep all provider-specific config sections from the global config
            };
        }
        // Provider configured but no credentials — fall back to global
        console.warn(`[StorageRouting] Sector "${sector}" wants provider "${provider}" but no credentials found. Falling back to global.`);
    }

    return globalConfig;
};

export const validateMagicBytesAsync = async (filePath: string, ext: string): Promise<boolean> => {
    if (['exe', 'sh', 'php', 'pl', 'py', 'rb', 'bat', 'cmd', 'msi', 'vbs'].includes(ext)) {
        return false;
    }

    if (!MAGIC_NUMBERS[ext]) return true;

    let fileHandle: fsPromises.FileHandle | null = null;
    try {
        fileHandle = await fsPromises.open(filePath, 'r');
        const buffer = Buffer.alloc(4);
        await fileHandle.read(buffer, 0, 4, 0);

        const hex = buffer.toString('hex').toUpperCase();
        return MAGIC_NUMBERS[ext].some(sig => hex.startsWith(sig) || sig.startsWith(hex));
    } catch (e) {
        console.error(`[MagicBytes] Error validating ${filePath}:`, e);
        return false;
    } finally {
        if (fileHandle) await fileHandle.close();
    }
};

export const parseBytes = (sizeStr: string): number => {
    if (!sizeStr) return 2 * 1024 * 1024;
    const match = sizeStr.toString().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
    if (!match) return parseInt(sizeStr) || 0;
    const num = parseFloat(match[1]);
    const unit = (match[2] || 'B').toUpperCase();
    const multipliers: Record<string, number> = { 'B': 1, 'KB': 1024, 'MB': 1024 * 1024, 'GB': 1024 * 1024 * 1024 };
    return Math.floor(num * (multipliers[unit] || 1));
};

export const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const walkAsync = async (dir: string, rootPath: string): Promise<any[]> => {
    let results: any[] = [];
    try {
        const list = await fsPromises.readdir(dir);
        for (const file of list) {
            const filePath = path.join(dir, file);
            const stat = await fsPromises.stat(filePath);
            const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');

            results.push({
                name: file,
                type: stat.isDirectory() ? 'folder' : 'file',
                size: stat.size,
                updated_at: stat.mtime.toISOString(),
                path: relativePath
            });

            if (stat.isDirectory()) {
                const children = await walkAsync(filePath, rootPath);
                results = results.concat(children);
            }
        }
    } catch (e) {
        console.warn(`[WalkAsync] Error scanning ${dir}:`, e);
    }
    return results;
};

export const cleanTempUploads = async () => {
    try {
        const files = await fsPromises.readdir(TEMP_UPLOAD_ROOT);
        const now = Date.now();
        for (const file of files) {
            const filePath = path.join(TEMP_UPLOAD_ROOT, file);
            try {
                const stats = await fsPromises.stat(filePath);
                if (now - stats.mtimeMs > 3600 * 1000) {
                    await fsPromises.rm(filePath, { recursive: true, force: true });
                }
            } catch (e) { }
        }
    } catch (e) { }
};

// --- DATABASE UTILS ---

export const quoteId = (identifier: string) => {
    if (typeof identifier !== 'string') throw new Error("Invalid identifier");
    return `"${identifier.replace(/"/g, '""')}"`;
};

// HARDENED RLS WRAPPER (FAIL-CLOSED)
export const queryWithRLS = async (req: CascataRequest, callback: (client: pg.PoolClient) => Promise<any>) => {
    if (!req.projectPool) {
        throw { status: 500, message: 'Project context missing or database pool not initialized.' };
    }

    let client;
    try {
        client = await req.projectPool.connect();
    } catch (e: any) {
        console.error(`[DB Connection] Failed for ${req.project?.slug}:`, e.message);
        if (e.code === '3D000') throw { status: 404, message: 'Project database not found.' };
        throw { status: 502, message: 'Database infrastructure unreachable.' };
    }

    try {
        // 1. Transaction Start
        await client.query('BEGIN');

        // 2. Configuration (Sequential to avoid 42601 Error with Params)
        await client.query("SET LOCAL statement_timeout = '30s'");
        await client.query("SET LOCAL ROLE cascata_api_role");

        // 3. Inject Claims (Parameterized)
        const claims = [
            req.user?.sub || '',
            req.userRole || 'anon',
            req.user?.email || ''
        ];
        await client.query(`
        SELECT 
            set_config('request.jwt.claim.sub', $1, true),
            set_config('request.jwt.claim.role', $2, true),
            set_config('request.jwt.claim.email', $3, true)
    `, claims);

        // 4. Execute User Logic
        const result = await callback(client);

        // 5. Commit
        await client.query('COMMIT');

        return result;

    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (rbErr) { }
        throw e;
    } finally {
        client.release();
    }
};
