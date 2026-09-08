import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import * as http from 'http';

// Config & State
const configPath = path.join(os.homedir(), '.keymux', 'config.json');
let config = readConfig();
let draftConfig = JSON.parse(JSON.stringify(config));
let flashMessage = '';

function readConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {}
  return { defaultProvider: null, defaultModel: '', keys: { openrouter: [], nvidia: [] } };
}

function saveConfig(cfg: any) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  } catch (e) {}
}

async function triggerReload() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3002,
      path: '/v1/keymux/reload',
      method: 'POST'
    }, (res) => { resolve(true); });
    req.on('error', () => { resolve(false); });
    req.end();
  });
}

function readUsageData() {
  const usagePath = path.join(os.homedir(), '.keymux', 'usage.json');
  try {
    if (fs.existsSync(usagePath)) {
      return JSON.parse(fs.readFileSync(usagePath, 'utf8'));
    }
  } catch (e) {}
  return { totalInputTokens: 0, totalOutputTokens: 0, totalCacheTokens: 0, providerUsage: {}, daily: {}, sessions: 0 };
}

function formatTokens(num: number) {
  if (num > 1000000) return (num / 1000000).toFixed(1) + 'm';
  if (num > 1000) return (num / 1000).toFixed(1) + 'k';
  return num.toString();
}

const TABS = ['Status', 'Usage', 'Stats', 'Settings'];
let currentTabIdx = 0;
let settingsSelectionIdx = 0;
let expandedProviders: string[] = [];
let currentTreeItems: any[] = [];
let usageViewMode: 'today' | 'session' = 'today';
const SETTINGS_OPTS = ['Routing Mode', 'Default Model', 'Add OpenRouter Key', 'Add Nvidia Key', 'Save & Apply', 'Discard Changes'];

let isInputMode = false;
let isDiagnosticsMode = false;
let diagnosticsComplete = false;
let inputTarget = '';
let inputBuffer = '';
let promptStr = '';
let isListening = false;

let isSelectingModel = false;
let modelSelectionIdx = 0;

const MODELS = [
  {
    id: 'minimax/minimax-m3',
    displayName: 'MiniMax M3',
    context: '1M context',
    provider: 'openrouter',
    description: 'Latest MiniMax · High reasoning capability · Fast speed'
  },
  {
    id: 'minimax/minimax-m2.7',
    displayName: 'MiniMax M2.7',
    context: '1M context',
    provider: 'openrouter',
    description: 'MiniMax M2.7 · Great for routine tasks · Blazing fast'
  },
  {
    id: 'qwen/qwen3.8-27b',
    displayName: 'Qwen 3.8 27B',
    context: '32K context',
    provider: 'openrouter',
    description: 'Qwen 3.8 27B via OpenRouter'
  },
  {
    id: 'openai/gpt-oss-120b',
    displayName: 'GPT OSS 120B',
    context: '128K context',
    provider: 'openrouter',
    description: 'GPT OSS 120B via OpenRouter'
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b',
    displayName: 'Nemotron Super',
    context: '256K context',
    provider: 'nvidia',
    description: 'Nemotron 120B · Solid instruction following · Moderate speed'
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    displayName: 'Nemotron Ultra',
    context: '1M context',
    provider: 'nvidia',
    description: 'Nemotron 550B · Top-tier reasoning · Massive context window'
  },
  {
    id: 'codestral-latest',
    displayName: 'Codestral',
    context: '256K context',
    provider: 'mistral',
    description: 'Codestral · Specialized for Code & Agents · Native Mistral API'
  },
  {
    id: 'gemini-1.5-flash',
    displayName: 'Gemini 1.5 Flash',
    context: '2M context',
    provider: 'gemini',
    description: 'Gemini 1.5 Flash · Native Google API'
  },
  {
    id: 'llama-3.1-70b-versatile',
    displayName: 'Llama 3.1 70B',
    context: '128K context',
    provider: 'groq',
    description: 'Llama 3.1 70B · Ultra fast speed'
  }
];

