export interface DeployWorkerConfig {
  accountId: string;
  workerName: string;
  apiToken: string;
  workerCode: string;
  bindings: WorkerBinding[];
}

export interface WorkerBinding {
  type: 'd1' | 'kv' | 'r2';
  name: string;
  id: string;
}

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
        bindings: bindings.map(b => ({
          type: b.type,
          name: b.name,
          id: b.id
        }))
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
