/**
 * PayloadCrypto — Application-Layer Encryption Engine (Frontend)
 *
 * Usa EXCLUSIVAMENTE a Web Crypto API nativa do navegador (SubtleCrypto).
 * Zero dependências externas. Zero bundling overhead.
 *
 * Fluxo completo:
 * 1. fetchHandshake()  → pede chave pública ECDH X25519 ao backend
 * 2. encryptLoginPayload() → cifra { email, password } com ECDH + AES-256-GCM
 * 3. decryptLoginResponse() → decifra a resposta { token } do backend
 *
 * A chave privada do frontend NUNCA sai da memória do browser.
 * Após o login, as chaves são descartadas pelo garbage collector.
 */

const CASCATA_CRYPTO_VERSION = 'v1';
const REPLAY_WINDOW_MS = 90 * 1000;

export interface HandshakeResponse {
    sessionId: string;
    serverPublicKey: string;  // Base64 DER — chave pública X25519 do backend
}

export interface EncryptedLoginPayload {
    v: string;                // versão do protocolo (anti-downgrade)
    sessionId: string;
    clientPublicKey: string;  // Base64 DER — chave pública X25519 do frontend
    iv: string;               // AES-GCM init vector (Base64)
    authTag: string;          // tag de integridade GCM (Base64)
    ciphertext: string;       // payload cifrado (Base64)
    timestamp: number;        // Unix ms — anti-replay
}

export interface EncryptedLoginResponse {
    iv: string;
    authTag: string;
    ciphertext: string;
}

interface SessionKeys {
    sharedKey: CryptoKey;
    clientPublicKey: CryptoKey;
    sessionId: string;
}

// ============================================================
// UTILITÁRIOS BASE64 <-> ArrayBuffer (sem btoa/atob limitations)
// ============================================================

const toBase64 = (buf: ArrayBuffer): string => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
};

const fromBase64 = (b64: string): ArrayBuffer => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
};

// ============================================================
// CORE: ECDH X25519 + AES-256-GCM
// ============================================================

/**
 * Busca o handshake do backend e estabelece a sessão criptográfica.
 * Retorna as chaves em memória — NUNCA persistidas.
 */
export async function fetchHandshake(apiBase: string, token?: string): Promise<SessionKeys> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${apiBase}/auth/handshake`, { headers });
    if (!res.ok) throw new Error('Handshake failed: ' + res.status);

    const { sessionId, serverPublicKey }: HandshakeResponse = await res.json();

    // 1. Gerar par ECDH X25519 efêmero no frontend
    const clientKeyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'X25519' } as any,  // X25519 via SubtleCrypto
        false,  // não exportável (nunca vira texto)
        ['deriveKey', 'deriveBits']
    );

    // 2. Importar chave pública do servidor
    const serverPubKey = await crypto.subtle.importKey(
        'spki',
        fromBase64(serverPublicKey),
        { name: 'ECDH', namedCurve: 'X25519' } as any,
        false,
        []  // chave pública: sem usos de derivação
    );

    // 3. Derivar chave AES-256 compartilhada via ECDH
    const rawShared = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: serverPubKey } as any,
        (clientKeyPair as CryptoKeyPair).privateKey,
        256  // 32 bytes = 256 bits
    );

    // 4. HKDF: Deriva a chave AES final (domain separation: 'cascata-login-v1')
    const hkdfKey = await crypto.subtle.importKey(
        'raw', rawShared, { name: 'HKDF' }, false, ['deriveKey']
    );
    const sharedKey = await crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(0),
            info: new TextEncoder().encode('cascata-login-v1'),
        },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,  // nunca exportável
        ['encrypt', 'decrypt']
    );

    return {
        sharedKey,
        clientPublicKey: (clientKeyPair as CryptoKeyPair).publicKey,
        sessionId,
    };
}

/**
 * Cifra o payload de login (email + senha) usando a sessão ECDH.
 * O resultado é um objeto opaco — qualquer interceptação de rede
 * vê apenas base64 sem semântica.
 */
export async function encryptLoginPayload(
    credentials: { email: string; password: string },
    session: SessionKeys
): Promise<EncryptedLoginPayload> {
    // Incluir timestamp para anti-replay
    const plaintext = JSON.stringify({
        ...credentials,
        _ts: Date.now(),
    });

    // IV aleatório de 96 bits (recomendado para AES-GCM)
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Cifrar com AES-256-GCM
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        session.sharedKey,
        new TextEncoder().encode(plaintext)
    );

    // AES-GCM retorna ciphertext + authTag concatenados (authTag nos últimos 16 bytes)
    const encBytes   = new Uint8Array(encrypted);
    const ciphertext = encBytes.slice(0, -16);
    const authTag    = encBytes.slice(-16);

    // Exportar chave pública do cliente para o backend derivar a mesma sharedKey
    const clientPubDer = await crypto.subtle.exportKey('spki', session.clientPublicKey);

    return {
        v:              CASCATA_CRYPTO_VERSION,
        sessionId:      session.sessionId,
        clientPublicKey: toBase64(clientPubDer),
        iv:             toBase64(iv.buffer),
        authTag:        toBase64(authTag.buffer),
        ciphertext:     toBase64(ciphertext.buffer),
        timestamp:      Date.now(),
    };
}

/**
 * Decifra a resposta de login do backend.
 * Usa a mesma sharedKey derivada no handshake — apenas este browser,
 * neste momento, consegue decifrar a resposta.
 */
export async function decryptLoginResponse(
    response: EncryptedLoginResponse,
    session: SessionKeys
): Promise<Record<string, unknown>> {
    const iv         = new Uint8Array(fromBase64(response.iv));
    const authTag    = new Uint8Array(fromBase64(response.authTag));
    const ciphertext = new Uint8Array(fromBase64(response.ciphertext));

    // Recompõe ciphertext||authTag (formato AES-GCM do SubtleCrypto)
    const combined = new Uint8Array(ciphertext.length + authTag.length);
    combined.set(ciphertext);
    combined.set(authTag, ciphertext.length);

    try {
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            session.sharedKey,
            combined
        );

        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        throw new Error('[PayloadCrypto] Response decryption failed — possible tampering detected');
    }
}

/**
 * Função de alto nível: executa o login completo com criptografia de payload.
 *
 * @example
 * const result = await secureLogin('/api/control', 'admin@cascata.io', 'senha123');
 * // result.token — JWT pronto para uso
 */
export async function secureLogin(
    apiBase: string,
    email: string,
    password: string
): Promise<{ token: string; [key: string]: unknown }> {
    // Passo 1: Handshake — obter chaves efêmeras
    const session = await fetchHandshake(apiBase);

    // Passo 2: Cifrar credenciais
    const encryptedPayload = await encryptLoginPayload({ email, password }, session);

    // Passo 3: Enviar payload cifrado
    const res = await fetch(`${apiBase}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(encryptedPayload),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Login failed' }));
        throw new Error(err.error || 'Login failed');
    }

    const encryptedResponse: EncryptedLoginResponse = await res.json();

    // Passo 4: Decifrar resposta (apenas este browser consegue)
    const plainResponse = await decryptLoginResponse(encryptedResponse, session);

    // Passo 5: Chaves AES descartadas pelo GC — a sessão de handshake já não existe
    return plainResponse as { token: string };
}
