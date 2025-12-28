
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { Pool } from 'pg';
import axios from 'axios';

export type CertProvider = 'letsencrypt' | 'certbot' | 'manual' | 'cloudflare_pem';

/**
 * CertificateService
 * Gerencia a emissão, renovação e instalação de certificados SSL.
 * Comunica-se com o Nginx-Controller para reloads seguros.
 */
export class CertificateService {
  private static basePath = '/etc/letsencrypt/live'; 
  private static systemCertPath = '/etc/letsencrypt/live/system';
  private static webrootPath = '/var/www/html';
  private static nginxDynamicRoot = '/etc/nginx/conf.d/dynamic';
  
  // Sidecar Configuration
  private static CONTROLLER_URL = 'http://nginx_controller:3001'; 
  private static INTERNAL_SECRET = process.env.INTERNAL_CTRL_SECRET || 'fallback_secret';

  private static validateDomain(domain: string): boolean {
    if (!domain || typeof domain !== 'string') return false;
    const clean = domain.trim();
    if (clean.includes(' ')) return false;
    if (!clean.includes('.')) return false;
    // Regex permissivo para subdomínios e TLDs
    const regex = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9](?:\.[a-zA-Z]{2,})+$/;
    return regex.test(clean) || clean.includes('localhost'); // Allow localhost for dev
  }

  /**
   * Solicita reload do Nginx via Sidecar
   */
  public static async reloadNginx() {
      try {
          console.log('[CertService] Requesting Nginx reload via Controller...');
          await axios.post(`${this.CONTROLLER_URL}/reload`, {}, {
              headers: { 'x-internal-secret': this.INTERNAL_SECRET }
          });
          console.log('[CertService] Nginx reload signal sent.');
      } catch (e: any) {
          console.error(`[CertService] CRITICAL: Failed to reload Nginx via Sidecar.`);
          if (e.code === 'ENOTFOUND') {
              console.error(`[CertService] Host '${this.CONTROLLER_URL}' not found.`);
          } else if (e.response) {
              console.error(`[CertService] Controller responded with ${e.response.status}:`, e.response.data);
          } else {
              console.error(`[CertService] Error details: ${e.message}`);
          }
      }
  }

  public static async ensureSystemCert() {
    try {
        if (!fs.existsSync(this.systemCertPath)) {
            fs.mkdirSync(this.systemCertPath, { recursive: true });
        }
        
        const certFile = path.join(this.systemCertPath, 'fullchain.pem');
        const keyFile = path.join(this.systemCertPath, 'privkey.pem');

        if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
            console.log('[CertService] Creating fallback self-signed certificate...');
            execSync(`openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout ${keyFile} -out ${certFile} -subj "/C=US/ST=State/L=City/O=Cascata/CN=localhost"`, { stdio: 'ignore' });
        }
    } catch (e) {
        console.error('[CertService] Failed to ensure system cert:', e);
    }
  }

  private static syncToSystem(sourceDir: string) {
      try {
          if (!fs.existsSync(this.systemCertPath)) fs.mkdirSync(this.systemCertPath, { recursive: true });
          const realCertPath = fs.realpathSync(path.join(sourceDir, 'fullchain.pem'));
          const realKeyPath = fs.realpathSync(path.join(sourceDir, 'privkey.pem'));
          fs.copyFileSync(realCertPath, path.join(this.systemCertPath, 'fullchain.pem'));
          fs.copyFileSync(realKeyPath, path.join(this.systemCertPath, 'privkey.pem'));
      } catch (e) {
          console.error('[CertService] Sync failed:', e);
          throw new Error("Falha ao aplicar certificado no sistema.");
      }
  }

  public static async rebuildNginxConfigs(systemPool: Pool) {
    console.log('[CertService] Rebuilding Nginx dynamic configurations...');
    try {
      if (!fs.existsSync(this.nginxDynamicRoot)) fs.mkdirSync(this.nginxDynamicRoot, { recursive: true });

      const oldFiles = fs.readdirSync(this.nginxDynamicRoot);
      for (const file of oldFiles) {
        if (file.endsWith('.conf')) fs.unlinkSync(path.join(this.nginxDynamicRoot, file));
      }

      const result = await systemPool.query('SELECT slug, custom_domain, ssl_certificate_source FROM system.projects WHERE custom_domain IS NOT NULL');
      
      for (const proj of result.rows) {
        if (!proj.custom_domain) continue;

        const certDomain = proj.ssl_certificate_source || proj.custom_domain;
        const certPath = path.join(this.basePath, certDomain);
        
        if (fs.existsSync(path.join(certPath, 'fullchain.pem')) && fs.existsSync(path.join(certPath, 'privkey.pem'))) {
          
          const configContent = `
server {
    listen 443 ssl;
    server_name ${proj.custom_domain};
    server_tokens off;
    ssl_certificate /etc/letsencrypt/live/${certDomain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${certDomain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    client_max_body_size 100M;

    # CRITICAL: Allow Certbot challenges even via HTTPS (Fix for Cloudflare Redirects)
    location /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }

    location / {
        limit_req zone=api_limit burst=50 nodelay;
        limit_conn conn_limit 50;
        proxy_pass http://cascata-backend-data:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;
          fs.writeFileSync(path.join(this.nginxDynamicRoot, `${proj.slug}.conf`), configContent.trim());
        }
      }
      
      await this.reloadNginx(); 
      
    } catch (e) {
      console.error('[CertService] Failed to rebuild configs:', e);
    }
  }

  public static async deleteCertificate(domain: string, systemPool: Pool): Promise<void> {
      const cleanDomain = domain.trim().toLowerCase();
      // Remove da pasta live
      const domainDir = path.join(this.basePath, cleanDomain);
      
      if (fs.existsSync(domainDir)) {
          // Certbot cria symlinks, precisamos remover archive e renewal config também
          try {
              fs.rmSync(domainDir, { recursive: true, force: true });
              
              const archiveDir = path.join('/etc/letsencrypt/archive', cleanDomain);
              if (fs.existsSync(archiveDir)) fs.rmSync(archiveDir, { recursive: true, force: true });
              
              const renewalFile = path.join('/etc/letsencrypt/renewal', `${cleanDomain}.conf`);
              if (fs.existsSync(renewalFile)) fs.unlinkSync(renewalFile);
              
              console.log(`[CertService] Removed cert files for ${cleanDomain}`);
          } catch(e) {
              console.error(`[CertService] Error cleaning up cert files:`, e);
          }
          
          await this.rebuildNginxConfigs(systemPool);
      } else {
          throw new Error("Certificado não encontrado no disco.");
      }
  }

  public static async detectEnvironment(): Promise<any> {
    const domains: string[] = [];
    if (fs.existsSync(this.basePath)) {
      try {
        const dirs = fs.readdirSync(this.basePath).filter(f => 
          fs.lstatSync(path.join(this.basePath, f)).isDirectory() && f !== 'system'
        );
        domains.push(...dirs);
      } catch (e) { console.error("Error scanning certs:", e); }
    }
    let hasCertbot = false;
    try { if (fs.existsSync('/usr/bin/certbot') || fs.existsSync('/usr/local/bin/certbot')) hasCertbot = true; } catch(e) {}
    return { provider: hasCertbot ? 'certbot' : 'manual', active: domains.length > 0, domains, message: `${domains.length} domínios configurados.` };
  }

  public static async requestCertificate(
      domain: string, 
      email: string, 
      provider: CertProvider, 
      systemPool: Pool,
      manualData?: { cert: string, key: string }, 
      isSystem: boolean = false
  ): Promise<{ success: boolean, message: string }> {
    
    if (!this.validateDomain(domain)) throw new Error("Domínio inseguro.");
    const cleanDomain = domain.trim().toLowerCase();
    const domainDir = path.join(this.basePath, cleanDomain);
    
    const finishSetup = async () => {
      if (isSystem) this.syncToSystem(domainDir);
      await this.rebuildNginxConfigs(systemPool);
    };

    // MANUAL / CLOUDFLARE PEM UPLOAD
    if (provider === 'manual' || provider === 'cloudflare_pem' as any) {
        if (!manualData?.cert || !manualData?.key) throw new Error("Cert/Key required.");
        if (!fs.existsSync(this.basePath)) fs.mkdirSync(this.basePath, { recursive: true });
        if (!fs.existsSync(domainDir)) fs.mkdirSync(domainDir, { recursive: true });
        
        fs.writeFileSync(path.join(domainDir, 'fullchain.pem'), manualData.cert.trim());
        fs.writeFileSync(path.join(domainDir, 'privkey.pem'), manualData.key.trim());
        
        await finishSetup();
        return { success: true, message: "Certificados manuais instalados." };
    }

    // CERTBOT / LET'S ENCRYPT
    if (provider === 'certbot' || provider === 'letsencrypt' as any) {
        if (!email.includes('@')) throw new Error("Email inválido.");
        
        console.log(`[CertService] Starting Certbot process for ${cleanDomain}...`);
        
        // 1. Prepare Webroot and Test Write
        try {
            if (!fs.existsSync(this.webrootPath)) fs.mkdirSync(this.webrootPath, { recursive: true });
            
            const acmeDir = path.join(this.webrootPath, '.well-known', 'acme-challenge');
            fs.mkdirSync(acmeDir, { recursive: true });
            
            // Test Write Permission
            const testFile = path.join(acmeDir, 'test-ping');
            fs.writeFileSync(testFile, 'ok');
            fs.unlinkSync(testFile);
            console.log('[CertService] Webroot write test passed.');
        } catch (e: any) {
            console.error('[CertService] Webroot permission error:', e);
            throw new Error(`Falha de permissão no webroot: ${e.message}. Verifique volumes.`);
        }

        return new Promise((resolve, reject) => {
            // 2. Spawn Certbot
            const certbot = spawn('certbot', [
                'certonly', 
                '--webroot', 
                '-w', this.webrootPath, 
                '-d', cleanDomain,
                '--email', email, 
                '--agree-tos', 
                '--no-eff-email', 
                '--force-renewal', 
                '--non-interactive',
                // Important: Prevent certbot from asking for input
                '--text' 
            ]);
            
            let stdoutLog = '';
            let stderrLog = '';
            
            certbot.stdout.on('data', d => stdoutLog += d.toString());
            certbot.stderr.on('data', d => stderrLog += d.toString());
            
            certbot.on('close', async (code) => {
                if (code === 0) {
                    try {
                        console.log(`[CertService] Certbot success for ${cleanDomain}`);
                        await finishSetup();
                        resolve({ success: true, message: "Certificado gerado com sucesso!" });
                    } catch (e: any) { 
                        reject(new Error(`Certbot OK, mas falha na pós-configuração: ${e.message}`)); 
                    }
                } else {
                    console.error(`[CertService] Certbot Failed (Code ${code})`);
                    console.error(`STDOUT: ${stdoutLog}`);
                    console.error(`STDERR: ${stderrLog}`);
                    
                    // User friendly error extraction
                    let friendlyError = `Falha no Certbot (Code ${code}).`;
                    if (stderrLog.includes('404')) friendlyError += " O servidor de validação não encontrou o arquivo (404). Verifique se o domínio aponta para este IP.";
                    if (stderrLog.includes('403')) friendlyError += " Acesso negado (403). Firewall ou Cloudflare pode estar bloqueando.";
                    if (stderrLog.includes('Connection refused')) friendlyError += " Conexão recusada.";
                    
                    reject(new Error(friendlyError + ` Logs: ${stderrLog.slice(-200)}`));
                }
            });
            
            certbot.on('error', (err) => reject(new Error(`Spawn Error: ${err.message}`)));
        });
    }
    
    throw new Error("Provider desconhecido.");
  }
}
