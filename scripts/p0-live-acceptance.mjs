// Opt-in live acceptance. Synthetic data only; credentials stay in process memory.
// PPX_LIVE_API_KEY=<injected by your secret manager> node scripts/p0-live-acceptance.mjs
// --repeat 5 --output <fresh directory> --only create-json,csv-summary,...
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PPXAgent } from '../src/agent/index.js';
import { HttpChannel } from '../src/channels/http.js';
import { validateArgs } from '../src/tools/catalog.js';
import { setLevel } from '../src/utils/logger.js';
setLevel('error');

const argv = process.argv.slice(2);
const option = (name, fallback) => { const n = argv.indexOf(name); return n < 0 ? fallback : argv[n + 1]; };
const repetitions = Number(option('--repeat', '5'));
const model = option('--model', 'deepseek-flash');
const baseUrl = option('--base-url', 'https://api.deepseek.com').replace(/\/$/, '');
const output = path.resolve(option('--output', path.join(os.tmpdir(), `ppx-live-${Date.now()}`)));
const maxCost = Number(option('--max-cost-usd', '1'));
const keyEnv = option('--key-env', 'PPX_LIVE_API_KEY');
const apiKey = process.env[keyEnv];
if (!apiKey) throw new Error(`Missing secret-manager injection: ${keyEnv}`);
delete process.env[keyEnv]; // Shell tools must not inherit the credential.
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20 || !(maxCost > 0)) throw new Error('Invalid test budget');
if (fs.existsSync(output)) throw new Error('Output directory must be fresh; previous receipts are immutable');
fs.mkdirSync(output, { recursive: true });
const write = (file, object) => fs.writeFileSync(file, JSON.stringify(object, null, 2).replaceAll(apiKey, '[REDACTED]'));
const originalFetch = globalThis.fetch.bind(globalThis);
let activeTrial = null;
let knownTotalCost = 0;
let billableRequests = 0;
const pendingBills = new Set();
// Caller-supplied price book is deliberately separate from Agent estimates.
// Price snapshot: official DeepSeek 2026-10-10, weekend off-peak, USD / 1M tokens.
const priceBook = { 'deepseek-flash': { hit: 0.003, miss: 0.15, output: 0.6 },
  'deepseek-v4-pro': { hit: 0.022, miss: 0.66, output: 1.98 } };
function priceReceipt(receipt) {
  const u = receipt.usage;
  const p = priceBook[receipt.requestedModel];
  // This frozen tariff is evidence for this cohort only, not a future price promise.
  if (!receipt.startedAt.startsWith('2026-10-10') || receipt.servedModel !== receipt.requestedModel
    || baseUrl !== 'https://api.deepseek.com' || !p || !u || ![u.prompt_cache_hit_tokens, u.prompt_cache_miss_tokens, u.completion_tokens]
    .every((x) => Number.isFinite(x) && x >= 0)) return null;
  return (u.prompt_cache_hit_tokens * p.hit + u.prompt_cache_miss_tokens * p.miss + u.completion_tokens * p.output) / 1e6;
}
globalThis.fetch = async (url, options = {}) => {
  if (!String(url).startsWith(baseUrl + '/chat/completions')) return originalFetch(url, options);
  if (++billableRequests > 350 || knownTotalCost >= maxCost) throw new Error('Live acceptance request/cost budget exhausted');
  const trial = activeTrial;
  const body = JSON.parse(options.body);
  const receipt = { requestedModel: body.model, stream: !!body.stream, startedAt: new Date().toISOString() };
  trial?.billing.push(receipt);
  let response;
  try { response = await originalFetch(url, options); }
  catch (e) { receipt.transportError = e.name; receipt.transportCode = e.cause?.code || null; receipt.costUsd = null; throw e; }
  receipt.status = response.status;
  const consume = response.clone().text().then((raw) => {
    let parts;
    try { parts = [JSON.parse(raw)]; }
    catch { parts = raw.split(/\r?\n/).filter((s) => s.startsWith('data:') && !s.includes('[DONE]'))
      .flatMap((s) => { try { return [JSON.parse(s.slice(5))]; } catch { return []; } }); }
    receipt.responseIds = [...new Set(parts.map((j) => j.id).filter(Boolean))];
    receipt.servedModel = parts.find((j) => j.model)?.model || null;
    receipt.usage = parts.findLast((j) => j.usage)?.usage || null;
    receipt.rawOutput = parts.map((j) => j.choices?.[0]?.message?.content || j.choices?.[0]?.delta?.content || '').join('');
    receipt.costUsd = priceReceipt(receipt);
    receipt.finishedAt = new Date().toISOString();
    knownTotalCost += receipt.costUsd ?? 0;
  }).catch(() => { receipt.costUsd = null; });
  pendingBills.add(consume);
  consume.finally(() => pendingBills.delete(consume));
  return response;
};

