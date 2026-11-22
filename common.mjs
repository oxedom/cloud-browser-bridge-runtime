import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import tls from 'node:tls';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const ORIGIN = 'https://workspace.brinked.ai';
export const PRIVATE_ENV = ['NEOFETCH', 'NEOFETCH_FILE', 'BRIDGE_AGENT_AUTH', 'BRIDGE_AGENT_AUTH_B64',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
export const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !PRIVATE_ENV.includes(k)));
export const id = () => randomUUID().replaceAll('-', '');
export const token = () => randomBytes(48).toString('base64url');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const readJSON = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('Invalid private state file: ' + path.basename(file)); throw error; }
};
export const statePath = root => path.join(root, '.state');

export function configureNetwork() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled.');
  if (typeof http.setGlobalProxyFromEnv !== 'function' || typeof tls.setDefaultCACertificates !== 'function') {
    throw new Error('Node 24.22.3+ is required; use the curl installer to install a private runtime.');
  }
  tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]);
  http.setGlobalProxyFromEnv({http_proxy: process.env.http_proxy ?? process.env.HTTP_PROXY,
    https_proxy: process.env.https_proxy ?? process.env.HTTPS_PROXY,
    no_proxy: [process.env.no_proxy ?? process.env.NO_PROXY, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',')});
}

export function privateDir(folder) {
  fs.mkdirSync(folder, {recursive: true, mode: 0o700}); fs.chmodSync(folder, 0o700);
}
export function privateWrite(file, content) {
  privateDir(path.dirname(file));
  const temporary = file + '.' + id() + '.tmp';
  try { fs.writeFileSync(temporary, content, {mode: 0o600, flag: 'wx'}); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, {force: true}); }
}
export const save = (file, value) => privateWrite(file, JSON.stringify(value, null, 2) + '\n');
export const sameSecret = (a, b) => {
  const aa = Buffer.from(a || ''), bb = Buffer.from(b || '');
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export async function request(url, credential, body, {timeout = 30000} = {}) {
  const destination = new URL(url);
  if (destination.username || destination.password) throw new Error('Put credentials in authentication headers, not URLs.');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(destination.hostname);
  if ((credential || body !== undefined) && destination.protocol !== 'https:' && !(destination.protocol === 'http:' && loopback)) {
    throw new Error('Authenticated bridge traffic requires HTTPS outside loopback.');
  }
  const response = await fetch(url, {method: body === undefined ? 'GET' : 'POST',
    headers: {'Content-Type': 'application/json', ...(credential ? {Authorization: 'Bearer ' + credential} : {})},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout), redirect: 'error'});
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new RequestError(response.status, 'Endpoint returned an invalid response.'); }
  if (!response.ok) throw new RequestError(response.status, typeof data?.error === 'string' ? data.error : 'Request rejected.');
  return data;
}
export async function retry(fn, attempts = 3) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (error) {
      if (attempt + 1 >= attempts || (error.status && error.status < 500 && ![408, 429].includes(error.status))) throw error;
      await sleep((attempt + 1) * 1000);
    }
  }
}

export function processRecord(pid) {
  try {
    const values = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' ');
    return values[0] === 'Z' ? null : values[19];
  } catch { return null; }
}
export function serviceAlive(root, name) {
  try { const value = readJSON(path.join(statePath(root), name + '.pid.json')); return !!value.started && processRecord(value.pid) === value.started; }
  catch { return false; }
}