function getAvailableModels() {
  if (draftConfig.defaultProvider === 'openrouter') return MODELS.filter(m => m.provider === 'openrouter');
  if (draftConfig.defaultProvider === 'nvidia') return MODELS.filter(m => m.provider === 'nvidia');
  if (draftConfig.defaultProvider === 'mistral') return MODELS.filter(m => m.provider === 'mistral');
  if (draftConfig.defaultProvider === 'gemini') return MODELS.filter(m => m.provider === 'gemini');
  if (draftConfig.defaultProvider === 'groq') return MODELS.filter(m => m.provider === 'groq');
  return MODELS;
}


const orange = chalk.hex('#e27d60');
const lightBlue = chalk.hex('#8b9df2');
const gray = chalk.hex('#808080');
const highlight = chalk.bgHex('#8b9df2').black;
const whiteHighlight = chalk.bgWhite.black;

function renderTabs() {
  let out = '';
  for (let i = 0; i < TABS.length; i++) {
    if (i === currentTabIdx) {
      out += highlight(` ${TABS[i]} `) + '  ';
    } else {
      out += lightBlue(TABS[i]) + '  ';
    }
  }
  console.log(out + '');
}

async function renderStats() {
  console.log(whiteHighlight(' Overview ') + '  Models');
  console.log(chalk.gray.italic('  (Showing all-time cumulative history and lifetime session metrics)'));
  const data = readUsageData();
  
  let favProvider = 'None';
  let maxUsage = 0;
  for (const [prov, count] of Object.entries(data.providerUsage || {})) {
    if ((count as number) > maxUsage) { maxUsage = count as number; favProvider = prov; }
  }
  
  const totalTokens = (data.totalInputTokens || 0) + (data.totalOutputTokens || 0);
  const formattedTotal = formatTokens(totalTokens);
  
  const inTokensStr = formatTokens(data.totalInputTokens || 0);
  const outTokensStr = formatTokens(data.totalOutputTokens || 0);
  const cacheTokensStr = formatTokens(data.totalCacheTokens || 0);
  
  const sessions = data.sessions || 1;
  const dailyDates = Object.keys(data.daily || {}).sort();
  const activeDays = dailyDates.length;

  let mostActiveDay = 'None';
  let maxDailyTokens = 0;
  
  for (const date of dailyDates) {
    const dayData = (data.daily as any)[date];
    const dayTokens = (dayData.inputTokens || 0) + (dayData.outputTokens || 0);
    if (dayTokens > maxDailyTokens) {
      maxDailyTokens = dayTokens;
      mostActiveDay = date;
    }
  }

  let currentStreak = 0;
  if (activeDays > 0) {
    const today = new Date();
    for (let i = 0; i < 365; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(today.getDate() - i);
      const dateStr = checkDate.toISOString().split('T')[0] as string;
      if (data.daily && (data.daily as any)[dateStr]) {
        currentStreak++;
      } else if (i > 0) { 
        break;
      }
    }
  }

  // Real Heatmap
  const blocks = [gray('·'), orange('░'), orange('▒'), orange('▓'), orange('█')];
  const grid: string[][] = Array.from({length: 7}, () => Array(52).fill(' '));
  const today = new Date();
  const todayDayOfWeek = today.getDay();
  
  for (let col = 0; col < 52; col++) {
    for (let row = 0; row < 7; row++) {
      const weeksAgo = 51 - col;
      const daysAgo = (weeksAgo * 7) + (todayDayOfWeek - row);
      if (daysAgo < 0 || daysAgo > 364) {
        if(grid[row] && typeof col === "number") grid[row]![col] = ' '; 
      } else {
        const d = new Date();
        d.setDate(today.getDate() - daysAgo);
        const dateStr = d.toISOString().split('T')[0] as string;
        const dayData = (data.daily && (data.daily as any)[dateStr]) ? (data.daily as any)[dateStr] : null;
        if (!dayData) {
          if(grid[row] && typeof col === "number") grid[row]![col] = blocks[0] as string;
        } else {
          const tokens = (dayData.inputTokens || 0) + (dayData.outputTokens || 0);
          let b = 1;
          if (tokens > 10000) b = 2;
          if (tokens > 50000) b = 3;
          if (tokens > 100000) b = 4;
          if(grid[row] && typeof col === "number") grid[row]![col] = blocks[b] as string;
        }
      }
    }
  }
  
  console.log('    Sep Oct Nov Dec Jan Feb Mar Apr May Jun Jul Aug');
  const rowLabels = ['   ', 'Mon', '   ', 'Wed', '   ', 'Fri', '   '];
  for (let row = 0; row < 7; row++) {
    process.stdout.write(rowLabels[row] + ' ');
    for (let col = 0; col < 52; col++) {
      process.stdout.write((grid[row] && grid[row]![col] ? grid[row]![col] : ' ') + ' ');
    }
    console.log();
  }
  console.log('    Less ' + blocks.join(' ') + ' More');
  
  console.log(orange('All time') + gray(' · Last 7 days · Last 30 days') + '');
  
  console.log(`Favorite provider: ${orange(favProvider.padEnd(16))}Total tokens: ${orange(formattedTotal)}`);
  console.log(`Sessions: ${orange(sessions.toString().padEnd(25))}Active days: ${orange(activeDays.toString())}`);
  console.log(`Most active day: ${orange(mostActiveDay.padEnd(17))}Current streak: ${orange(currentStreak + ' days')}`);
  console.log();
  console.log(gray(`Input ${inTokensStr} · Output ${outTokensStr} · Cache read ${cacheTokensStr}`));
  console.log();
  console.log();
  console.log(gray('↓ stats · r to cycle dates'));
}

