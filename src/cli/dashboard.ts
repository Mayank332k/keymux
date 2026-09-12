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
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (!parsed.keys) parsed.keys = { openrouter: [], nvidia: [], mistral: [], gemini: [], groq: [] };
        return parsed;
      }
    }
  } catch (e) {}
  return { defaultProvider: null, defaultModel: '', keys: { openrouter: [], nvidia: [], mistral: [], gemini: [], groq: [] } };
}

function saveConfig(cfg: any) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  } catch (e) {}
}

const proxyPort = process.argv.includes('--port') ? parseInt(process.argv[process.argv.indexOf('--port') + 1] || '3002', 10) : 3002;

async function triggerReload() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: proxyPort,
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
      const parsed = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
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
let settingsView: 'main' | 'models' | 'keys' = 'main';

let isInputMode = false;
let inputTarget = '';
let inputBuffer = '';
let promptStr = '';
let isListening = false;





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
  console.log(gray('↓ stats · r to refresh'));
}

async function renderStatus() {
  console.log('\n  STATUS');

  let activeMode = 'auto';
  let activeModel = 'none';
  let currentProvider = 'auto';

  try {
    const amRes = await fetch(`http://localhost:${proxyPort}/v1/keymux/activeModel`);
    if (amRes.ok) {
      const am: any = await amRes.json();
      activeMode = am.mode === 'STRICT' ? 'strict' : 'auto';
      activeModel = am.model === 'auto' ? 'auto (best available)' : am.model;
      currentProvider = am.provider === 'auto' ? 'auto' : am.provider.toLowerCase();
    }
  } catch(e) {}

  let activeKey = '';
  try {
    const lrRes = await fetch(`http://localhost:${proxyPort}/v1/keymux/lastRoute`);
    if (lrRes.ok) {
      const lr: any = await lrRes.json();
      if (lr && lr.provider) {
        activeKey = lr.key || '';
      }
    }
  } catch(e) {}

  const leftColWidth = 35;
  const printRow = (label: string, value: string) => {
    console.log(`  ${chalk.white(label.padEnd(leftColWidth))} ${chalk.white(value)}`);
  };

  let maskedActiveKey = 'none';
  if (activeKey) {
    maskedActiveKey = activeKey.length > 10 ? `${activeKey.substring(0, 4)}...${activeKey.slice(-4)}` : activeKey;
  }

  printRow('Active mode', activeMode);
  printRow('Active model', activeModel);
  printRow('Current provider', currentProvider);
  printRow('Last used key', maskedActiveKey);

  console.log('\n  CONNECTIONS (Real-time health, RPM limits, latency)');
  console.log('  ' + '─'.repeat(60));

  try {
    const res = await fetch(`http://localhost:${proxyPort}/v1/keymux/stats`);
    if (res.ok) {
      const stats: any[] = await res.json() as any[];

      if (stats.length === 0) {
        console.log(chalk.dim('  No active keys found.'));
      }

      for (const ep of stats) {
        let providerName = ep.id?.split('-')[0] || 'unk';
        if (providerName.toLowerCase() === 'openrouter') providerName = 'OpenRouter';
        else if (providerName.toLowerCase() === 'nvidia') providerName = 'Nvidia NIM';
        else if (providerName.toLowerCase() === 'mistral') providerName = 'Mistral AI';
        else if (providerName.toLowerCase() === 'gemini') providerName = 'Google Gemini';
        else if (providerName.toLowerCase() === 'groq') providerName = 'Groq';
        else providerName = providerName.charAt(0).toUpperCase() + providerName.slice(1);

        let kStr = ep.key || 'unk';
        if (kStr.length > 10) {
          kStr = kStr.substring(0, 4) + '...' + kStr.slice(-4);
        }

        const isH = ep.isHealthy;
        const cooldownS = ep.cooldownRemainingMs ? Math.ceil(ep.cooldownRemainingMs / 1000) : 0;

        let healthStr = '';
        if (!isH && (ep.circuitState === 'open' || cooldownS > 0)) {
           healthStr = chalk.red(`BLOCKED   ${cooldownS}s cdn`.padEnd(19));
        } else if (!isH) {
           healthStr = chalk.red('BLOCKED            '.padEnd(19));
        } else {
           healthStr = chalk.green('ACTIVE             '.padEnd(19));
        }

        const rpm = ep.rpm || 0;
        const lim = ep.rpmLimit;
        let rStr = lim && lim > 0 ? `${rpm} rpm` : `${rpm} rpm`;
        rStr = rStr.padEnd(16);

        const lat = ep.latency || ep.avgLatencyMs || 0;
        let lStr = (!isH && (ep.circuitState === 'open' || cooldownS > 0)) ? '---' :
                   (lat >= 60000 ? `${(lat / 60000).toFixed(1)}m` :
                   (lat >= 1000 ? `${(lat / 1000).toFixed(1)}s` : `${lat}ms`));

        if (lStr === '---') {
          lStr = chalk.gray('---');
        } else {
          lStr = chalk.white(lStr);
        }

        console.log(`  ${chalk.white(providerName.padEnd(15))}${chalk.white(kStr.padEnd(16))}${healthStr}${chalk.white(rStr)}${lStr}`);
      }
    } else {
      console.log(chalk.dim('  Proxy returned an error.'));
    }
  } catch(e) {
    console.log(chalk.dim('  Proxy offline or unreachable.'));
  }
}

