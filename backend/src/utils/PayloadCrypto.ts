
import crypto from 'crypto';

/**
 * PayloadCrypto — Application-Layer Encryption Engine (Backend)
 *
 * Fluxo de Login Seguro:
 * 1. Frontend solicita publicKey via GET /auth/handshake
 * 2. Backend responde com: { publicKey: "...", sessionId: "..." }
 *    → Par ECDH X25519 efêmero (dura apenas aquele login, 5 minutos)
 * 3. Frontend gera sua chave ECDH X25519 própria
 * 4. Ambos derivam a mesma CHAVE COMPARTILHADA via ECDH
 * 5. Frontend cifra payload JSON com AES-256-GCM + timestamp (anti-replay)
 * 6. Backend recebe, deriva a mesma chave compartilhada, decifra e valida
 * 7. Backend cifra a resposta (JWT) com a mesma chave compartilhada
 * 8. Frontend decifra a resposta com a chave que ele mesmo gerou
 *
 * Resultado: Nem a chave privada do backend nem a do frontend trafega pela rede.
 * Um interceptador de rede vê apenas lixo criptográfico.
 *
 * ANTI-REPLAY: O payload inclui timestamp. O backend rejeita payloads com
 * timestamp fora de ±90 segundos da hora atual.
 *
 * EPHEMERAL SESSIONS: Cada sessão de handshake dura 5 minutos no Dragonfly.
 * Após o login, a sessão é destruída. Impossível reutilizar.
 */

const ALGO = 'aes-256-gcm';
const REPLAY_WINDOW_MS = 90 * 1000; // ±90 segundos

export interface HandshakeSession {
    sessionId: string;
    serverPublicKey: string;   // Base64 — enviado ao frontend
    serverPrivateKey: string;  // Base64 — NUNCA sai do backend
    createdAt: number;
}

export interface EncryptedPayload {
    sessionId: string;         // Liga ao handshake
    clientPublicKey: string;   // Chave pública ECDH do frontend (Base64)
    iv: string;                // Vetor de inicialização AES-GCM (Base64)
    authTag: string;           // Tag de autenticação GCM (Base64)
    ciphertext: string;        // Payload cifrado (Base64)
    timestamp: number;         // Unix ms — anti-replay
}

export class PayloadCrypto {

    /**
     * Retorna a "Digital Fingerprint" única deste servidor
     * baseada no INTERNAL_CTRL_SECRET. Isso garante que a fórmula
     * HKDF seja matematicamente única para cada instalação.
     */
    static getServerFingerprint(): string {
        const secret = process.env.INTERNAL_CTRL_SECRET || 'fallback-cascata-secret-fingerprint';
        return crypto.createHash('sha256').update(secret).digest('hex').substring(0, 16);
    }

