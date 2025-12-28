
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
  private static CONTROLLER_URL = 'http://nginx_controller:3001'; // Ensure matching docker-compose service name
  private static INTERNAL_SECRET = process.env.INTERNAL_CTRL_SECRET || 'fallback_secret';

  private static validateDomain(domain: string): boolean {
    if (!domain || typeof domain !== 'string') return false;
    const clean = domain.trim();
    if (clean.includes(' ')) return false;
    if (!clean.includes('.')) return false;
    const regex = /^([a-zA-Z0-9\u00a1-\uffff]([a-zA-Z0-9\u00a1-\uffff-]{0,61}[a-zA-Z0-9\u00a1-\uffff])?\.)+[a-zA-Z\u00a1-\uffff]{2,}$/;
    return regex.test(clean);
  }

  /**
   * Solicita reload do Nginx via Sidecar (Isolamento de Docker Socket)
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
              console.error(`[CertService] Host '${this.CONTROLLER_URL}' not found. Check docker-compose network aliases.`);
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

      // Atomic Write Strategy: Write to temp folder then swap? 
      // For now, clean rebuild is acceptable as backend writes are fast.
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
      
      await this.reloadNginx(); // Call Sidecar
      
    } catch (e) {
      console.error('[CertService] Failed to rebuild configs:', e);
    }
  }

  public static async deleteCertificate(domain: string, systemPool: Pool): Promise<void> {
      const domainDir = path.join(this.basePath, domain);
      if (fs.existsSync(domainDir)) {
          fs.rmSync(domainDir, { recursive: true, force: true });
          const archiveDir = path.join('/etc/letsencrypt/archive', domain);
          if (fs.existsSync(archiveDir)) fs.rmSync(archiveDir, { recursive: true, force: true });
          const renewalFile = path.join('/etc/letsencrypt/renewal', `${domain}.conf`);
          if (fs.existsSync(renewalFile)) fs.unlinkSync(renewalFile);
          
          await this.rebuildNginxConfigs(systemPool);
      } else {
          throw new Error("Certificado não encontrado.");
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

    if (provider === 'manual' || provider === 'cloudflare_pem' as any) {
        if (!manualData?.cert || !manualData?.key) throw new Error("Cert/Key required.");
        if (!fs.existsSync(this.basePath)) fs.mkdirSync(this.basePath, { recursive: true });
        if (!fs.existsSync(domainDir)) fs.mkdirSync(domainDir, { recursive: true });
        
        fs.writeFileSync(path.join(domainDir, 'fullchain.pem'), manualData.cert.trim());
        fs.writeFileSync(path.join(domainDir, 'privkey.pem'), manualData.key.trim());
        
        await finishSetup();
        return { success: true, message: "Certificados manuais instalados." };
    }

    if (provider === 'certbot' || provider === 'letsencrypt' as any) {
        if (!email.includes('@')) throw new Error("Email inválido.");
        return new Promise((resolve, reject) => {
            console.log(`[CertService] Executing Certbot for ${cleanDomain}...`);
            if (!fs.existsSync(this.webrootPath)) fs.mkdirSync(this.webrootPath, { recursive: true });
            
            const certbot = spawn('certbot', [
                'certonly', '--webroot', '-w', this.webrootPath, '-d', cleanDomain,
                '--email', email, '--agree-tos', '--no-eff-email', '--force-renewal', '--non-interactive'
            ]);
            
            let log = '';
            certbot.stdout.on('data', d => log += d.toString());
            certbot.stderr.on('data', d => log += d.toString());
            
            certbot.on('close', async (code) => {
                if (code === 0) {
                    try {
                        await finishSetup();
                        resolve({ success: true, message: "Certificado gerado com sucesso!" });
                    } catch (e: any) { 
                        reject(new Error(`Certbot OK, mas falha na pós-configuração: ${e.message}`)); 
                    }
                } else {
                    reject(new Error(`Falha no Certbot (Code ${code}): ${log.slice(-300)}`));
                }
            });
            certbot.on('error', (err) => reject(new Error(`Spawn Error: ${err.message}`)));
        });
    }
    throw new Error("Provider desconhecido.");
  }
}