function renderSettings() {
  const isUnsaved = JSON.stringify(draftConfig) !== JSON.stringify(config);
  const unsavedTag = isUnsaved ? chalk.yellow(' (Unsaved Changes - Press S to Save)') : '';

  if (flashMessage) {
    console.log(chalk.green(`  ✔ ${flashMessage}`));
    flashMessage = '';
  }

  currentTreeItems = [];
  let index = 0;

  const leftColWidth = 35;
  const renderRow = (label: string, value: string, isSelected: boolean) => {
    const bg = isSelected ? chalk.bgHex('#333333').white : chalk.white;
    const padding = Math.max(0, leftColWidth - label.length);
    console.log(bg(`  ${label}${' '.repeat(padding)} ${value}`.padEnd(80)));
  };

  if (settingsView === 'main') {
    console.log('\n  SETTINGS' + unsavedTag);
    console.log('  ' + '─'.repeat(60));

    currentTreeItems.push({ type: 'main_mode', index: index++ });
    const isAuto = !draftConfig.strictMode;
    renderRow('Routing mode', isAuto ? 'auto' : 'strict', (index - 1) === settingsSelectionIdx);

    currentTreeItems.push({ type: 'main_model', index: index++ });
    renderRow('Active model', isAuto ? chalk.gray('auto') : (draftConfig.defaultModel || 'none'), (index - 1) === settingsSelectionIdx);

    currentTreeItems.push({ type: 'main_keys', index: index++ });
    const totalKeys = Object.values(draftConfig.keys || {}).reduce((acc: number, arr: any) => acc + arr.length, 0);
    renderRow('API keys', `${totalKeys} active keys`, (index - 1) === settingsSelectionIdx);

    console.log('\n\n  ' + chalk.gray('Enter to toggle/select · S to save · X to discard'));

  } else if (settingsView === 'models') {
    console.log('\n  SELECT ACTIVE MODEL');
    console.log('  ' + '─'.repeat(110));

    const modelList = [
      { provider: 'openrouter', id: 'nex-agi/nex-n2.5-pro:free', capa: 'Vision • Free tier • Agentic QA & browser testing' },
      { provider: 'groq', id: 'qwen/qwen3.8-27b', capa: 'Vision tower • Ultra fast LPU • Native reasoning tags' },
      { provider: 'groq', id: 'openai/gpt-oss-120b', capa: '120B • Reasoning traces • Structured output • Tool use' },
      { provider: 'groq', id: 'groq/compound', capa: 'Multi-tool agent • Integrated web search & code execution' },
      { provider: 'nvidia', id: 'nvidia/nemotron-3-super-120b-a12b', capa: '120B MoE • High volume agentic reasoning traces' },
      { provider: 'nvidia', id: 'nvidia/nemotron-3-ultra-550b-a55b', capa: '550B MoE • Massive enterprise IT & logic solver' },
      { provider: 'openrouter', id: 'nex-agi/nex-n2.5-mini:free', capa: 'Vision • Free tier • Ultra fast lightweight agentic tasks' },
      { provider: 'gemini', id: 'gemini-3.5-flash-lite', capa: 'Multimodal • 1M context • Low cost document parser' },
      { provider: 'mistral', id: 'devstral-latest', capa: 'Discontinued • Software engineering agentic workflow specialist' },
      { provider: 'mistral', id: 'codestral-2508', capa: '256K context • Pure fill-in-the-middle code completion' },
    ];

    for (const m of modelList) {
      currentTreeItems.push({ type: 'model', provider: m.provider, id: m.id, index: index++ });
      const isSelected = (index - 1) === settingsSelectionIdx;
      const isSaved = draftConfig.defaultModel === m.id;

      const modelStr = m.id.padEnd(leftColWidth);
      const provStr = m.provider.padEnd(14);

      let line = '';
      if (isSelected) {
        line = chalk.bgHex('#333333').white(`  ${modelStr} `) + chalk.bgHex('#333333').gray(`${provStr} ${m.capa}`);
        console.log(chalk.bgHex('#333333')(line.padEnd(120)));
      } else {
        const idCol = isSaved ? chalk.blue(`  ${modelStr} `) : chalk.bold.white(`  ${modelStr} `);
        const metaCol = chalk.gray(`${provStr} ${m.capa}`);
        console.log(`${idCol}${metaCol}`);
      }
    }

    console.log('\n\n  ' + chalk.gray('Enter to select · Esc to return'));

  } else if (settingsView === 'keys') {
    console.log('\n  API SECRETS');
    console.log('  ' + '─'.repeat(60));

    const providers = ['openrouter', 'nvidia', 'mistral', 'gemini', 'groq'];
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
      currentTreeItems.push({ type: 'secret_provider', provider: p, index: index++ });

      const isSelected = (index - 1) === settingsSelectionIdx;
      renderRow(capitalize(p), `${keys.length} active keys`, isSelected);

      if (expandedProviders.includes(p)) {
        for (const key of keys) {
          currentTreeItems.push({ type: 'key', provider: p, index: index++ });
          const keySelected = (index - 1) === settingsSelectionIdx;
          const bg = keySelected ? chalk.bgHex('#333333').gray : chalk.gray;
          console.log(bg(`    ↳ ${maskKey(key)}`.padEnd(80)));
        }

        currentTreeItems.push({ type: 'add', provider: p, index: index++ });
        const addSelected = (index - 1) === settingsSelectionIdx;
        if (isInputMode && inputTarget === p) {
          console.log(`    ↳ ${chalk.cyan('Enter new key:')} ` + chalk.bgCyan.black(` ${inputBuffer}_ `));
        } else {
          const bg = addSelected ? chalk.bgHex('#333333').gray : chalk.gray;
          console.log(bg(`    ↳ [ Press Enter to Add ]`.padEnd(80)));
        }
      }
    }
    console.log('\n\n  ' + chalk.gray('Enter to add/toggle · Esc to return · S to save'));
  }
}
function formatCompact(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return num.toString();
}

