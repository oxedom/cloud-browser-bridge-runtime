import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {Transform, Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {ROOT, ORIGIN, cleanEnv, PRIVATE_ENV, privateDir, privateWrite, save, readJSON, statePath, id, request, sleep, processRecord, configureNetwork} from './common.mjs';
import {lock, setup, verify, loadIdentity, operatorAPI} from './bridge.mjs';

export function validateAuth(provider, raw) {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 256000) throw new Error();
    if (provider === 'codex') {
      const value = JSON.parse(raw);
      if (value.OPENAI_API_KEY || (value.auth_mode ?? 'chatgpt') !== 'chatgpt' ||
          !['access_token', 'id_token', 'refresh_token'].every(k => typeof value.tokens?.[k] === 'string' && value.tokens[k].length >= 16)) throw new Error();
      return {...value, auth_mode: 'chatgpt', OPENAI_API_KEY: null};
    }
    if (provider !== 'claude' || !/^sk-ant-oat\S{22,}$/.test(raw.trim())) throw new Error();
    return raw.trim();
  } catch { throw new Error('Supply supported subscription CLI credentials, not an API key or browser cookie.'); }
}
export function consumeAuth(options = {}) {
  const inputs = ['NEOFETCH', 'NEOFETCH_FILE'].filter(key => process.env[key]);
  const values = Object.fromEntries(inputs.map(key => [key, process.env[key]]));
  for (const key of PRIVATE_ENV) if (key.startsWith('NEOFETCH') || key.startsWith('BRIDGE_AGENT_AUTH')) delete process.env[key];
  if (inputs.length !== 1) throw new Error('Supply exactly one of NEOFETCH or NEOFETCH_FILE, or use a one-use link.');
  let raw;
  if (inputs[0] === 'NEOFETCH') {
    const text = values.NEOFETCH;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length > 350000) throw new Error('Invalid NEOFETCH base64 input.');
    raw = Buffer.from(text, 'base64').toString('utf8');
  } else {
    if (fs.statSync(values.NEOFETCH_FILE).size > 512000) throw new Error('Credential package is too large.');
    raw = fs.readFileSync(values.NEOFETCH_FILE, 'utf8');
  }
  let provider = options.agent || 'codex';
  try {
    const capsule = JSON.parse(raw);
    if (capsule && typeof capsule.auth === 'string' && ['codex', 'claude'].includes(capsule.provider)) {
      if (options.agent && options.agent !== capsule.provider) throw new Error('Provider does not match the credential package.');
      provider = capsule.provider; raw = capsule.auth;
    }
  } catch (error) { if (error.message.includes('Provider does not match')) throw error; }
  return {provider, auth: validateAuth(provider, raw)};
}
function inspectionEnv(root, provider) {
  const env = cleanEnv();
  // These variables select each CLI's private profile only in its child process.
  const folder = path.join(statePath(root), 'coding', provider); privateDir(folder);
  if (provider === 'codex') env.CODEX_HOME = folder;
  else env.CLAUDE_CONFIG_DIR = folder;
  return env;
}
export function codingEnv(root, provider, authFile) {
  const env = inspectionEnv(root, provider);
  if (provider === 'codex') env.CODEX_HOME = path.dirname(authFile);
  else env.CLAUDE_CODE_OAUTH_TOKEN = readJSON(authFile).token;
  return env;
}
export function configureAuth(root, provider, auth) {
  const folder = path.join(statePath(root), 'coding', provider); privateDir(folder);
  const file = path.join(folder, provider === 'codex' ? 'auth.json' : 'subscription.json');
  save(file, provider === 'codex' ? auth : {token: auth});
  return file;
}
const run = (binary, args, env = cleanEnv()) => spawnSync(binary, args, {env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024});
export function compatible(provider, binary, env = cleanEnv()) {
  if (!binary || !fs.existsSync(binary)) return false;
  if (provider === 'codex') {
    const native = fs.realpathSync(binary), folder = path.dirname(native), packageRoot = path.dirname(folder);
    const paths = [path.join(folder, 'codex-code-mode-host'), path.join(folder, 'codex-exec-server'),
      path.join(packageRoot, 'codex-resources/bwrap'), path.join(packageRoot, 'codex-path/rg')];
    if (!fs.existsSync(path.join(packageRoot, 'codex-package.json')) || !paths.every(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } })) return false;
    const host = run(paths[0], ['--help'], env);
    if (host.status !== 0 || !host.stdout.includes('--listen')) return false;
    const global = run(binary, ['--help'], env);
    if (global.status !== 0 || !global.stdout.includes('--no-daemon')) return false;
  }
  const version = run(binary, ['--version'], env), help = run(binary, provider === 'codex' ? ['exec', '--help'] : ['--help'], env);
  return version.status === 0 && help.status === 0 && help.stdout.includes(provider === 'codex' ? '--ignore-user-config' : '--permission-prompts');
}
function findFiles(folder) {
  return fs.readdirSync(folder, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? findFiles(path.join(folder, entry.name)) : entry.isFile() ? [path.join(folder, entry.name)] : []);
}
async function jsonFetch(url) { const response = await fetch(url, {signal: AbortSignal.timeout(30000)}); if (!response.ok) throw new Error('Official CLI metadata download failed.'); return response.json(); }
export async function installCLI(root, provider) {
  const env = inspectionEnv(root, provider);
  const which = run('/bin/sh', ['-c', 'command -v ' + provider]);
  if (which.status === 0 && compatible(provider, which.stdout.trim(), env)) return which.stdout.trim();
  const cache = path.join(root, '.runtime', 'coding-cli', provider); privateDir(cache);
  const info = path.join(cache, 'installed.json');
  if (fs.existsSync(info)) { const binary = readJSON(info).binary; if (compatible(provider, binary, env)) return binary; }
  const arch = {x64: 'x86_64', arm64: 'aarch64'}[process.arch];
  if (process.platform !== 'linux' || !arch) throw new Error('Automatic coding CLI install supports Linux x64 and ARM64.');
  let url, algorithm, expected;
  if (provider === 'codex') {
    const release = await jsonFetch('https://api.github.com/repos/openai/codex/releases/latest');
    const name = `codex-package-${arch}-unknown-linux-musl.tar.gz`;
    const asset = release.assets.find(a => a.name === name);
    if (!asset?.digest?.startsWith('sha256:')) throw new Error('Complete official Codex package/checksum not found.');
    url = asset.browser_download_url; algorithm = 'sha256'; expected = Buffer.from(asset.digest.slice(7), 'hex');
  } else {
    const musl = fs.readdirSync('/lib').some(name => name.startsWith('ld-musl-') && name.endsWith('.so.1')) ? '-musl' : '';
    const release = await jsonFetch('https://registry.npmjs.org/@anthropic-ai/claude-code-linux-' + process.arch + musl + '/latest');
    if (!release.dist.integrity.startsWith('sha512-')) throw new Error('Official Claude checksum not found.');
    url = release.dist.tarball; algorithm = 'sha512'; expected = Buffer.from(release.dist.integrity.slice(7), 'base64');
  }
  console.log('Downloading the complete official ' + provider + ' package...');
  const response = await fetch(url, {signal: AbortSignal.timeout(240000)});
  if (!response.ok) throw new Error('Official CLI download failed.');
  const archive = path.join(cache, 'package.tar.gz'), hash = createHash(algorithm); let bytes = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({transform(chunk, _encoding, callback) {
    bytes += chunk.length; if (bytes > 512 * 1024 * 1024) return callback(new Error('CLI archive exceeded its size limit.'));
    hash.update(chunk); callback(null, chunk);
  }}), fs.createWriteStream(archive, {mode: 0o600}));
  if (!hash.digest().equals(expected)) throw new Error('CLI checksum mismatch; downloaded code was not executed.');
  const list = run('tar', ['-tzf', archive]), types = run('tar', ['-tvzf', archive]);
  if (list.status || types.status || list.stdout.split('\n').filter(Boolean).some(name => name.startsWith('/') || name.split('/').includes('..')) ||
      types.stdout.split('\n').filter(Boolean).some(line => !['-', 'd'].includes(line[0]))) throw new Error('Unsafe CLI archive.');
  const destination = path.join(cache, 'package'); privateDir(destination);
  if (run('tar', ['-xzf', archive, '-C', destination]).status) throw new Error('CLI package extraction failed.');
  const files = findFiles(destination).filter(file => path.basename(file) === provider);
  if (files.length !== 1) throw new Error('Official CLI entry point not found.');
  fs.chmodSync(files[0], 0o700);
  if (!compatible(provider, files[0], env)) throw new Error('Official CLI package is incomplete or cannot run on this machine.');
  save(info, {binary: files[0]}); return files[0];
}
export function checkAuth(root, provider, binary, authFile) {
  const result = run(binary, provider === 'codex' ? ['-c', 'cli_auth_credentials_store="file"', 'login', 'status'] : ['auth', 'status', '--json'], codingEnv(root, provider, authFile));
  let valid = false;
  if (provider === 'codex') valid = /chatgpt/i.test(result.stdout + result.stderr);
  else { try { const data = JSON.parse(result.stdout); valid = data.loggedIn === true && /oauth|claude/i.test(data.authMethod); } catch {} }
  if (result.status !== 0 || !valid) throw new Error('CLI did not confirm subscription authentication; no interactive login or API fallback was started.');
}
export const codingCommand = job => job.provider === 'codex' ? [job.binary, '--no-daemon', '-a', 'never', '-c', 'cli_auth_credentials_store="file"', 'exec',
  '--sandbox', 'danger-full-access', '--ignore-user-config', '--skip-git-repo-check', '--color', 'never', '--json', '--cd', job.root, '-'] :
  [job.binary, '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep', '--setting-sources', 'project'];
