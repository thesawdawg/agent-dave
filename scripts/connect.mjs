#!/usr/bin/env node
// Connect pi to the studio's models. setup.sh and setup.ps1 run this for you.
//
//   node scripts/connect.mjs               ask for the address and key, then write the models
//   node scripts/connect.mjs --forget-key  remove the saved studio connection (shared machines)
//   node scripts/connect.mjs --judge       connect the guard's judge: a separate decision model
//   node scripts/connect.mjs --forget-judge  remove the saved judge connection
//   node scripts/connect.mjs --custom --result <file>  any OpenAI-compatible endpoint (scripts/android-setup.sh)
//     (--current <provider> --current-model <id> offer the saved endpoint's answers as defaults)
//
// It asks for the studio address and your API key, reads the list of models the
// endpoint offers, and writes an "aistudio" provider into pi's models.json
// (~/.pi/agent/models.json). Other providers in that file are kept.
//
// Works with Open WebUI (models at /api/models, chat at /api/chat/completions) and
// with any OpenAI-compatible endpoint (models at /v1/models).
// AISTUDIO_URL and AISTUDIO_API_KEY in the environment skip the questions.
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The studio address setup offers by default, so you can just press Enter.
const DEFAULT_URL = "https://gpt.lib.k-state.edu";

const PROVIDER = "aistudio";
const AGENT_DIR = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
const MODELS_FILE = path.join(AGENT_DIR, "models.json");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const say = (s = "") => process.stdout.write(s + "\n");
const ok = (s) => say(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => say(`  \x1b[33m!\x1b[0m ${s}`);

// ---------- prompts ----------
// One shared reader: separate readers on piped input can each swallow lines.
// Lines are queued, so answers piped in all at once aren't lost between questions.
let rl = null;
const lines = [];
const waiting = [];
let ended = false;
function reader() {
  if (!rl) {
    rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
    rl.on("close", () => {
      rl = null;
      // askHidden closes the reader to take raw keys; only the end of input means no more answers.
      if (process.stdin.readableEnded || !process.stdin.isTTY) { ended = true; while (waiting.length) waiting.shift()(""); }
    });
  }
  return rl;
}
function ask(question, { hidden = false } = {}) {
  if (hidden && process.stdin.isTTY) return askHidden(question);
  process.stdout.write(question);
  reader();
  if (lines.length) return Promise.resolve(lines.shift().trim());
  if (ended) return Promise.resolve("");
  return new Promise((resolve) => waiting.push((line) => resolve(line.trim())));
}

// Read a secret from the terminal, showing a dot per character.
function askHidden(question) {
  rl?.close();
  const { stdin, stdout } = process;
  return new Promise((resolve) => {
    let value = "";
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (answer) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      resolve(answer.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(value);
        if (ch === "\u0003") { stdin.setRawMode(false); stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") {
          if (value) { value = value.slice(0, -1); stdout.write("\b \b"); }
        } else if (ch >= " ") {
          value += ch;
          stdout.write("•");
        }
      }
    };
    stdin.on("data", onData);
  });
}

// ---------- the endpoint ----------
// People paste the address in many shapes. Try the likely API roots in order.
function candidates(raw) {
  const url = raw.trim().replace(/\/+$/, "").replace(/\/(chat\/completions|models)$/, "");
  if (/\/(api|v1)$/.test(url) || /\/api\/v1$/.test(url)) return [url];
  return [`${url}/api`, `${url}/v1`, url];
}