async function renderUsage() {
  console.log('\n  USAGE & ANALYTICS');

  let usageData: any = { providerUsage: {} };
  try {
    const res = await fetch(`http://localhost:${proxyPort}/v1/keymux/usage`);
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
    const res = await fetch(`http://localhost:${proxyPort}/v1/keymux/stats`);
    if (res.ok) {
      liveStats = await res.json() as any[];
    }
    const lrRes = await fetch(`http://localhost:${proxyPort}/v1/keymux/lastRoute`);
    if (lrRes.ok) {
      const lr: any = await lrRes.json();
      if (lr && lr.provider) activeKey = lr.key || '';
    }
  } catch(e) {}

  console.log(chalk.dim(`  [ ${usageViewMode === 'today' ? 'Last 24 Hours (Today)' : 'Current Session'} ]   (Press Enter to toggle)\n`));

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

  const totalTokens = orTokens + nvTokens + miTokens + geTokens + gqTokens;
  const orPct = totalTokens > 0 ? Math.round((orTokens / totalTokens) * 100) : 0;
  const nvPct = totalTokens > 0 ? Math.round((nvTokens / totalTokens) * 100) : 0;
  const miPct = totalTokens > 0 ? Math.round((miTokens / totalTokens) * 100) : 0;
  const gePct = totalTokens > 0 ? Math.round((geTokens / totalTokens) * 100) : 0;
  const gqPct = totalTokens > 0 ? Math.round((gqTokens / totalTokens) * 100) : 0;

  const leftColWidth = 35;

  console.log('  PROVIDER DISTRIBUTION (TOKENS)');
  console.log('  ' + '─'.repeat(60));

  const printRow = (label: string, value: string) => {
    console.log(`  ${chalk.white(label.padEnd(leftColWidth))} ${chalk.white(value)}`);
  };

  printRow('OpenRouter', `${formatCompact(orTokens)} Tokens (${orPct}%)`);
  printRow('Nvidia NIM', `${formatCompact(nvTokens)} Tokens (${nvPct}%)`);

  if (miTokens > 0 || getReqs(miUsage) > 0 || draftConfig.keys?.mistral?.length) {
    printRow('Mistral AI', `${formatCompact(miTokens)} Tokens (${miPct}%)`);
  }
  if (geTokens > 0 || getReqs(geUsage) > 0 || draftConfig.keys?.gemini?.length) {
    printRow('Google Gemini', `${formatCompact(geTokens)} Tokens (${gePct}%)`);
  }
  if (gqTokens > 0 || getReqs(gqUsage) > 0 || draftConfig.keys?.groq?.length) {
    printRow('Groq', `${formatCompact(gqTokens)} Tokens (${gqPct}%)`);
  }

  console.log('\n  TRAFFIC ROUTING (REQUESTS)');
  console.log('  ' + '─'.repeat(60));

  if (liveStats.length === 0) {
    console.log(chalk.dim('  No active keys found.'));
  } else {
    for (const stat of liveStats) {
      const keyStr = stat.key || '';
      let masked = keyStr;
      if (keyStr.length > 10) {
        masked = `${keyStr.substring(0, 4)}...${keyStr.slice(-4)}`;
      }

      const reqs = stat.totalRequests || 0;
      const errs = stat.totalErrors || 0;

      let label = masked;
      if (activeKey && keyStr && activeKey.endsWith(keyStr.slice(-4))) {
        label += chalk.dim(' (Active)');
      }

      const val = `${reqs} reqs  ${errs > 0 ? chalk.red(`[${errs} errs]`) : ''}`;
      // Clean up ansi codes for padding calc
      const rawLabel = label.replace(/\x1B\[\d+m/g, '');
      const padding = Math.max(0, leftColWidth - rawLabel.length);
      console.log(`  ${chalk.white(label)}${' '.repeat(padding)} ${chalk.white(val.trim())}`);
    }
  }
}

let lastFrameBuffer = '';

async function render() {
  let frameBuffer = '';
  const originalLog = console.log;
  const originalWrite = process.stdout.write;

  console.log = (...args: any[]) => {
    frameBuffer += args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
  };
  process.stdout.write = ((chunk: any) => {
    frameBuffer += chunk.toString();
    return true;
  }) as any;

  try {
    renderTabs();

    const tab = TABS[currentTabIdx];
    if (tab === 'Stats') await renderStats();
    else if (tab === 'Status') await renderStatus();
    else if (tab === 'Usage') await renderUsage();
    else if (tab === 'Settings') renderSettings();
    console.log('' + chalk.gray('Tab to switch tabs · q to quit'));
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }

  if (frameBuffer !== lastFrameBuffer) {
    process.stdout.write('\x1b[2J\x1b[H' + frameBuffer);
    lastFrameBuffer = frameBuffer;
  }
}


export async function runDashboard() {
  await render();

  if (process.stdin.isTTY && !isListening) {
    isListening = true;

    let isRendering = false;
    setInterval(async () => {
      if (!isInputMode && !isRendering) {
        isRendering = true;
        try {
          await render();
        } finally {
          isRendering = false;
        }
      }
    }, 2000);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', async (key: string) => {

      if (key === '\u0003' || key === 'q' && !isInputMode) {
        process.stdout.write('\x1b[2J\x1b[H');
        process.exit();
      }

      if (key === 'r' && !isInputMode) {
        await render();
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
        currentTabIdx = (currentTabIdx + 1) % TABS.length; isInputMode = false;
        settingsView = 'main'; settingsSelectionIdx = 0;
        await render();
      } else if (key === '\x1b[D' || key === '\x1bOD') { // Left Arrow
        currentTabIdx = (currentTabIdx - 1 + TABS.length) % TABS.length; isInputMode = false;
        settingsView = 'main'; settingsSelectionIdx = 0;
        await render();
      } else if (TABS[currentTabIdx] === 'Usage' && (key === '\r' || key === '' || key === ' ')) {
        usageViewMode = usageViewMode === 'today' ? 'session' : 'today';
        await render();
      }

      // Settings Navigation
      else if (TABS[currentTabIdx] === 'Settings') {
        if (key === '\x1b' || key === '\x1b[27~') { // Escape
          if (settingsView !== 'main') {
            settingsView = 'main';
            settingsSelectionIdx = 0;
            await render();
          }
        } else if (key === '\x1b[A' || key === '\x1bOA') { // Up Arrow
          if (settingsSelectionIdx > 0) settingsSelectionIdx--;
          await render();
        } else if (key === '\x1b[B' || key === '\x1bOB') { // Down Arrow
          if (settingsSelectionIdx < currentTreeItems.length - 1) settingsSelectionIdx++;
          await render();
        } else if (key === '\r' || key === '' || key === ' ') { // Enter or Space
          const selected = currentTreeItems[settingsSelectionIdx];
          if (!selected) return;

          if (selected.type === 'main_mode') {
            draftConfig.strictMode = !draftConfig.strictMode;
            if (!draftConfig.strictMode) {
              draftConfig.defaultModel = '';
              draftConfig.defaultProvider = '';
            }
            await render();
          } else if (selected.type === 'main_model') {
            settingsView = 'models';
            settingsSelectionIdx = 0;
            await render();
          } else if (selected.type === 'main_keys') {
            settingsView = 'keys';
            settingsSelectionIdx = 0;
            await render();
          } else if (selected.type === 'model') {
            draftConfig.defaultProvider = selected.provider;
            draftConfig.defaultModel = selected.id;
            draftConfig.strictMode = true;
            settingsView = 'main';
            settingsSelectionIdx = 0;
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
        } else if (key.toLowerCase() === 'm' && !isInputMode && settingsView === 'main') { // Toggle Mode
          draftConfig.strictMode = !draftConfig.strictMode;
          if (!draftConfig.strictMode) {
            draftConfig.defaultModel = '';
            draftConfig.defaultProvider = '';
          }
          flashMessage = draftConfig.strictMode ? '🔒 Switched to STRICT Mode' : '⚡ Switched to AUTO Mode';
          await render();
        } else if (key.toLowerCase() === 's') { // Save
          config = JSON.parse(JSON.stringify(draftConfig));
          saveConfig(config);
          await triggerReload();
          flashMessage = 'Changes saved successfully!';
          await render();
        } else if (key.toLowerCase() === 'x') { // Discard
          draftConfig = JSON.parse(JSON.stringify(config));
          settingsView = 'main';
          settingsSelectionIdx = 0;
          flashMessage = 'Changes discarded.';
          await render();
        }
      }

    });
  }
}
