import fs from 'fs';
import path from 'path';
import os from 'os';

export interface DailyUsage {
  date: string; // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  requests: number;
  providerUsage?: Record<string, ProviderUsage>;
}

export interface ProviderUsage {
  requests: number;
  tokens: number;
}

export interface UsageData {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  providerUsage: Record<string, number | ProviderUsage>; // provider -> usage
  daily: Record<string, DailyUsage>;
  sessions: number; // Count of proxy starts
  firstUsed: number; // timestamp
}

export class UsageTracker {
  private data: UsageData;
  private filePath: string;
  private saveTimeout: NodeJS.Timeout | null = null;
  private sessionProviderUsage: Record<string, ProviderUsage> = {};

  private initialized = false;

  constructor() {
    const dir = path.join(os.homedir(), '.keymux');
    this.filePath = path.join(dir, 'usage.json');
    this.data = {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheTokens: 0,
      providerUsage: {},
      daily: {},
      sessions: 0,
      firstUsed: Date.now(),
    };
  }

  private ensureInitialized() {
    if (this.initialized) return;
    this.initialized = true;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.data = this.loadData();
    this.data.sessions += 1;
    this.saveData();
  }

  private loadData(): UsageData {
    const defaultData: UsageData = {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheTokens: 0,
      providerUsage: {},
      daily: {},
      sessions: 0,
      firstUsed: Date.now(),
    };
    if (fs.existsSync(this.filePath)) {
      try {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(content);

        if (parsed && typeof parsed === 'object') {
          const providerUsage: Record<string, ProviderUsage> = {};
          if (parsed.providerUsage) {
            for (const [k, v] of Object.entries(parsed.providerUsage)) {
              if (typeof v === 'number') {
                providerUsage[k] = { requests: v, tokens: 0 };
              } else {
                providerUsage[k] = v as ProviderUsage;
              }
            }
          }

          return { ...defaultData, ...parsed, providerUsage, daily: parsed.daily || {} };
        }
      } catch (e) {
        // ignore
      }
    }
    return defaultData;
  }

  private saveData() {
    try {
      // Cross-process merge strategy: re-read disk state before writing
      if (fs.existsSync(this.filePath)) {
         try {
           const diskContent = fs.readFileSync(this.filePath, 'utf-8');
           const diskData = JSON.parse(diskContent);
           if (diskData.totalRequests > this.data.totalRequests) {
              this.data.totalRequests = diskData.totalRequests;
              // We could deep merge here, but for now just sync the totals to prevent losing concurrent CLI writes
           }
         } catch (e) {}
      }

      const tempPath = this.filePath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2));
      fs.renameSync(tempPath, this.filePath);
    } catch (e) {
      // ignore
    }
  }

  private scheduleSave() {
    if (!this.saveTimeout) {
      this.saveTimeout = setTimeout(() => {
        this.saveData();
        this.saveTimeout = null;
      }, 5000); // Save every 5s if active
    }
  }

  public recordRequest(provider: string, inputTokens: number, outputTokens: number, cacheTokens: number = 0) {
    this.ensureInitialized();
    const dateStr = new Date().toISOString().split('T')[0] as string;

    this.data.totalRequests += 1;
    this.data.totalInputTokens += inputTokens;
    this.data.totalOutputTokens += outputTokens;
    this.data.totalCacheTokens += cacheTokens;

    if (!this.data.providerUsage[provider]) {
      this.data.providerUsage[provider] = { requests: 0, tokens: 0 };
    } else if (typeof this.data.providerUsage[provider] === 'number') {
      this.data.providerUsage[provider] = { requests: this.data.providerUsage[provider] as number, tokens: 0 };
    }
    const provUsage = this.data.providerUsage[provider] as ProviderUsage;
    provUsage.requests += 1;
    provUsage.tokens += (inputTokens + outputTokens);

    if (!this.data.daily[dateStr]) {
      this.data.daily[dateStr] = {
        date: dateStr,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        requests: 0,
      };
    }

    this.data.daily[dateStr].inputTokens += inputTokens;
    this.data.daily[dateStr].outputTokens += outputTokens;
    this.data.daily[dateStr].cacheTokens += cacheTokens;
    this.data.daily[dateStr].requests += 1;

    // Update sessionProviderUsage
    if (!this.sessionProviderUsage[provider]) {
      this.sessionProviderUsage[provider] = { requests: 0, tokens: 0 };
    }
    this.sessionProviderUsage[provider].requests += 1;
    this.sessionProviderUsage[provider].tokens += (inputTokens + outputTokens);

    // Update daily providerUsage
    if (!this.data.daily[dateStr].providerUsage) {
      this.data.daily[dateStr].providerUsage = {};
    }
    if (!this.data.daily[dateStr].providerUsage![provider]) {
      this.data.daily[dateStr].providerUsage![provider] = { requests: 0, tokens: 0 };
    }
    this.data.daily[dateStr].providerUsage![provider].requests += 1;
    this.data.daily[dateStr].providerUsage![provider].tokens += (inputTokens + outputTokens);

    this.scheduleSave();
  }

  public getSessionUsage(): Record<string, ProviderUsage> {
    this.ensureInitialized();
    return this.sessionProviderUsage;
  }

  public getTodayUsage(): Record<string, ProviderUsage> {
    this.ensureInitialized();
    const todayDateStr = new Date().toISOString().split('T')[0] as string;
    return this.data.daily[todayDateStr]?.providerUsage || {};
  }

  public getData(): UsageData {
    this.ensureInitialized();
    return this.data;
  }
}

let _globalTracker: UsageTracker | null = null;
export const globalUsageTracker = new Proxy({} as UsageTracker, {
  get: (target, prop) => {
    if (!_globalTracker) _globalTracker = new UsageTracker();
    return (_globalTracker as any)[prop];
  }
});