const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'p0-live-acceptance', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {} };
const parseSSE = (raw) => raw.split(/\r?\n\r?\n/).flatMap((block) => {
  const data = block.split('\n').find((s) => s.startsWith('data:'));
  try { return data ? [JSON.parse(data.slice(5))] : []; } catch { return []; }
});
const allowedTools = new Set(['read_file', 'write_file', 'append_file', 'list_dir', 'grep', 'search_files',
  'apply_patch', 'run_command', 'memory_add', 'memory_search', 'get_time']);
function instrument(agent, trial) {
  for (const client of new Set([agent.llm, ...agent.allProviders])) {
    if (!client || client.__liveRecorded) continue;
    client.__liveRecorded = true;
    const orig = client.apiChat.bind(client);
    client.apiChat = async (messages, options) => {
      if (trial.kind.endsWith('provider-fallback') && client === agent.allProviders[0]
        && trial.executions.some((e) => e.tool === 'append_file' && e.ok) && !trial.faultInjected) {
        trial.faultInjected = true;
        trial.faults.push({ kind: 'provider', afterReceipt: true, beforeRemoteRequest: true });
        throw new Error('Controlled provider failure after committed append receipt');
      }
      const result = await orig(messages, options);
      trial.modelSteps.push({ provider: client.providerId, toolReceiptsInContext: messages.filter((m) => m.role === 'tool').length,
        content: result.message?.content || null });
      for (const tc of result.message?.tool_calls || []) {
        let args = null, parseError = false;
        try { args = JSON.parse(tc.function.arguments); } catch { parseError = true; }
        const meta = agent.tools.tools.get(tc.function?.name);
        const schemaError = meta && !parseError ? validateArgs(meta, structuredClone(args)) : null;
        trial.proposals.push({ id: tc.id, tool: tc.function?.name, args, parseError,
          unknownTool: !meta, unavailableTool: !!meta && meta.enabled === false, schemaError });
      }
      return result;
    };
  }
  agent.bus.on('*', (event) => {
    if (/^(tool\/|llm\/fallback|approval\/)/.test(event.type)) trial.events.push(event);
  });
  const emitDone = agent._emitToolDone.bind(agent);
  agent._emitToolDone = (id, tool, args, ok, durationMs, result) => {
    trial.executions.push({ id, tool, args, ok, durationMs, result });
    return emitDone(id, tool, args, ok, durationMs, result);
  };
  // Only a specific, user-authorized synthetic fixture command can be approved.
  agent.registerApprovalSurface('live-test-fixture');
  agent.bus.on('approval/requested', ({ payload: req }) => {
    const approved = req.tool === 'run_command' && /^(?:node|"[^"\r\n]+node\.exe") fail-once\.cjs$/.test(req.args?.command || '');
    agent.resolveApproval(req.id, approved ? 'approve' : 'deny');
  });
}
function makeAgent(root, trial, { tools = true, fallback = false } = {}) {
  const provider = (id) => ({ id, model, base_url: baseUrl, api_key_env: keyEnv, context_window: 32768,
    timeout_ms: 45000, retry_max: 3 });
  const config = { providers: [provider('primary'), ...(fallback ? [provider('secondary')] : [])],
    agent: { localIntent: false, proactive: { enabled: false }, evolve: { enabled: false },
      model_preference: 'cloud', max_tool_rounds: 8, parallel_tool_calls: false, approval_timeout_ms: 2000 },
    embedding: { enabled: false }, security: { pii_reply_mask: trial.kind.startsWith('pii-') },
    channels: { http: { mcp: { enabled: true } } } };
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'ppx.json'), JSON.stringify(config));
  process.env[keyEnv] = apiKey;
  let agent;
  try { agent = new PPXAgent({ root, dataDir: path.join(root, '.data'), globalDataDir: path.join(root, '.data') }); }
  finally { delete process.env[keyEnv]; }
  for (const name of agent.tools.tools.keys()) if (!allowedTools.has(name)) agent.tools.disable(name);
  agent.toolsEnabled = tools;
  instrument(agent, trial);
  return agent;
}
async function endpoint(agent, trial) {
  const channel = new HttpChannel(agent, { port: 0, host: '127.0.0.1' });
  // Test-only loopback auth remains in memory; avoid the server's bootstrap token log/file.
  channel.authToken = crypto.randomBytes(24).toString('hex');
  channel._persistedTokenFile = null;
  await channel.connect();
  const base = `http://127.0.0.1:${channel.server.address().port}`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${channel.authToken}` };
  return { channel,
    async chat(message, stream = false) {
      const response = await originalFetch(base + (stream ? '/message/stream' : '/message'),
        { method: 'POST', headers, body: JSON.stringify({ message, sessionId: trial.id }) });
      if (response.status !== 200) throw new Error(`HTTP outlet status ${response.status}`);
      if (!stream) return (await response.json()).reply;
      const raw = await response.text(); trial.outletFrames = parseSSE(raw);
      return trial.outletFrames.findLast((j) => j.type === 'done')?.content || '';
    },
    async mcp(message, stream = false) {
      const response = await originalFetch(base + '/mcp', { method: 'POST',
        headers: { ...headers, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: stream ? 'ppx.chat.stream' : 'ppx.chat.send', arguments: { message, sessionId: trial.id }, _meta: META } }) });
      if (response.status !== 200) throw new Error(`MCP outlet status ${response.status}`);
      const raw = await response.text();
      const frames = response.headers.get('content-type')?.includes('text/event-stream') ? parseSSE(raw) : [JSON.parse(raw)];
      trial.outletFrames = frames;
      const final = frames.findLast((j) => j.id === 1 && j.result);
      if (!final || final.result.isError) throw new Error('MCP did not return a successful final result');
      return final.result.content?.filter((c) => c.type === 'text').map((c) => c.text).join('') || '';
    } };
}
const readJson = (root, file) => { try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); } catch { return null; } };
const successful = (t, tool) => t.executions.some((e) => e.tool === tool && e.ok);
const targetIndex = (t, tool, file, after = -1) => t.executions.findIndex((e, i) => i > after && e.ok && e.tool === tool
  && path.resolve(t.root, e.args?.path || '') === path.resolve(t.root, file)
  && t.events.some((event) => event.type === 'tool/result' && event.payload.callId === e.id && event.payload.ok));
const writtenThenRead = (t, writer, file) => {
  const i = targetIndex(t, writer, file);
  return i >= 0 && targetIndex(t, 'read_file', file, i) > i;
};
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tasks = [
  { id: 'create-json', async run(root, t, api) {
    t.reply = await api.chat(`请创建 deliverable.json，内容为JSON对象 {"task":"${t.nonce}","items":[2,4,6],"sum":12}。写后重新读取核对再告诉我结果。`);
    t.artifacts = { 'deliverable.json': readJson(root, 'deliverable.json') };
    const j = t.artifacts['deliverable.json'];
    return j?.task === t.nonce && j.sum === 12 && JSON.stringify(j.items) === '[2,4,6]' && Object.keys(j).length === 3
      && writtenThenRead(t, 'write_file', 'deliverable.json');
  } },
  { id: 'csv-summary', async run(root, t, api) {
    fs.writeFileSync(path.join(root, 'sales.csv'), 'region,amount\nNorth,7\nSouth,5\nNorth,11\nSouth,-2\n');
    t.reply = await api.mcp('Read sales.csv, sum amount by region, and write summary.json as an object with keys North and South and numeric totals. Read the result back and verify it. Reply briefly in English.');
    t.artifacts = { 'summary.json': readJson(root, 'summary.json') };
    const j = t.artifacts['summary.json'];
    return j?.North === 18 && j?.South === 3 && Object.keys(j).length === 2
      && targetIndex(t, 'read_file', 'sales.csv') >= 0 && writtenThenRead(t, 'write_file', 'summary.json');
  } },
  { id: 'command-recovery', async run(root, t, api) {
    fs.writeFileSync(path.join(root, 'fail-once.cjs'), `const fs=require('fs'); const p='attempts.json'; const n=(fs.existsSync(p)?JSON.parse(fs.readFileSync(p)).n:0)+1; fs.writeFileSync(p,JSON.stringify({n})); if(n===1)process.exit(7); fs.writeFileSync('command-result.json',JSON.stringify({token:'${t.nonce}',attempts:n})); console.log('receipt committed');`);
    const before = hashFile(path.join(root, 'fail-once.cjs'));
    t.reply = await api.chat('这是Windows工作区。请运行命令 node fail-once.cjs 生成 command-result.json。只批准这个精确命令，不拼接echo或其他命令。首次运行会发生一次可恢复错误；发生错误后根据工具回执重试，再读取结果确认。不要修改程序。');
    const j = readJson(root, 'command-result.json');
    t.artifacts = { 'command-result.json': j, 'attempts.json': readJson(root, 'attempts.json') };
    t.faultInjected = t.executions.some((e) => e.tool === 'run_command' && e.ok === false);
    t.fixtureUnchanged = before === hashFile(path.join(root, 'fail-once.cjs'));
    const executed = t.executions.findIndex((e) => e.tool === 'run_command' && e.ok);
    return t.faultInjected && t.fixtureUnchanged && j?.token === t.nonce && j.attempts === 2
      && executed >= 0 && targetIndex(t, 'read_file', 'command-result.json', executed) > executed;
  } },
  { id: 'provider-fallback', fallback: true, async run(root, t, api) {
    fs.writeFileSync(path.join(root, 'append.txt'), 'existing\n');
    t.reply = await api.chat(`使用 append_file 向 append.txt 末尾追加一行 ${t.nonce}，仅追加一次，保留已有内容。然后读取核对，告诉我结果。`);
    const content = fs.readFileSync(path.join(root, 'append.txt'), 'utf8');
    t.artifacts = { 'append.txt': content };
    const count = content.split(/\r?\n/).filter((s) => s === t.nonce).length;
    return t.faultInjected && count === 1 && content.startsWith('existing\n')
      && t.events.some((e) => e.type === 'llm/fallback') && writtenThenRead(t, 'append_file', 'append.txt')
      && t.modelSteps.some((s) => s.provider === 'secondary' && s.toolReceiptsInContext > 0);
  } },
  { id: 'stream-provider-fallback', fallback: true, async run(root, t, api) {
    fs.writeFileSync(path.join(root, 'append.txt'), 'existing\n');
    t.reply = await api.chat(`使用 append_file 向 append.txt 末尾追加一行 ${t.nonce}，仅追加一次，保留已有内容。然后读取核对，告诉我结果。`, true);
    const content = fs.readFileSync(path.join(root, 'append.txt'), 'utf8');
    t.artifacts = { 'append.txt': content };
    return t.faultInjected && content.split(/\r?\n/).filter((s) => s === t.nonce).length === 1
      && content.startsWith('existing\n') && writtenThenRead(t, 'append_file', 'append.txt')
      && t.events.some((e) => e.type === 'llm/fallback')
      && t.modelSteps.some((s) => s.provider === 'secondary' && s.toolReceiptsInContext > 0)
      && t.outletFrames.some((frame) => frame.type === 'done');
  } },
  { id: 'memory-restart', async run(root, t, api, agent) {
    t.reply = await api.chat(`用 memory_add 保存虚构项目“验收水星”的代号 ${t.nonce}。明确执行工具写入，不要仅口头确认。`);
    t.artifacts = { stored: agent.facts.list().filter((f) => String(f.content).includes(t.nonce)) };
    await api.channel.disconnect(); await agent.shutdown();
    const restarted = makeAgent(root, t);
    const again = await endpoint(restarted, t);
    try { t.recallReply = await again.chat('刚才保存的虚构项目“验收水星”的代号是什么？请从长期记忆查找后回答。'); }
    finally { await again.channel.disconnect(); await restarted.shutdown(); }
    return t.artifacts.stored.length > 0 && successful(t, 'memory_add') && t.recallReply.includes(t.nonce);
  } },
  { id: 'pii-http-tools', async run(root, t, api) {
    t.reply = await api.chat('这是虚构的脱敏验收数据。先用get_time查询时间，再原样输出联系人 synthetic-pii@example.invalid 和手机13800138000，同时输出标记 PII_TEST_COMPLETE。', true);
    await Promise.allSettled([...pendingBills]);
    const raw = t.billing.map((b) => b.rawOutput || '').join('');
    const outlet = JSON.stringify(t.outletFrames);
    return raw.includes('synthetic-pii@example.invalid') && raw.includes('13800138000')
      && !outlet.includes('synthetic-pii@example.invalid') && !outlet.includes('13800138000')
      && t.reply.includes('PII_TEST_COMPLETE') && t.reply.includes('[REDACTED]') && successful(t, 'get_time');
  } },
  { id: 'pii-mcp-direct', tools: false, async run(root, t, api) {
    t.reply = await api.mcp('Repeat these fictional acceptance strings exactly: synthetic-pii@example.invalid and 13800138000. Also include PII_TEST_COMPLETE.', true);
    await Promise.allSettled([...pendingBills]);
    const raw = t.billing.map((b) => b.rawOutput || '').join('');
    const outlet = JSON.stringify(t.outletFrames);
    return raw.includes('synthetic-pii@example.invalid') && raw.includes('13800138000')
      && !outlet.includes('synthetic-pii@example.invalid') && !outlet.includes('13800138000')
      && t.reply.includes('PII_TEST_COMPLETE') && t.reply.includes('[REDACTED]');
  } },
];
const selected = option('--only', '').split(',').filter(Boolean);
if (selected.some((id) => !tasks.some((t) => t.id === id))) throw new Error('Unknown task ID');
const trials = [];
const startedAt = new Date().toISOString();
try {
  for (const task of tasks.filter((t) => !selected.length || selected.includes(t.id))) {
    for (let repeat = 1; repeat <= repetitions; repeat++) {
      const trial = { id: `${task.id}-${repeat}`, kind: task.id, repeat, nonce: `PX-${crypto.randomBytes(4).toString('hex')}`,
        proposals: [], executions: [], events: [], billing: [], modelSteps: [], faults: [], semanticReview: null };
      trials.push(trial); activeTrial = trial;
      const root = path.join(output, trial.id);
      trial.root = root;
      fs.mkdirSync(root);
      const t0 = performance.now();
      let agent, api;
      try {
        agent = makeAgent(root, trial, task);
        api = await endpoint(agent, trial);
        trial.pass = !!(await task.run(root, trial, api, agent));
      } catch (e) { trial.pass = false; trial.error = String(e.message).replaceAll(apiKey, '[REDACTED]'); }
      finally {
        await api?.channel.disconnect(); await agent?.shutdown();
        await Promise.allSettled([...pendingBills]);
      }
      trial.durationMs = Math.round(performance.now() - t0);
      trial.agentUsage = agent?.usageStats;
      trial.costUsd = trial.billing.every((b) => b.costUsd != null) ? trial.billing.reduce((n, b) => n + b.costUsd, 0) : null;
      write(path.join(root, 'receipt.json'), trial);
      write(path.join(output, 'trials.json'), trials);
      console.log(JSON.stringify({ trial: trial.id, pass: trial.pass, proposals: trial.proposals.length,
        durationMs: trial.durationMs, costUsd: trial.costUsd, error: trial.error || null }));
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  const passes = trials.filter((t) => t.pass).length;
  const proposals = trials.flatMap((t) => t.proposals);
  const recoverable = trials.filter((t) => ['provider-fallback', 'stream-provider-fallback', 'command-recovery'].includes(t.kind) && t.faultInjected);
  const totalCost = trials.every((t) => t.costUsd != null) ? trials.reduce((n, t) => n + t.costUsd, 0) : null;
  const report = { schema: 'ppx-live-acceptance-v1', startedAt, completedAt: new Date().toISOString(), model,
    priceSource: 'https://api-docs.deepseek.com/quick_start/pricing/', priceCheckedAt: '2026-10-10',
    currency: 'USD', priceBasis: 'off-peak weekend; provider usage times published rates; not an invoice', priceBook,
    taskVersion: 'synthetic-p0-v3', repeatsPerTask: repetitions, taskCount: trials.length, successes: passes,
    completionRate: trials.length ? passes / trials.length : null,
    proposals: proposals.length, unknownTools: proposals.filter((p) => p.unknownTool).length,
    unknownToolRate: proposals.length ? proposals.filter((p) => p.unknownTool).length / proposals.length : null,
    schemaInvalidParameters: proposals.filter((p) => p.parseError || p.schemaError).length,
    parameterHallucinationRate: null, shadowCallRate: null, semanticReviewStatus: 'requires trajectory review of arguments and final action claims',
    recoverableTasks: recoverable.length, recoveredTasks: recoverable.filter((t) => t.pass).length,
    recoveryRate: recoverable.length ? recoverable.filter((t) => t.pass).length / recoverable.length : null,
    knownCostUsd: knownTotalCost, totalCostUsd: totalCost, costPerSuccessfulTaskUsd: passes && totalCost != null ? totalCost / passes : null,
    unknownCostTasks: trials.filter((t) => t.costUsd == null).length,
    limits: 'Controlled faults and one real model; not production sampling or population-wide stability. Safety PII uses fictional identifiers.' };
  write(path.join(output, 'summary.json'), report);
  write(path.join(output, 'trials.json'), trials);
  process.exitCode = passes === trials.length && trials.length > 0 ? 0 : 1;
}