    /**
     * Cria uma sessão de handshake:
     * Gera par de chaves ECDH (P-256) efêmero para este login.
     * A sessão deve ser armazenada no Dragonfly com TTL de 5 minutos.
     */
    static createHandshakeSession(): HandshakeSession {
        // P-256 (prime256v1) — Extrema compatibilidade mobile/desktop
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
            namedCurve: 'prime256v1',
            publicKeyEncoding:  { type: 'spki',  format: 'der' },
            privateKeyEncoding: { type: 'pkcs8', format: 'der' },
        });

        return {
            sessionId:       crypto.randomBytes(32).toString('hex'),
            serverPublicKey:  publicKey.toString('base64'),
            serverPrivateKey: privateKey.toString('base64'),
            createdAt:        Date.now(),
        };
    }

    /**
     * Deriva a chave AES-256 compartilhada usando ECDH P-256.
     * A chave resultante é idêntica tanto no backend quanto no frontend.
     */
    static deriveSharedKey(
        serverPrivateKeyB64: string,
        clientPublicKeyB64: string
    ): Buffer {
        const serverPrivKey = crypto.createPrivateKey({
            key: Buffer.from(serverPrivateKeyB64, 'base64'),
            format: 'der',
            type: 'pkcs8',
        });

        const clientPubKey = crypto.createPublicKey({
            key: Buffer.from(clientPublicKeyB64, 'base64'),
            format: 'der',
            type: 'spki',
        });

        // ECDH: Gera o segredo compartilhado (P-256)
        const sharedSecret = crypto.diffieHellman({
            privateKey: serverPrivKey,
            publicKey: clientPubKey,
        });

        const fingerprint = PayloadCrypto.getServerFingerprint();

        // HKDF: Deriva uma chave AES-256 a partir do segredo compartilhado
        // Usa o fingerprint do servidor como domínio (info)
        const hkdfResult = crypto.hkdfSync(
            'sha256',
            sharedSecret,
            Buffer.alloc(0),                                // salt (vazio, segredo já é forte)
            Buffer.from(`cascata-v2-${fingerprint}`),       // info / domain separator ÚNICO
            32                                              // 256 bits para AES-256
        );

        return Buffer.from(hkdfResult);
    }

    /**
     * Decifra um payload recebido do frontend.
     * Valida:
     *   - Autenticidade da sessão (sessionId)
     *   - Janela anti-replay (timestamp ±90s)
     *   - Integridade AES-GCM (authTag)
     */
    static decryptPayload(
        encryptedPayload: EncryptedPayload,
        sharedKey: Buffer
    ): Record<string, unknown> {
        // ANTI-REPLAY: timestamp deve estar dentro da janela
        const now = Date.now();
        const diff = Math.abs(now - encryptedPayload.timestamp);
        if (diff > REPLAY_WINDOW_MS) {
            throw new Error(`[PayloadCrypto] Payload expired or replay detected. Drift: ${diff}ms`);
        }

        try {
            const iv      = Buffer.from(encryptedPayload.iv,         'base64');
            const authTag = Buffer.from(encryptedPayload.authTag,     'base64');
            const data    = Buffer.from(encryptedPayload.ciphertext,  'base64');

            const decipher = crypto.createDecipheriv(ALGO, sharedKey, iv);
            decipher.setAuthTag(authTag);

            const decrypted = Buffer.concat([
                decipher.update(data),
                decipher.final()
            ]).toString('utf8');

            return JSON.parse(decrypted) as Record<string, unknown>;
        } catch (e: any) {
            throw new Error(`[PayloadCrypto] Decryption failed: ${e.message}`);
        }
    }

    /**
     * Cifra a resposta do servidor (ex: JWT token) para o frontend.
     * Usa a mesma chave compartilhada derivada do ECDH.
     * O frontend usa sua própria chave privada para derivar a mesma chave e decifrar.
     */
    static encryptResponse(
        payload: Record<string, unknown>,
        sharedKey: Buffer
    ): { iv: string; authTag: string; ciphertext: string } {
        const iv     = crypto.randomBytes(12); // 96 bits para GCM
        const cipher = crypto.createCipheriv(ALGO, sharedKey, iv);

        const data = JSON.stringify(payload);
        const encrypted = Buffer.concat([
            cipher.update(Buffer.from(data, 'utf8')),
            cipher.final()
        ]);

        return {
            iv:         iv.toString('base64'),
            authTag:    cipher.getAuthTag().toString('base64'),
            ciphertext: encrypted.toString('base64'),
        };
    }

    /**
     * Valida o OTP TOTP (RFC 6238, HMAC-SHA1, janela ±1 step = ±30s)
     * Compatible com Google Authenticator e Microsoft Authenticator.
     */
    static validateTOTP(secretB32: string, userCode: string): boolean {
        if (!secretB32 || !userCode) return false;
        if (!/^\d{6}$/.test(userCode)) return false;

        try {
            // Decodificar Base32 → Buffer de bytes
            const key = this.base32Decode(secretB32);

            // Verificar janela ±1 step (tolerância de ±30 segundos de clock drift)
            const now = Math.floor(Date.now() / 1000);
            for (const offset of [-1, 0, 1]) {
                const counter = Math.floor((now + offset * 30) / 30);
                const expected = this.hotp(key, counter);
                if (expected === userCode) return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    // HOTP RFC 4226
    private static hotp(key: Buffer, counter: number): string {
        const msg = Buffer.alloc(8);
        // Big-endian 64-bit counter
        const high = Math.floor(counter / 0x100000000);
        const low  = counter >>> 0;
        msg.writeUInt32BE(high, 0);
        msg.writeUInt32BE(low,  4);

        const hmac   = crypto.createHmac('sha1', key).update(msg).digest();
        const offset = hmac[hmac.length - 1] & 0x0f;
        const code   = (
            ((hmac[offset]     & 0x7f) << 24) |
            ((hmac[offset + 1] & 0xff) << 16) |
            ((hmac[offset + 2] & 0xff) << 8)  |
             (hmac[offset + 3] & 0xff)
        ) % 1_000_000;

        return String(code).padStart(6, '0');
    }

    // Base32 Decoder (RFC 4648)
    private static base32Decode(input: string): Buffer {
        const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const cleaned  = input.toUpperCase().replace(/=+$/, '');
        let bits = 0;
        let value = 0;
        const output: number[] = [];

        for (const char of cleaned) {
            const idx = ALPHABET.indexOf(char);
            if (idx < 0) throw new Error(`Invalid Base32 character: ${char}`);
            value = (value << 5) | idx;
            bits  += 5;
            if (bits >= 8) {
                output.push((value >>> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        return Buffer.from(output);
    }
}
