export interface DeployWorkerConfig {
  accountId: string;
  workerName: string;
  apiToken: string;
  workerCode: string;
  bindings: WorkerBinding[];
}

export type WorkerBinding =
  | { type: 'd1' | 'kv' | 'r2'; name: string; id: string }
  | { type: 'plain_text'; name: string; text: string }
  | { type: 'secret_text'; name: string; text: string };

export interface CreateD1Config {
  accountId: string;
  apiToken: string;
  databaseName: string;
}

export class CloudflareAPI {
  private baseUrl = 'https://api.cloudflare.com/client/v4';

  async deployWorker(config: DeployWorkerConfig): Promise<{ success: boolean; error?: string }> {
    const { accountId, workerName, apiToken, workerCode, bindings } = config;

    try {
      const formData = new FormData();
      formData.append('worker.js', new Blob([workerCode], { type: 'application/javascript+module' }), 'worker.js');

      const metadata = {
        main_module: 'worker.js',
        compatibility_date: '2024-09-23',
        compatibility_flags: ['nodejs_compat'],
        bindings: bindings.map(b => {
          if (b.type === 'plain_text' || b.type === 'secret_text') {
            return { type: b.type, name: b.name, text: b.text };
          }
          return { type: b.type, name: b.name, id: b.id };
        })
      };
      formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));

      const response = await this.fetchWithRetry(
        `${this.baseUrl}/accounts/${accountId}/workers/scripts/${workerName}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${apiToken}`
          },
          body: formData
        }
      );

      if (!response.ok) {
        const error = await response.text();
        return { success: false, error: `Deploy failed: ${response.status} ${error}` };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async createD1Database(config: CreateD1Config): Promise<{ success: boolean; databaseId?: string; error?: string }> {
    const { accountId, apiToken, databaseName } = config;

    try {
      const response = await this.fetchWithRetry(
        `${this.baseUrl}/accounts/${accountId}/d1/database`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name: databaseName })
        }
      );

      if (!response.ok) {
        const error = await response.text();
        return { success: false, error: `Create D1 failed: ${response.status} ${error}` };
      }

      const data = await response.json() as any;
      return { success: true, databaseId: data.result.uuid };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async executeD1Query(
    accountId: string,
    databaseId: string,
    apiToken: string,
    sql: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.fetchWithRetry(
        `${this.baseUrl}/accounts/${accountId}/d1/database/${databaseId}/query`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ sql })
        }
      );

      if (!response.ok) {
        const error = await response.text();
        return { success: false, error: `Query failed: ${response.status} ${error}` };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async getWorkersSubdomain(accountId: string, apiToken: string): Promise<{ subdomain?: string; error?: string; notProvisioned?: boolean }> {
    try {
      const res = await fetch(
        `${this.baseUrl}/accounts/${accountId}/workers/subdomain`,
        { headers: { 'Authorization': `Bearer ${apiToken}` } }
      );
      if (!res.ok) {
        const text = await res.text();
        // CF returns 404 with code 10007 when the account has never set up a
        // workers.dev subdomain. Surface this as a distinct condition so the
        // caller can provision one instead of failing the whole deploy.
        const notProvisioned = res.status === 404 || /10007/.test(text);
        return { error: `Get subdomain failed: ${res.status} ${text}`, notProvisioned };
      }
      const data = await res.json() as any;
      const subdomain = data.result?.subdomain;
      return subdomain ? { subdomain } : { notProvisioned: true, error: 'No subdomain set on account' };
    } catch (error: any) {
      return { error: error.message };
    }
  }

  async setWorkersSubdomain(accountId: string, apiToken: string, subdomain: string): Promise<{ success: boolean; error?: string; conflict?: boolean }> {
    try {
      const res = await fetch(
        `${this.baseUrl}/accounts/${accountId}/workers/subdomain`,
        {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ subdomain })
        }
      );
      if (!res.ok) {
        const text = await res.text();
        // 409/already-taken — caller can retry with a different name.
        const conflict = res.status === 409 || /already.*(taken|exists|use)/i.test(text);
        return { success: false, error: `Set subdomain failed: ${res.status} ${text}`, conflict };
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async enableWorkersDev(accountId: string, workerName: string, apiToken: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(
        `${this.baseUrl}/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true })
        }
      );
      if (!res.ok) {
        const error = await res.text();
        return { success: false, error: `Enable workers.dev failed: ${res.status} ${error}` };
      }
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async verifyToken(accountId: string, apiToken: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch(
        `${this.baseUrl}/accounts/${accountId}/workers/scripts`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiToken}`
          }
        }
      );

      if (response.status === 403 || response.status === 401) {
        return { valid: false, error: 'Invalid token or insufficient permissions' };
      }

      return { valid: response.ok };
    } catch (error: any) {
      return { valid: false, error: error.message };
    }
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries = 5
  ): Promise<Response> {
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        const response = await fetch(url, options);

        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
          console.log(`Rate limited, retrying in ${retryAfter}s (attempt ${attempt + 1}/${maxRetries})`);
          await this.sleep(retryAfter * 1000);
          attempt++;
          continue;
        }

        return response;
      } catch (error) {
        if (attempt === maxRetries - 1) throw error;
        await this.sleep(5000 * Math.pow(2, attempt));
        attempt++;
      }
    }

    throw new Error('Max retries exceeded');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