async function renderStatus() {
  console.log(orange(' ⚡ ACTIVE CONNECTIONS'));
  console.log(chalk.gray.italic('    (Real-time live health, RPM limits, and dynamic cooldown timers)'));

  let lastRouteStr = '';
  let activeKey = '';
  try {
    const lrRes = await fetch('http://localhost:3002/v1/keymux/lastRoute');
    if (lrRes.ok) {
      const lr: any = await lrRes.json();
      if (lr && lr.provider) {
        activeKey = lr.key || '';
        let pName = lr.provider.charAt(0).toUpperCase() + lr.provider.slice(1);
        let pColor = lr.provider.toLowerCase() === 'openrouter' ? chalk.cyan : (lr.provider.toLowerCase() === 'mistral' ? chalk.magenta : (lr.provider.toLowerCase() === 'gemini' ? chalk.blue : (lr.provider.toLowerCase() === 'groq' ? chalk.yellow : chalk.green)));
        let kStr = lr.key || 'unk';
        if (kStr.length > 10) {
          kStr = kStr.substring(0, 4) + '...' + kStr.slice(-4);
        }
        lastRouteStr = chalk.yellow('⚡ Last Route: ') + pColor(`[${pName}]`) + ' ' + chalk.white(lr.model) + chalk.gray(` (Key: ${kStr})`) + '';
      }
    }
  } catch(e) {}

  if (lastRouteStr) console.log(lastRouteStr);
  try {
    const res = await fetch('http://localhost:3002/v1/keymux/stats');
    if (res.ok) {
      const stats: any[] = await res.json() as any[];
      const h = chalk.bold.cyan;
      const b = chalk.dim;
      
      console.log(h(' NODE'.padEnd(14)) + h('KEY'.padEnd(13)) + h('HEALTH'.padEnd(19)) + h('LOAD (RPM)'.padEnd(16)) + h('TTFT'));
      console.log(b(' ───────────────────────────────────────────────────────────────────────'));
      
      if (stats.length === 0) {
        console.log(chalk.gray('  No active keys found.'));
      }
      
      for (const ep of stats) {
        let providerName = ep.id?.split('-')[0] || 'unk';
        providerName = providerName.charAt(0).toUpperCase() + providerName.slice(1);
        let pColor = providerName.toLowerCase() === 'openrouter' ? chalk.cyan : (providerName.toLowerCase() === 'mistral' ? chalk.magenta : (providerName.toLowerCase() === 'gemini' ? chalk.blue : (providerName.toLowerCase() === 'groq' ? chalk.yellow : chalk.green)));
        
        let kStr = ep.key || 'unk';
        if (kStr.length > 10) {
          kStr = kStr.substring(0, 4) + '...' + kStr.slice(-4);
        }
        
        const isH = ep.isHealthy;
        const cooldownS = ep.cooldownRemainingMs ? Math.ceil(ep.cooldownRemainingMs / 1000) : 0;
        
        let healthStr = '';
        let dot = '';
        let pStr = '';
        if (!isH && (ep.circuitState === 'open' || cooldownS > 0)) {
           healthStr = chalk.red(`[ BLOCKED - ${cooldownS}s ]`.padEnd(19));
           dot = chalk.red('○');
           pStr = chalk.red(providerName.padEnd(11));
        } else if (!isH) {
           healthStr = chalk.red('[ BLOCKED ]'.padEnd(19));
           dot = chalk.red('○');
           pStr = chalk.red(providerName.padEnd(11));
        } else {
           healthStr = chalk.green('[ ACTIVE ]'.padEnd(19));
           dot = pColor('●');
           pStr = pColor(providerName.padEnd(11));
        }
        
        const rpm = ep.rpm || 0;
        const lim = ep.rpmLimit;
        let rStr = '';
        if (lim && lim > 0) {
          const blocks = 10;
          const filled = Math.min(blocks, Math.floor((rpm / lim) * blocks));
          rStr = `[${'█'.repeat(filled)}${'░'.repeat(blocks - filled)}]`;
        } else {
          rStr = `[${rpm}/-]`;
        }
        rStr = rStr.padEnd(16);
        
        const lat = ep.latency || ep.avgLatencyMs || 0;
        let lStr = (!isH && (ep.circuitState === 'open' || cooldownS > 0)) ? '---' : 
                   (lat >= 60000 ? `${(lat / 60000).toFixed(1)}m` : 
                   (lat >= 1000 ? `${(lat / 1000).toFixed(1)}s` : `${lat}ms`));

        if (lStr === '---') {
          lStr = chalk.gray('---');
        } else if (lat < 2000) {
          lStr = chalk.green(lStr);
        } else if (lat >= 2000 && lat < 10000) {
          lStr = chalk.rgb(19, 157, 155)(lStr);
        } else {
          lStr = chalk.red(lStr);
        }
        
        const activeIndicator = (activeKey && ep.key && activeKey.endsWith(ep.key.slice(-4))) ? chalk.bold.cyan('   ◀ ACTIVE') : '';
        console.log(` ${dot} ${pStr}${kStr.padEnd(13)}${healthStr}${rStr}${lStr}${activeIndicator}`);
      }
    } else {
      console.log(chalk.yellow('  Proxy returned an error.'));
    }
  } catch(e) {
    console.log(chalk.red('  Proxy offline or unreachable.'));
  }
}