export function runCoding(job, log) {
  const data = readJSON(job.authFile);
  const prompt = fs.readFileSync(path.join(job.root, 'PROMPT.md'));
  const secrets = (job.provider === 'codex' ? Object.values(data.tokens) : [data.token]).filter(v => typeof v === 'string' && v.length >= 16);
  const redact = text => { for (const value of secrets) text = text.split(value).join('[REDACTED]'); return text; };
  return new Promise((resolve, reject) => {
    const [binary, ...args] = codingCommand(job);
    const child = spawn(binary, args, {cwd: job.root, env: codingEnv(job.root, job.provider, job.authFile), detached: true, stdio: ['pipe', 'pipe', 'pipe']});
    let finished = false;
    const timers = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, job.timeout * 1000);
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = '', oversized = false;
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) { if (!oversized) fs.writeSync(log, redact(buffer.slice(0, index)) + '\n'); buffer = buffer.slice(index + 1); oversized = false; }
        if (buffer.length > 4 * 1024 * 1024) { fs.writeSync(log, '[oversized coding event omitted]\n'); buffer = ''; oversized = true; }
      });
      stream.on('end', () => { if (buffer && !oversized) fs.writeSync(log, redact(buffer)); });
    }
    child.once('error', () => { if (!finished) { finished = true; clearTimeout(timers); reject(new Error('Coding CLI could not start.')); } });
    child.once('close', code => { if (finished) return; finished = true; clearTimeout(timers); code === 0 ? resolve() : reject(new Error('Coding CLI failed or timed out. Inspect its private redacted log.')); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
async function supervise(file) {
  const job = readJSON(file), log = fs.openSync(job.log, 'w', 0o600);
  try {
    job.state = 'running'; save(file, job);
    await runCoding(job, log);
    job.proof = await verify(job.root, loadIdentity(job.root)); job.state = 'done';
  } catch (error) { job.state = 'failed'; job.error = error.message; }
  finally { fs.closeSync(log); job.finished = Date.now(); save(file, job); }
}
export async function installWithAgent(root, options) {
  const {provider, auth} = consumeAuth(options), timeout = Number(options.timeout || 900);
  const fingerprint = createHash('sha256').update(JSON.stringify(auth)).digest('hex');
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 7200) throw new Error('Coding task timeout must be 30–7200 seconds.');
  const file = await lock(root, 'coding-setup', async () => {
    const active = path.join(statePath(root), 'coding-active.json');
    if (fs.existsSync(active)) {
      const previous = readJSON(active);
      if (previous.started && processRecord(previous.pid) === previous.started) {
        if (previous.provider !== provider || previous.fingerprint !== fingerprint) throw new Error('Another coding task is active; its credentials were preserved.');
        return previous.file;
      }
    }
    const binary = await installCLI(root, provider), authFile = configureAuth(root, provider, auth);
    checkAuth(root, provider, binary, authFile);
    await setup(root, options.port ? {port: Number(options.port)} : {});
    const ident = id(), jobFile = path.join(statePath(root), 'coding-' + ident + '.json');
    save(jobFile, {root, provider, binary, authFile, timeout, state: 'starting', log: path.join(statePath(root), 'coding-' + ident + '.log')});
    const child = spawn(process.execPath, [path.join(root, 'coding.mjs'), '_run', jobFile], {cwd: root, env: cleanEnv(), detached: true, stdio: 'ignore'});
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    save(active, {pid: child.pid, started: processRecord(child.pid), file: jobFile, provider, fingerprint}); child.unref(); return jobFile;
  });
  console.log('Coding task is running as a detached job; status: ' + file);
  const deadline = Date.now() + timeout * 1000 + 150000;
  while (Date.now() < deadline) {
    const job = readJSON(file);
    if (job.state === 'done') { console.log('Coding task finished; bridge command verified. Machine: ' + job.proof.vm_id); return; }
    if (job.state === 'failed') throw new Error(job.error + ' The native bridge state was preserved.');
    const active = readJSON(path.join(statePath(root), 'coding-active.json'));
    if (!processRecord(active.pid)) throw new Error('Coding supervisor stopped; bridge state and the existing status file were preserved.');
    await sleep(500);
  }
  throw new Error('Coding task remains unconfirmed; inspect its existing status file instead of starting a new identity.');
}
export async function createLink(root, options) {
  if (!options['controller-config']) throw new Error('Provide --controller-config pointing to an existing administrator profile (read only).');
  const cfg = readJSON(path.resolve(options['controller-config'])); cfg.origin ||= ORIGIN;
  const provider = options.agent || 'codex';
  const file = options['auth-file'] || (provider === 'codex' ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json') : null);
  const raw = file ? fs.readFileSync(file, 'utf8') : process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const value = validateAuth(provider, raw), auth = provider === 'codex' ? JSON.stringify(value) : value;
  const created = await operatorAPI(cfg, '/api/agent-links', {provider, auth});
  const url = new URL(created.url);
  const command = 'curl -fsSL ' + url.href + ' | bash';
  const destination = path.join(statePath(root), 'agent-link.sh'); privateWrite(destination, command + '\n');
  save(path.join(statePath(root), 'agent-link.json'), {provider, expires: created.expires, command});
  if (options.copy) {
    const which = run('/bin/sh', ['-c', 'command -v wl-copy || command -v xclip']);
    if (which.status !== 0) throw new Error('Clipboard unavailable; command saved privately at ' + destination);
    const binary = which.stdout.trim().split('\n')[0];
    const copied = spawn(binary, path.basename(binary) === 'xclip' ? ['-selection', 'clipboard'] : ['--sensitive'],
      {detached: true, stdio: ['pipe', 'ignore', 'ignore']});
    await new Promise((resolve, reject) => {
      copied.once('error', reject);
      copied.stdin.once('error', reject);
      copied.stdin.end(command, resolve);
    }).catch(() => { throw new Error('Clipboard failed; private command is saved at ' + destination); });
    copied.unref();
    console.log('Install command copied. Single use, valid for five minutes.');
  } else console.log('Private install command saved at ' + destination + ' (five minutes, single use).');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '_run') {
  process.umask(0o077); configureNetwork(); supervise(process.argv[3]).catch(() => { console.error('Coding supervisor stopped; inspect its private status file.'); process.exitCode = 1; });
}
