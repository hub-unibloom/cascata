
import axios, { AxiosInstance } from 'axios';
import process from 'process';

/**
 * Interface para representar a resposta de um segredo do Vault.
 */
interface VaultSecretResponse {
  data: {
    data: Record<string, string>;
    metadata: {
      created_time: string;
      deletion_time: string;
      destroyed: boolean;
      version: number;
    };
  };
}

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
    try {
      if (!this.token) throw new Error('Vault Token not set');
      
      const response = await this.client.get<VaultSecretResponse>(`secret/data/${path}`);
      return response.data.data.data;
    } catch (error: unknown) {
      this.handleError('getSecret', error);
      throw error;
    }
  }

  /**
   * Criptografia Transitária (Transit Engine).
   * O dado nunca toca o disco como texto claro.
   */
  public async encrypt(keyName: string, plaintext: string): Promise<string> {
    try {
      const base64Plaintext = Buffer.from(plaintext).toString('base64');
      const response = await this.client.post(`transit/encrypt/${keyName}`, {
        plaintext: base64Plaintext,
      });
      return response.data.data.ciphertext;
    } catch (error: unknown) {
      this.handleError('encrypt', error);
      throw error;
    }
  }

  /**
   * Descriptografia Transitária.
   */
  public async decrypt(keyName: string, ciphertext: string): Promise<string> {
    try {
      const response = await this.client.post(`transit/decrypt/${keyName}`, {
        ciphertext: ciphertext,
      });
      const base64Plaintext = response.data.data.plaintext;
      return Buffer.from(base64Plaintext, 'base64').toString('utf-8');
    } catch (error: unknown) {
      this.handleError('decrypt', error);
      throw error;
    }
  }

  /**
   * Busca credenciais dinâmicas para o Banco de Dados (Database Engine).
   * O Vault cria um usuário temporário no Postgres que expira sozinho.
   */
  public async getDatabaseCredentials(roleName: string): Promise<{ username: string; password: string }> {
    try {
      if (!this.token) throw new Error('Vault Token not set');
      
      const response = await this.client.get(`database/creds/${roleName}`);
      return {
        username: response.data.data.username,
        password: response.data.data.password,
      };
    } catch (error: unknown) {
      this.handleError('getDatabaseCredentials', error);
      throw error;
    }
  }

  /**
   * Gerencia erros de forma padronizada, evitando o uso de 'any'.
   */
  private handleError(operation: string, error: unknown): void {
    if (axios.isAxiosError(error)) {
      console.error(`[VaultService] ${operation} failed:`, {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });
    } else if (error instanceof Error) {
      console.error(`[VaultService] ${operation} error:`, error.message);
    } else {
      console.error(`[VaultService] ${operation} unknown error:`, error);
    }
  }
}
