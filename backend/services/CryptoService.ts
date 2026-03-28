import axios from 'axios';
import { CRYPTO_ENGINE_URL, INTERNAL_CTRL_SECRET } from '../src/config/main.js';

/**
 * Cascata Crypto Service (Node.js Client)
 * Synergistic bridge to the Sovereign Crypto Engine (Go)
 */
export class CryptoService {
    
    private static client = axios.create({
        baseURL: CRYPTO_ENGINE_URL || 'http://crypto_engine:3000',
        headers: {
            'X-Crypto-Auth': INTERNAL_CTRL_SECRET,
            'Content-Type': 'application/json'
        },
        timeout: 5000 // 5s timeout p/ operações críticas
    });

    /**
     * Encrypt plaintext string
     * @returns Ciphertext in cse:v1 format
     */
    static async encrypt(keyName: string, plaintext: string, retries = 3): Promise<string> {
        const b64 = Buffer.from(plaintext).toString('base64');
        
        for (let i = 0; i < retries; i++) {
            try {
                const res = await this.client.post('/v1/encrypt', { key: keyName, plaintext: b64 });
                return res.data.ciphertext;
            } catch (e: any) {
                if (e.response?.status === 503 || e.response?.data?.error === 'engine_sealed') {
                    throw new Error('ENGINE_SEALED');
                }
                if (i === retries - 1) {
                    console.error(`[CryptoService] Encryption failed for key ${keyName} after ${retries} attempts:`, e.message);
                    throw new Error(`Crypto Engine Error: ${JSON.stringify(e.response?.data) || e.message}`);
                }
                // Wait before retry (Exponential backoff)
                await new Promise(res => setTimeout(res, 500 * (i + 1)));
            }
        }
        throw new Error('Retries exceeded'); // Should not reach here
    }

    /**
     * Decrypt ciphertext (cse:v1 format)
     */
    static async decrypt(ciphertext: string): Promise<string> {
        if (!ciphertext || !ciphertext.startsWith('cse:v1:')) {
            // Se não for cse:v1, tratamos como texto claro (Lei 3: Migração limpa em ambiente novo)
            // No futuro, aqui poderíamos ter a lógica de fallback se necessário,
            // mas o plano é instalação limpa.
            return ciphertext;
        }

        try {
            const res = await this.client.post('/v1/decrypt', { ciphertext });
            return Buffer.from(res.data.plaintext, 'base64').toString('utf8');
        } catch (e: any) {
            if (e.response?.status === 503 || e.response?.data?.error === 'engine_sealed') {
                throw new Error('ENGINE_SEALED');
            }
            console.error(`[CryptoService] Decryption failed:`, e.message);
            throw new Error(`Crypto Engine Decrypt Error: ${JSON.stringify(e.response?.data) || e.message}`);
        }
    }

    /**
     * Batch Encryption for multiple values with the same key
     */
    static async encryptBatch(keyName: string, items: string[]): Promise<string[]> {
        try {
            const b64Items = items.map(i => Buffer.from(i).toString('base64'));
            const res = await this.client.post('/v1/encrypt-batch', { key: keyName, items: b64Items });
            return res.data.items;
        } catch (e: any) {
            throw new Error(`Crypto Batch Encrypt Error: ${e.message}`);
        }
    }

    /**
     * Batch Decryption
     */
    static async decryptBatch(items: string[]): Promise<string[]> {
        try {
            const filteredItems = items.filter(i => i && i.startsWith('cse:v1:'));
            if (filteredItems.length === 0) return items; // Ninguém cifrado, devolve como está

            const res = await this.client.post('/v1/decrypt-batch', { items });
            return res.data.items.map((b64: string, index: number) => {
                if (!items[index].startsWith('cse:v1:')) return items[index];
                if (!b64) return '(decryption-failed)';
                return Buffer.from(b64, 'base64').toString('utf8');
            });
        } catch (e: any) {
            throw new Error(`Crypto Batch Decrypt Error: ${e.message}`);
        }
    }

    /**
     * Rotates a key within the engine
     */
    static async rotateKey(keyName: string): Promise<void> {
        try {
            await this.client.post('/v1/keys/rotate', { key: keyName });
        } catch (e: any) {
            throw new Error(`Crypto Rotation Error: ${e.message}`);
        }
    }

    /**
     * Heatlh Check & Status
     */
    static async healthCheck(): Promise<boolean> {
        try {
            const res = await this.client.get('/v1/health');
            return res.data.status === 'ok';
        } catch {
            return false;
        }
    }

    static async getSovereignStatus(): Promise<{ sealed: boolean, engine: string }> {
        try {
            const res = await this.client.get('/v1/sys/status');
            return res.data;
        } catch (e: any) {
            return { sealed: true, engine: 'offline' };
        }
    }

    static async unseal(masterSecret: string): Promise<boolean> {
        try {
            const res = await this.client.post('/v1/sys/unseal', { master_secret: masterSecret });
            return !!res.data.success;
        } catch (e: any) {
            throw new Error(e.response?.data?.error || 'Falha na comunicação com o Cripto Engine');
        }
    }
}
