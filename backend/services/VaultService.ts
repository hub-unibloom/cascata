
import axios, { AxiosInstance, AxiosError } from 'axios';
import process from 'process';
import { z } from 'zod';

/**
 * Padrão Enterprise: Erros estruturados para rastreabilidade bancária.
 */
export class VaultError extends Error {
  constructor(
    public override message: string,
    public operation: string,
    public statusCode?: number,
    public details?: any
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

/**
 * Esquemas de Validação Modernos (Zod) - Garante integridade absoluta dos dados.
 */
const SecretResponseSchema = z.object({
  data: z.object({
    data: z.record(z.string()),
    metadata: z.object({
      version: z.number(),
      created_time: z.string().datetime(),
    }).optional(),
  }),
});

const TransitResponseSchema = z.object({
  data: z.object({
    ciphertext: z.string().optional(),
    plaintext: z.string().optional(),
  }),
});

const DatabaseCredsSchema = z.object({
  data: z.object({
    username: z.string(),
    password: z.string(),
  }),
});

/**
 * VaultService: O guardião dos segredos do Cascata.
 * Desenvolvido seguindo padrões Enterprise Grade.
 */
export class VaultService {
  private static instance: VaultService;
  private client: AxiosInstance;
  private token: string | null = null;

  private constructor() {
    const vaultAddr = process.env.VAULT_ADDR || 'http://vault:8200';
    this.client = axios.create({
      baseURL: `${vaultAddr}/v1`,
      timeout: 5000,
    });
  }

  public static getInstance(): VaultService {
    if (!VaultService.instance) {
      VaultService.instance = new VaultService();
    }
    return VaultService.instance;
  }

  /**
   * Define o token de acesso (geralmente injetado no boot após unseal).
   */
  public setToken(token: string): void {
    this.token = token;
    this.client.defaults.headers.common['X-Vault-Token'] = token;
  }

  /**
   * Busca um segredo estático (KV Engine v2).
   */
  public async getSecret(path: string): Promise<Record<string, string>> {
    if (!this.token) throw new VaultError('Vault Token not set', 'getSecret');
    
    try {
      const { data } = await this.client.get(`secret/data/${path}`);
      const validated = SecretResponseSchema.parse(data);
      return validated.data.data;
    } catch (error: unknown) {
      throw this.wrapError('getSecret', error);
    }
  }

  /**
   * Criptografia Transitária (Transit Engine).
   * O dado nunca toca o disco como texto claro.
   */
  public async encrypt(keyName: string, plaintext: string): Promise<string> {
    try {
      const base64Plaintext = Buffer.from(plaintext).toString('base64');
      const { data } = await this.client.post(`transit/encrypt/${keyName}`, {
        plaintext: base64Plaintext,
      });
      const validated = TransitResponseSchema.parse(data);
      if (!validated.data.ciphertext) throw new Error('No ciphertext returned');
      return validated.data.ciphertext;
    } catch (error: unknown) {
      throw this.wrapError('encrypt', error);
    }
  }

  /**
   * Descriptografia Transitária.
   */
  public async decrypt(keyName: string, ciphertext: string): Promise<string> {
    try {
      const { data } = await this.client.post(`transit/decrypt/${keyName}`, {
        ciphertext: ciphertext,
      });
      const validated = TransitResponseSchema.parse(data);
      if (!validated.data.plaintext) throw new Error('No plaintext returned');
      return Buffer.from(validated.data.plaintext, 'base64').toString('utf-8');
    } catch (error: unknown) {
      throw this.wrapError('decrypt', error);
    }
  }

  /**
   * Busca credenciais dinâmicas para o Banco de Dados (Database Engine).
   * O Vault cria um usuário temporário no Postgres que expira sozinho.
   */
  public async getDatabaseCredentials(roleName: string): Promise<{ username: string; password: string }> {
    if (!this.token) throw new VaultError('Vault Token not set', 'getDatabaseCredentials');
    
    try {
      const { data } = await this.client.get(`database/creds/${roleName}`);
      const validated = DatabaseCredsSchema.parse(data);
      return {
        username: validated.data.username,
        password: validated.data.password,
      };
    } catch (error: unknown) {
      throw this.wrapError('getDatabaseCredentials', error);
    }
  }

  /**
   * Healthcheck do Vault - Sinergia com o Orquestrador.
   */
  public async isHealthy(): Promise<boolean> {
    try {
      const res = await this.client.get('/sys/health');
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Gerencia erros de forma padronizada para sistemas financeiros.
   */
  private wrapError(operation: string, error: unknown): VaultError {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<any>;
      const message = axiosError.response?.data?.errors?.[0] || axiosError.message;
      return new VaultError(message, operation, axiosError.response?.status, axiosError.response?.data);
    }
    if (error instanceof z.ZodError) {
      return new VaultError('Schema validation failed', operation, 422, error.errors);
    }
    return new VaultError(error instanceof Error ? error.message : 'Unknown error', operation);
  }
}