function renderSettings() {
  const isUnsaved = JSON.stringify(draftConfig) !== JSON.stringify(config);
  const unsavedTag = isUnsaved ? chalk.yellow(' (Unsaved Changes - Press S to Save)') : '';
  console.log(chalk.bold.cyan('  ⚙  PREFERENCES') + unsavedTag + '');

  if (flashMessage) {
    console.log(chalk.green(`  ✔ ${flashMessage}`));
    flashMessage = '';
  }

  currentTreeItems = [];
  let index = 0;

  console.log(chalk.bold.white('\n  ACTIVE MODEL ROUTING (Strict Mode - No Failover)'));
  console.log(chalk.dim('  ─────────────────────────────────────────────────────────────────'));
  const modelList = [
    { type: 'provider', label: 'Groq' },
    { type: 'model', provider: 'groq', id: 'openai/gpt-oss-120b', label: 'openai/gpt-oss-120b', tag: '[ Strong reasoning, coding, tool use ]' },
    { type: 'model', provider: 'groq', id: 'qwen/qwen3.8-27b', label: 'qwen/qwen3.8-27b', tag: '[ Coding + reasoning ]' },
    { type: 'model', provider: 'groq', id: 'groq/compound', label: 'groq/compound', tag: '[ Agent workflows, web search, code ex. ]' },
    { type: 'provider', label: 'Nvidia NIM' },
    { type: 'model', provider: 'nvidia', id: 'nvidia/nemotron-3-super-120b-a12b', label: 'nvidia/nemotron-3-super-120b-a12b', tag: '[ Elite Reasoning • 120B ]' },
    { type: 'provider', label: 'Google Gemini' },
    { type: 'model', provider: 'gemini', id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite', tag: '[ Ultra Low Cost • Fast ]' },
    { type: 'provider', label: 'Mistral' },
    { type: 'model', provider: 'mistral', id: 'devstral-latest', label: 'devstral-latest', tag: '[ Agentic software engineering ]' },
    { type: 'model', provider: 'mistral', id: 'codestral-latest', label: 'codestral-latest', tag: '[ Code generation/completion ]' },
    ];

  for (const m of modelList) {
    if (m.type === 'provider') {
      console.log(`\n   - ${chalk.white(m.label)}`);
    } else {
      currentTreeItems.push({ ...m, index: index++ });
      const isSelected = (index - 1) === settingsSelectionIdx;
      const isSaved = draftConfig.defaultModel === m.id;
      
      const hover = isSelected ? chalk.cyan('❯') : ' ';
      const saved = isSaved ? chalk.green('▶') : ' ';
      
      const prefix = `    ${hover} ${saved} `;
      const modelStr = m.id!.padEnd(33);
      const tagStr = chalk.dim(m.tag);
      
      if (isSelected) {
         console.log(chalk.cyan(`${prefix}${modelStr} ${m.tag}`));
      } else if (isSaved) {
         console.log(`${prefix}${chalk.green(modelStr)} ${tagStr}`);
      } else {
         console.log(`${prefix}${chalk.white(modelStr)} ${tagStr}`);
      }
    }
  }

  console.log(chalk.bold.white('\n\n  API SECRETS & KEYS'));
  console.log(chalk.dim('  ─────────────────────────────────────────────────────────────────'));

  const providers = ['nvidia', 'mistral', 'gemini', 'groq'];
  const capitalize = (s: string) => {
    if (s === 'openrouter') return 'OpenRouter';
    if (s === 'nvidia') return 'Nvidia NIM';
    if (s === 'mistral') return 'Mistral AI';
    if (s === 'gemini') return 'Google Gemini';
    if (s === 'groq') return 'Groq';
    return s;
  };
  const maskKey = (k: string) => k.length > 8 ? k.substring(0, 4) + '...' + k.slice(-4) : '***';

  for (const p of providers) {
    const keys = draftConfig.keys?.[p] || [];
    currentTreeItems.push({ type: 'secret_provider', provider: p, label: capitalize(p), value: keys.length + ' Active Keys', index: index++ });
    const isSelected = (index - 1) === settingsSelectionIdx;
    const hover = isSelected ? chalk.cyan('❯') : ' ';
    const prefix = `    ${hover} `;
    
    if (isSelected) {
      console.log(chalk.cyan(`${prefix}${capitalize(p).padEnd(20)} ${keys.length} Active Keys`));
    } else {
      console.log(`${prefix}${chalk.white(capitalize(p).padEnd(20))} ${chalk.dim(keys.length + ' Active Keys')}`);
    }

    if (expandedProviders.includes(p)) {
      for (const key of keys) {
        currentTreeItems.push({ type: 'key', provider: p, label: maskKey(key), value: '', index: index++ });
        const keySelected = (index - 1) === settingsSelectionIdx;
        const kHover = keySelected ? chalk.cyan('❯') : ' ';
        const kPrefix = `      ${kHover} `;
        if (keySelected) {
          console.log(chalk.cyan(`${kPrefix}${maskKey(key)}`));
        } else {
          console.log(`${kPrefix}${chalk.gray(maskKey(key))}`);
        }
      }
      
      currentTreeItems.push({ type: 'add', provider: p, label: '[ Press Enter to Add ]', value: '', index: index++ });
      const addSelected = (index - 1) === settingsSelectionIdx;
      
      if (isInputMode && inputTarget === p) {
        console.log(`        ${chalk.cyan('Enter new key: ')}` + chalk.bgCyan.black(` ${inputBuffer}_ `));
      } else {
        const aHover = addSelected ? chalk.cyan('❯') : ' ';
        const aPrefix = `      ${aHover} `;
        if (addSelected) {
          console.log(chalk.cyan(`${aPrefix}[ Press Enter to Add ]`));
        } else {
          console.log(`${aPrefix}${chalk.dim('[ Press Enter to Add ]')}`);
        }
      }
    }
  }

  console.log('\n' + chalk.gray('   [ S ] Save Changes     [ X ] Discard     [ Enter ] Edit/Toggle Item'));
}
function formatCompact(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return num.toString();
}

async function renderUsage() {
  console.log(chalk.white(' USAGE & ANALYTICS '));
  console.log(chalk.gray.italic('  (Live load balancing distribution and provider token breakdown)'));
  
  let usageData: any = { providerUsage: {} };
  try {
    const res = await fetch('http://localhost:3002/v1/keymux/usage');
    if (res.ok) {
      usageData = await res.json() as any;
    } else {
      usageData = { providerUsage: readUsageData().providerUsage };
    }
  } catch(e) {
    usageData = { providerUsage: readUsageData().providerUsage };
  }

  let liveStats: any[] = [];
  let activeKey = '';
  try {
    const res = await fetch('http://localhost:3002/v1/keymux/stats');
    if (res.ok) {
      liveStats = await res.json() as any[];
    }
    const lrRes = await fetch('http://localhost:3002/v1/keymux/lastRoute');
    if (lrRes.ok) {
      const lr: any = await lrRes.json();
      if (lr && lr.provider) activeKey = lr.key || '';
    }
  } catch(e) {}
  console.log(chalk.cyan(`  [ ${usageViewMode === 'today' ? 'Last 24 Hours (Today)' : 'Current Session'} ]`) + chalk.gray('   (Press Enter to toggle)'));
  const getTokens = (usage: any) => typeof usage === 'number' ? 0 : (usage?.tokens || 0);
  const getReqs = (usage: any) => typeof usage === 'number' ? usage : (usage?.requests || 0);
  
  const currentUsageData = usageViewMode === 'today' ? (usageData.today || usageData.providerUsage) : (usageData.session || usageData.providerUsage);
  
  const orUsage = currentUsageData?.openrouter;
  const nvUsage = currentUsageData?.nvidia;
  const miUsage = currentUsageData?.mistral;
  const geUsage = currentUsageData?.gemini;
  const gqUsage = currentUsageData?.groq;
  const orTokens = getTokens(orUsage);
  const nvTokens = getTokens(nvUsage);
  const miTokens = getTokens(miUsage);
  const geTokens = getTokens(geUsage);
  const gqTokens = getTokens(gqUsage);
  const orReqs = getReqs(orUsage);
  const nvReqs = getReqs(nvUsage);
  const miReqs = getReqs(miUsage);
  const geReqs = getReqs(geUsage);
  const gqReqs = getReqs(gqUsage);
  
  const totalTokens = orTokens + nvTokens + miTokens + geTokens + gqTokens;
  const orPct = totalTokens > 0 ? Math.round((orTokens / totalTokens) * 100) : 0;
  const nvPct = totalTokens > 0 ? Math.round((nvTokens / totalTokens) * 100) : 0;
  const miPct = totalTokens > 0 ? Math.round((miTokens / totalTokens) * 100) : 0;
  const gePct = totalTokens > 0 ? Math.round((geTokens / totalTokens) * 100) : 0;
  const gqPct = totalTokens > 0 ? Math.round((gqTokens / totalTokens) * 100) : 0;
  
  const getBar = (pct: number, color: any) => {
    const filled = Math.round((pct / 100) * 12);
    const filledStr = '█'.repeat(filled);
    const emptyStr = '░'.repeat(12 - filled);
    return color(filledStr + emptyStr);
  };
  console.log(' PROVIDER DISTRIBUTION (TOKENS)');
  console.log(chalk.dim(' ─────────────────────────────────────────────────────────────────'));
  
  const orTokenStr = `(${formatCompact(orTokens).padStart(6)} Tokens) ${orReqs ? '(' + String(orReqs).padStart(3) + ' reqs)' : ''}`.trimEnd();
  console.log(` ${chalk.cyan('[OpenRouter]'.padEnd(14))} ${getBar(orPct, chalk.cyan)}  ${String(orPct).padStart(2)}%     ${orTokenStr}`);
  
  const nvTokenStr = `(${formatCompact(nvTokens).padStart(6)} Tokens) ${nvReqs ? '(' + String(nvReqs).padStart(3) + ' reqs)' : ''}`.trimEnd();
  console.log(` ${chalk.green('[Nvidia]'.padEnd(14))} ${getBar(nvPct, chalk.green)}  ${String(nvPct).padStart(2)}%     ${nvTokenStr}`);

  if (miTokens > 0 || miReqs > 0 || draftConfig.keys?.mistral?.length) {
    const miTokenStr = `(${formatCompact(miTokens).padStart(6)} Tokens) ${miReqs ? '(' + String(miReqs).padStart(3) + ' reqs)' : ''}`.trimEnd();
    console.log(` ${chalk.magenta('[Mistral AI]'.padEnd(14))} ${getBar(miPct, chalk.magenta)}  ${String(miPct).padStart(2)}%     ${miTokenStr}`);
  }
  if (geTokens > 0 || geReqs > 0 || draftConfig.keys?.gemini?.length) {
    const geTokenStr = `(${formatCompact(geTokens).padStart(6)} Tokens) ${geReqs ? '(' + String(geReqs).padStart(3) + ' reqs)' : ''}`.trimEnd();
    console.log(` ${chalk.blue('[Google Gemini]'.padEnd(14))} ${getBar(gePct, chalk.blue)}  ${String(gePct).padStart(2)}%     ${geTokenStr}`);
  }
  if (gqTokens > 0 || gqReqs > 0 || draftConfig.keys?.groq?.length) {
    const gqTokenStr = `(${formatCompact(gqTokens).padStart(6)} Tokens) ${gqReqs ? '(' + String(gqReqs).padStart(3) + ' reqs)' : ''}`.trimEnd();
    console.log(` ${chalk.yellow('[Groq]'.padEnd(14))} ${getBar(gqPct, chalk.yellow)}  ${String(gqPct).padStart(2)}%     ${gqTokenStr}`);
  }
  console.log('');

  console.log(' TRAFFIC ROUTING & LOAD (REQUESTS)');
  console.log(chalk.dim(' ─────────────────────────────────────────────────────────────────'));
  
  if (liveStats.length === 0) {
    console.log(chalk.gray('  No active keys found.'));
  } else {
    const totalKeyReqs = liveStats.reduce((sum, s) => sum + (s.totalRequests || 0), 0);
    for (const stat of liveStats) {
      const keyStr = stat.key || '';
      let masked = keyStr;
      if (keyStr.length > 10) {
        masked = `${keyStr.substring(0, 4)}...${keyStr.slice(-4)}`;
      }
      
      const reqs = stat.totalRequests || 0;
      const errs = stat.totalErrors || 0;
      const pct = totalKeyReqs > 0 ? Math.round((reqs / totalKeyReqs) * 100) : 0;
      
      const isOR = (stat.id || '').startsWith('openrouter');
      const isMI = (stat.id || '').startsWith('mistral');
      const isGE = (stat.id || '').startsWith('gemini');
      const isGQ = (stat.id || '').startsWith('groq');
      const provColor = isOR ? chalk.cyan : (isMI ? chalk.magenta : (isGE ? chalk.blue : (isGQ ? chalk.yellow : chalk.green)));
      
      const errStr = errs === 0 ? chalk.green(`✓ ${errs} err`) : chalk.red(`✗ ${errs} err`);
      const reqStr = `${chalk.dim('[')} ${String(reqs).padStart(3)} reqs ${chalk.dim(']')}`;
      const activeIndicator = (activeKey && keyStr && activeKey.endsWith(keyStr.slice(-4))) ? chalk.bold.cyan('   ◀ LAST USED') : '';
      
      console.log(` ${masked.padEnd(14)} ${getBar(pct, provColor)}  ${String(pct).padStart(2)}%     ${reqStr}  ${errStr}${activeIndicator}`);
    }
  }
}

async function render() {
  process.stdout.write('\x1b[2J\x1b[H');
  

  renderTabs();
  
  const tab = TABS[currentTabIdx];
  if (tab === 'Stats') await renderStats();
  else if (tab === 'Status') await renderStatus();
  else if (tab === 'Usage') await renderUsage();
  else if (tab === 'Settings') renderSettings();
  
  console.log('' + chalk.gray('Tab to switch tabs · D for diagnostics · q to quit'));
}


export async function runDashboard() {  
  await render();

  if (process.stdin.isTTY && !isListening) {
    isListening = true;
    
    setInterval(async () => {
      if (!isInputMode && !isSelectingModel && !isDiagnosticsMode) {
        await render();
      }
    }, 2000);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    
    process.stdin.on('data', async (key: string) => {

      if (isDiagnosticsMode) {
        if (diagnosticsComplete && (key === '\r' || key === '' || key === '\x1b' || key === ' ')) {
          isDiagnosticsMode = false;
          await render();
        }
        return;
      }

      if (key === 'D' && !isInputMode && !isSelectingModel) {
        runDiagnosticsModal();
        return;
      }

      if (key === '\u0003' || key === 'q' && !isInputMode) {
        process.stdout.write('\x1b[2J\x1b[H');
        process.exit();
      }

      if (key === 'r' && !isInputMode && !isSelectingModel) {
        await render();
        return;
      }

      if (isSelectingModel) {
        const available = getAvailableModels();
        if (key === '\x1b[A') {
          modelSelectionIdx = (modelSelectionIdx - 1 + available.length) % available.length;
          await render();
        } else if (key === '\x1b[B') {
          modelSelectionIdx = (modelSelectionIdx + 1) % available.length;
          await render();
        } else if (key === '\r' || key === '') {
          if (available[modelSelectionIdx]) draftConfig.defaultModel = available[modelSelectionIdx]!.id;
          isSelectingModel = false;
          await render();
        } else if (key === '\x1b') {
          isSelectingModel = false;
          await render();
        }
        return;
      }

      if (isInputMode) {
        if (key === '\r' || key === '') {
          const val = inputBuffer.trim();
          if (val) {
            if (!draftConfig.keys) draftConfig.keys = { openrouter: [], nvidia: [], mistral: [], gemini: [], groq: [] };
            if (!(draftConfig.keys as any)[inputTarget]) {
              (draftConfig.keys as any)[inputTarget] = [];
            }
            if (!(draftConfig.keys as any)[inputTarget].includes(val)) {
              (draftConfig.keys as any)[inputTarget].push(val);
            }
          }
          isInputMode = false;
          await render();
        } else if (key === '\x1b') {
          isInputMode = false;
          await render();
        } else if (key === '\u007f' || key === '\b') {
          inputBuffer = inputBuffer.slice(0, -1);
          await render();
        } else {
          // Strip ANSI and limit buffer
          const cleanKey = key.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
          if (cleanKey) {
            inputBuffer += cleanKey;
            if (inputBuffer.length > 500) {
              inputBuffer = inputBuffer.slice(0, 500);
            }
            await render();
          }
        }
        return;
      }

      // Tab Navigation
      if (key === '\t' || key === '\x1b[C' || key === '\x1bOC') { // Tab or Right Arrow
        currentTabIdx = (currentTabIdx + 1) % TABS.length; isSelectingModel = false; isInputMode = false;
        await render();
      } else if (key === '\x1b[D' || key === '\x1bOD') { // Left Arrow
        currentTabIdx = (currentTabIdx - 1 + TABS.length) % TABS.length; isSelectingModel = false; isInputMode = false;
        await render();
      } else if (TABS[currentTabIdx] === 'Usage' && (key === '\r' || key === '' || key === ' ')) {
        usageViewMode = usageViewMode === 'today' ? 'session' : 'today';
        await render();
      }
      
      // Settings Navigation
      else if (TABS[currentTabIdx] === 'Settings') {
        if (key === '\x1b[A' || key === '\x1bOA') { // Up Arrow
          if (settingsSelectionIdx > 0) settingsSelectionIdx--;
          await render();
        } else if (key === '\x1b[B' || key === '\x1bOB') { // Down Arrow
          if (settingsSelectionIdx < currentTreeItems.length - 1) settingsSelectionIdx++;
          await render();
        } else if (key === '\r' || key === '' || key === ' ') { // Enter or Space
          const selected = currentTreeItems[settingsSelectionIdx];
          if (!selected) return;
          if (selected.type === 'model') {
            draftConfig.defaultProvider = selected.provider;
            draftConfig.defaultModel = selected.id;
            draftConfig.strictMode = true;
            await render();
          } else if (selected.type === 'secret_provider') {
            if (expandedProviders.includes(selected.provider)) {
              expandedProviders = expandedProviders.filter(p => p !== selected.provider);
            } else {
              expandedProviders.push(selected.provider);
            }
            await render();
          } else if (selected.type === 'add') {
            isInputMode = true;
            inputTarget = selected.provider;
            promptStr = 'Enter new key: ';
            inputBuffer = '';
            await render();
          }
        } else if (key.toLowerCase() === 's') { // Save
          config = JSON.parse(JSON.stringify(draftConfig));
          saveConfig(config);
          await triggerReload();
          flashMessage = 'Changes saved successfully!';
          await render();
        } else if (key.toLowerCase() === 'x') { // Discard
          draftConfig = JSON.parse(JSON.stringify(config));
          flashMessage = 'Changes discarded.';
          await render();
        }
      }
      
    });
  }
}
