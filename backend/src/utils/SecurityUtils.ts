
import crypto from 'crypto';

/**
 * SecurityUtils: Cryptographic Bridge for Sensitive Data
 * Implements AES-256-GCM for Application-Layer Encryption.
 */
export class SecurityUtils {
    
    // Derived from INTERNAL_CTRL_SECRET or a persistent system key
    private static getMasterKey(): Buffer {
        const secret = process.env.INTERNAL_CTRL_SECRET || 'cascata_default_fallback_insecure_key_change_me';
        return crypto.createHash('sha256').update(secret).digest();
    }

    /**
     * Encrypts a string (unbox -> box)
     * Returns "iv:authTag:encryptedData" in base64
     */
    static encrypt(text: string): string {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.getMasterKey(), iv);
        
        let encrypted = cipher.update(text, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        
        const authTag = cipher.getAuthTag().toString('base64');
        
        return `${iv.toString('base64')}:${authTag}:${encrypted}`;
    }

    /**
     * Decrypts a boxed string
     */
    static decrypt(boxed: string): string {
        try {
            const [ivBase64, authTagBase64, encryptedBase64] = boxed.split(':');
            const iv = Buffer.from(ivBase64, 'base64');
            const authTag = Buffer.from(authTagBase64, 'base64');
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.getMasterKey(), iv);
            
            decipher.setAuthTag(authTag);
            
            let decrypted = decipher.update(encryptedBase64, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            
            return decrypted;
        } catch (e) {
            throw new Error('Decryption failed: Integrity check or key mismatch.');
        }
    }
}
