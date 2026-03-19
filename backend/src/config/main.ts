import pg, { PoolConfig } from 'pg';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import process from 'process';

dotenv.config();

const { Pool } = pg;

const APP_ROOT = path.resolve('.');

export const STORAGE_ROOT = process.env.STORAGE_ROOT || path.resolve(APP_ROOT, '../storage');
export const MIGRATIONS_ROOT = process.env.MIGRATIONS_ROOT || path.resolve(APP_ROOT, 'migrations');
export const TEMP_UPLOAD_ROOT = process.env.TEMP_UPLOAD_ROOT || path.resolve(APP_ROOT, 'temp_uploads');
export const NGINX_DYNAMIC_ROOT = process.env.NGINX_DYNAMIC_ROOT || '/etc/nginx/conf.d/dynamic';

const ensureDir = (dir: string) => {
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    } catch (e) {
        console.error(`[Config] Error creating directory ${dir}:`, e);
    }
};

ensureDir(STORAGE_ROOT);
ensureDir(NGINX_DYNAMIC_ROOT);
ensureDir(TEMP_UPLOAD_ROOT);


let _systemPool: pg.Pool | null = null;
let _poolConfig: PoolConfig | null = null;

/**
 * Inicializa a configuração do sistema, buscando segredos no Vault se necessário.
 * Este é o "Santo Graal" do boot sincronizado.
 */
export const bootstrapConfig = async () => {
    if (_systemPool) return;

    const vaultAddr = process.env.VAULT_ADDR;
    const vaultToken = process.env.VAULT_TOKEN;

    if (vaultAddr && vaultToken) {
        console.log('[Config] Vault detected. Fetching system secrets...');
        const { VaultService } = await import('../../services/VaultService.js');
        const vault = VaultService.getInstance();
        vault.setToken(vaultToken);

        try {
            const secrets = await vault.getSecret('cascata/system');
            if (secrets.SYSTEM_DATABASE_URL) process.env.SYSTEM_DATABASE_URL = secrets.SYSTEM_DATABASE_URL;
            if (secrets.SYSTEM_JWT_SECRET) process.env.SYSTEM_JWT_SECRET = secrets.SYSTEM_JWT_SECRET;
            console.log('[Config] Secrets loaded from Vault.');
        } catch (e) {
            console.error('[Config] Failed to fetch secrets from Vault:', e);
            // Fallback para o que estiver no ENV (se houver) ou morre
        }
    }

    if (!process.env.SYSTEM_DATABASE_URL) {
        console.error('[Config] FATAL: SYSTEM_DATABASE_URL is not defined.');
        process.exit(1);
    }

    _poolConfig = {
        connectionString: process.env.SYSTEM_DATABASE_URL,
        max: 25,
        idleTimeoutMillis: 30000 
    };

    _systemPool = new Pool(_poolConfig);
    
    _systemPool.on('error', (err: Error) => {
        console.error('[SystemPool] Unexpected error on idle client', err);
    });

    if (!process.env.SYSTEM_JWT_SECRET) {
        console.error('[Config] FATAL: SYSTEM_JWT_SECRET is missing even after Vault bootstrap.');
        process.exit(1);
    }
};

/**
 * Proxy para o systemPool. 
 * Permite que outros arquivos importem 'systemPool' estaticamente, 
 * mas a conexão real só acontece após o bootstrapConfig().
 */
export const systemPool = new Proxy({} as pg.Pool, {
    get(target, prop, receiver) {
        if (!_systemPool) {
            throw new Error('[Config] systemPool accessed before bootstrapConfig() was called.');
        }
        const value = Reflect.get(_systemPool, prop, receiver);
        return typeof value === 'function' ? value.bind(_systemPool) : value;
    }
});

export const upload = multer({ 
    dest: TEMP_UPLOAD_ROOT,
    limits: {
        fileSize: 100 * 1024 * 1024, 
        fieldSize: 10 * 1024 * 1024 
    }
});

export const backupUpload = multer({ 
    dest: TEMP_UPLOAD_ROOT,
    limits: { fileSize: 5 * 1024 * 1024 * 1024 } 
});

/**
 * SYS_SECRET: Retorna o segredo JWT do sistema.
 * Deve ser acessado apenas após o bootstrapConfig().
 */
export const getSystemSecret = () => {
    if (!process.env.SYSTEM_JWT_SECRET) {
        throw new Error('[Config] SYSTEM_JWT_SECRET accessed before bootstrap.');
    }
    return process.env.SYSTEM_JWT_SECRET;
};

// Mantemos SYS_SECRET para compatibilidade legada, mas agora via getter dinâmico se possível
// ou apenas exportamos a variável e confiamos no bootstrap.
// Para garantir "zero regression", vamos manter a exportação mas avisar que depende do boot.
export const SYS_SECRET = process.env.SYSTEM_JWT_SECRET || 'BOOTSTRAP_PENDING';

export const MAGIC_NUMBERS: Record<string, string[]> = {
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