async function listModels(raw, key, who = "The studio") {
  if (!/^https?:\/\//i.test(raw.trim())) return { problem: "address", message: "The address should start with http:// or https://" };
  let last = "";
  for (const base of candidates(raw)) {
    let res;
    try {
      res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      last = `couldn't reach ${base} (${err.cause?.code || err.name})`;
      continue;
    }
    if (res.status === 401 || res.status === 403) return { problem: "key", message: `${who} didn't accept that key.` };
    if (!res.ok) { last = `${base}/models answered ${res.status}`; continue; }
    let body;
    try { body = await res.json(); } catch { last = `${base}/models didn't return JSON`; continue; }
    const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    if (!list) { last = `${base}/models didn't return a model list`; continue; }
    return { base, models: list };
  }
  return { problem: "address", message: `No model list found there: ${last}.` };
}

// Open WebUI lists arena (blind-comparison) entries too; they aren't real models.
const usable = (m) => m && typeof m.id === "string" && m.id && !m.arena && m.owned_by !== "arena";

// pi only sends a thinking level to models marked as reasoning models.
function isReasoning(m) {
  const caps = m.info?.meta?.capabilities || {};
  if (caps.reasoning === true || caps.thinking === true) return true;
  return /qwen3|deepseek-r1|gpt-oss|magistral|reason|think/i.test(m.id);
}

function toPiModel(m) {
  const out = { id: m.id };
  const name = m.name && m.name !== m.id ? String(m.name) : "";
  if (name) out.name = name;
  if (isReasoning(m)) out.reasoning = true;
  const ctx = Number(m.info?.params?.num_ctx || m.params?.num_ctx);
  if (Number.isFinite(ctx) && ctx > 0) out.contextWindow = ctx;
  return out;
}

// ---------- pi's files ----------
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    await writeFile(file + ".bak", await readFile(file)).catch(() => {});
    warn(`${file} wasn't valid JSON; saved a copy as models.json.bak and started fresh.`);
    return {};
  }
}

async function saveModels(config) {
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(MODELS_FILE, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(MODELS_FILE, 0o600).catch(() => {});
}

async function defaultModel() {
  try {
    return JSON.parse(await readFile(path.join(REPO, ".pi", "settings.json"), "utf8")).defaultModel || "";
  } catch {
    return "";
  }
}

// ---------- the guard's judge (a decision model, separate from DAVE's chat model) ----------
const JUDGE_FILE = path.join(AGENT_DIR, "guard-judge.json");
const GUARD_FILE = path.join(REPO, ".pi", "guard.jsonc");
const cleanJudgeUrl = (u) => u.trim().replace(/\/+$/, "").replace(/\/v1\/systemone$/, "").replace(/\/v1$/, "");
const authHeaders = (key) => ({ "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) });

async function decisionModels(url, key) {
  try {
    const tags = await (await fetch(`${url}/api/tags`, { headers: authHeaders(key), signal: AbortSignal.timeout(5000) })).json();
    const names = (tags?.models || []).map((m) => m.name || m.model).filter(Boolean).slice(0, 40);
    const caps = await Promise.all(names.map(async (name) => {
      try {
        const info = await (await fetch(`${url}/api/show`, { method: "POST", headers: authHeaders(key), body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(5000) })).json();
        return (info?.capabilities || []).includes("decision") ? name : "";
      } catch { return ""; }
    }));
    return caps.filter(Boolean);
  } catch { return []; }
}

// Ollama loads models with 4096 tokens of context unless the model sets num_ctx, and /v1/systemone
// ignores num_ctx in the request. Keep in step with MIN_JUDGE_CTX in .pi/extensions/guard.ts.
const MIN_JUDGE_CTX = 16384;

/**
 * Read the context size a judge model loads with.
 * @param {string} url The judge's address.
 * @param {string} model The model name.
 * @param {string} key The API key, or "".
 * @returns {Promise<number | undefined>} num_ctx, 0 if the model sets none (Ollama's default), or undefined if unknown.
 */
async function judgeContext(url, model, key) {
  try {
    const info = await (await fetch(`${url}/api/show`, { method: "POST", headers: authHeaders(key), body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) })).json();
    return Number(/^num_ctx\s+(\d+)/m.exec(String(info?.parameters || ""))?.[1] || 0);
  } catch { return undefined; }
}

async function probeJudge(url, model, key) {
  const started = Date.now();
  try {
    const res = await fetch(`${url}/v1/systemone`, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ model, keep_alive: "30m", state: { tool: "bash", command: "ls -la", folder: REPO },
        questions: { verdict: { type: "choice", instructions: "Should an assistant run this command without asking?", criteria: { allow: "Harmless", ask: "Needs approval", never: "Never" } } } }),
      signal: AbortSignal.timeout(60000), // the first call loads the model
    });
    if (res.status === 401 || res.status === 403) return { ok: false, message: "it didn't accept that key" };
    if (!res.ok) return { ok: false, message: `${url}/v1/systemone answered ${res.status}${res.status === 404 ? " (is this a System One endpoint, and is the model pulled?)" : ""}` };
    const v = (await res.json())?.answers?.verdict;
    if (!v?.choice) return { ok: false, message: "it answered, but not with a System One verdict" };
    return { ok: true, message: `answered in ${Date.now() - started} ms (ls -la → ${v.choice})` };
  } catch (err) {
    return { ok: false, message: `couldn't reach ${url} (${err.cause?.code || err.name})` };
  }
}

function setOtherCommands(value) {
  let text = readFileSync(GUARD_FILE, "utf8");
  const line = /^([ \t]*)(\/\/[ \t]*)?"otherCommands"[ \t]*:[ \t]*"[a-z]*"[ \t]*,?/m;
  const want = value ? `"otherCommands": "${value}",` : `// "otherCommands": "check",`;
  if (line.test(text)) text = text.replace(line, (_m, indent) => indent + want);
  else text = text.replace(/^([ \t]*)"outsideThisFolder"/m, (_m, indent) => `${indent}${want}\n${indent}"outsideThisFolder"`);
  writeFileSync(GUARD_FILE, text);
}
const otherCommandsIsCheck = () => {
  try { return /^[ \t]*"otherCommands"[ \t]*:[ \t]*"check"/m.test(readFileSync(GUARD_FILE, "utf8")); } catch { return false; }
};

async function connectJudge() {
  let saved = {};
  try { saved = JSON.parse(await readFile(JUDGE_FILE, "utf8")); } catch {}
  say("  The judge is a decision model the guard asks about commands no rule matches.");
  say("  It has its own connection; DAVE's chat model stays as it is.");
  const fallbackUrl = saved.url || "http://localhost:11434";
  const url = cleanJudgeUrl((await ask(`  Judge address [${fallbackUrl}]: `)) || fallbackUrl);
  if (!/^https?:\/\//i.test(url)) throw new Error("The address should start with http:// or https://");
  let key = await ask("  API key (press Enter for none; it won't show as you type): ", { hidden: true });
  if (!key && String(saved.apiKey || "").startsWith("$")) key = saved.apiKey;
  const resolved = key.startsWith("$") ? process.env[key.slice(1)] || "" : key;

  const found = await decisionModels(url, resolved);
  let model = "";
  if (found.length) {
    say(`  Decision models at ${url}:`);
    found.forEach((m, i) => say(`    ${i + 1}. ${m}`));
    model = choose(found, await ask(`  Pick one [1], or type a name: `));
  } else {
    const fallbackModel = saved.model || "clef:27b";
    model = (await ask(`  Model [${fallbackModel}]: `)) || fallbackModel;
  }

  say(`  Testing ${model} … (the first call loads the model, so it can take a moment)`);
  const probe = await probeJudge(url, model, resolved);
  if (probe.ok) ok(`The judge ${probe.message}`);
  const ctx = await judgeContext(url, model, resolved);
  if (ctx !== undefined && ctx < MIN_JUDGE_CTX) {
    warn(`${model} loads with ${ctx || "Ollama's default (usually 4096)"} tokens of context, so long commands can be refused.`);
    say(`  A copy with PARAMETER num_ctx ${MIN_JUDGE_CTX} fixes it; see "The judge's context is too small" in TROUBLESHOOTING.md.`);
  }
  else {
    warn(`The judge didn't answer: ${probe.message}.`);
    const keep = (await ask("  Save it anyway? [y/N]: ")).toLowerCase();
    if (!keep.startsWith("y")) { rl?.close(); return say("  Nothing saved."); }
  }
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(JUDGE_FILE, JSON.stringify({ url, model, apiKey: key }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(JUDGE_FILE, 0o600).catch(() => {});
  ok(`Saved to ${JUDGE_FILE}`);

  if (!otherCommandsIsCheck()) {
    const yes = (await ask("  Send shell commands that no rule matches to the judge? [Y/n]: ")).toLowerCase();
    if (!yes.startsWith("n")) { setOtherCommands("check"); ok(`Switched on "otherCommands": "check" in .pi/guard.jsonc`); }
  }
  rl?.close();
  say("  In pi, /guard judge shows it, and /guard test <command> shows its verdict.");
}

async function forgetJudge() {
  await rm(JUDGE_FILE, { force: true });
  if (otherCommandsIsCheck()) setOtherCommands(undefined);
  ok("Removed the judge connection. Commands no rule matches go back to the dial.");
}

// An answer to "Pick one [1], or type a name": Enter is the first, a number picks, anything else is a name.
const choose = (list, answer) =>
  !answer ? list[0] : /^\d+$/.test(answer) && list[Number(answer) - 1] ? list[Number(answer) - 1] : answer;

// ---------- another endpoint (scripts/android-setup.sh --provider custom) ----------
// Any OpenAI-compatible endpoint, under a provider name you choose. Writes it into models.json like
// the studio, and the provider and the model DAVE starts on to --result <file> for the caller.
// --current <provider> and --current-model <id> name the endpoint setup already saved: its name,
// address, key and model become the defaults each question shows. ENDPOINT_NAME, ENDPOINT_URL,
// ENDPOINT_API_KEY and ENDPOINT_MODEL in the environment skip the questions.
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

async function connectCustom(resultFile, currentId = "", currentModel = "") {
  if (!resultFile) throw new Error("--custom needs --result <file>");
  const env = (k) => (process.env[k] || "").trim();
  const config = await readJson(MODELS_FILE);
  const saved = config.providers?.[currentId] || {};
  const nameDefault = saved.name || currentId || "custom";
  const name = env("ENDPOINT_NAME") || (await ask(`  A name for this provider [${nameDefault}]: `)) || nameDefault;
  const id = slug(name) || "custom";
  if (id === "dave-local") throw new Error("dave-local is the phone's own model; pick another name.");
  let url = env("ENDPOINT_URL");
  let key = env("ENDPOINT_API_KEY");
  const urlDefault = saved.baseUrl || "";
  // The saved key is offered once, and only while the address stays the saved one.
  const savedKey = saved.apiKey && saved.apiKey !== "none" ? saved.apiKey : "";
  let keyKept = false;
  const interactive = !url;
  let found = null;

  for (let tries = 0; tries < 3 && !found; tries++) {
    if (!url) {
      const typed = await ask(urlDefault ? `  Address [${urlDefault}]: ` : "  Address (OpenAI-compatible, e.g. https://example.org/v1): ");
      url = typed || urlDefault;
    }
    if (!url) { warn("The address is needed to find the models."); continue; }
    if (interactive && !key) {
      const keep = savedKey && !keyKept && url === urlDefault;
      key = await ask(keep ? "  API key (press Enter to keep the saved one; it won't show as you type): " : "  API key (press Enter for none; it won't show as you type): ", { hidden: true });
      if (!key && keep) { key = savedKey; keyKept = true; }
    }
    const got = await listModels(url, key, "The endpoint");
    if (got.problem === "key") { warn(got.message + " Check it for typos."); key = ""; if (!interactive) break; continue; }
    if (got.problem === "address") { warn(got.message); url = ""; if (!interactive) break; continue; }
    found = got;
  }
  if (!found) { rl?.close(); throw new Error("Couldn't connect to that endpoint. Run setup again with the right address and key."); }

  const models = found.models.filter(usable).map(toPiModel).sort((a, b) => a.id.localeCompare(b.id));
  if (!models.length) { rl?.close(); throw new Error(`Connected to ${found.base}, but it lists no models for this key.`); }
  const ids = models.map((m) => m.id);
  let model = env("ENDPOINT_MODEL");
  if (!model) {
    const fallback = ids.includes(currentModel) ? currentModel : ids[0];
    say(`  Models at ${found.base}:`);
    ids.forEach((m, i) => say(`    ${i + 1}. ${m}`));
    const answer = await ask(`  Which one should DAVE start on? Pick one [${fallback}], or type a name: `);
    model = answer ? choose(ids, answer) : fallback;
  }
  rl?.close();
  if (!ids.includes(model)) throw new Error(`${model} isn't one of the models ${found.base} lists.`);

  config.providers = config.providers || {};
  // A keyless endpoint still gets a placeholder: pi needs an apiKey for providers that define models.
  config.providers[id] = { name, baseUrl: found.base, api: "openai-completions", apiKey: key || "none", models };
  await saveModels(config);
  const contextWindow = models.find((m) => m.id === model)?.contextWindow ?? null;
  await writeFile(resultFile, JSON.stringify({ provider: id, model, contextWindow, baseUrl: found.base }) + "\n", "utf8");
  ok(`Connected to ${found.base}; saved ${models.length} model${models.length === 1 ? "" : "s"} as provider "${id}" in ${MODELS_FILE}`);
  ok(`DAVE starts on ${id}/${model}`);
}

// ---------- commands ----------
async function forget() {
  const config = await readJson(MODELS_FILE);
  if (!config.providers?.[PROVIDER]) return ok("No saved studio connection on this machine.");
  delete config.providers[PROVIDER];
  await saveModels(config);
  ok(`Removed the studio address and key from ${MODELS_FILE}`);
}

async function connect() {
  let url = (process.env.AISTUDIO_URL || "").trim();
  let key = (process.env.AISTUDIO_API_KEY || "").trim();
  const interactive = !(url && key);
  let found = null;

  for (let tries = 0; tries < 3 && !found; tries++) {
    if (!url) {
      const typed = await ask(DEFAULT_URL ? `  Studio address [${DEFAULT_URL}]: ` : "  Studio address (from your handout): ");
      url = typed || DEFAULT_URL;
      if (!url) { warn("The address is needed to find the models."); continue; }
    }
    if (!key) {
      key = await ask("  API key (from your handout; it won't show as you type): ", { hidden: true });
      if (!key) { warn("The key is needed to connect."); continue; }
    }
    const got = await listModels(url, key);
    if (got.problem === "key") { warn(got.message + " Check it for typos."); key = ""; if (!interactive) break; continue; }
    if (got.problem === "address") { warn(got.message); url = ""; if (!interactive) break; continue; }
    found = got;
  }
  rl?.close();
  if (!found) throw new Error("Couldn't connect to the studio. Run setup again, or ask for help.");

  const models = found.models.filter(usable).map(toPiModel).sort((a, b) => a.id.localeCompare(b.id));
  if (!models.length) throw new Error(`Connected to ${found.base}, but it lists no models for this key.`);

  const config = await readJson(MODELS_FILE);
  config.providers = config.providers || {};
  config.providers[PROVIDER] = {
    name: "K-State AI Studio",
    baseUrl: found.base,
    api: "openai-completions",
    apiKey: key,
    models,
  };
  await saveModels(config);
  ok(`Connected to ${found.base}`);
  ok(`${models.length} model${models.length === 1 ? "" : "s"} saved to ${MODELS_FILE}: ${models.map((m) => m.id).join(", ")}`);

  const want = await defaultModel();
  if (want && !models.some((m) => m.id === want)) {
    warn(`DAVE's default model, ${want}, isn't on this endpoint. Pick one in pi with /model, or change defaultModel in .pi/settings.json.`);
  }
}

try {
  const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : ""; };
  if (process.argv.includes("--custom")) await connectCustom(arg("--result"), arg("--current"), arg("--current-model"));
  else if (process.argv.includes("--forget-key")) await forget();
  else if (process.argv.includes("--forget-judge")) await forgetJudge();
  else if (process.argv.includes("--judge")) await connectJudge();
  else await connect();
} catch (err) {
  rl?.close();
  say(`  \x1b[31m✗\x1b[0m ${err.message}`);
  process.exit(1);
}
