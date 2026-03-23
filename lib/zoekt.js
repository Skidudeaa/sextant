const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

function stateDir(root) {
  return path.join(path.resolve(root), ".planning", "intel");
}

function zoektDir(root) {
  return path.join(stateDir(root), "zoekt");
}

function zoektIndexDir(root) {
  return path.join(zoektDir(root), "index");
}

function zoektDaemonPath(root) {
  return path.join(zoektDir(root), "daemon.json");
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function which(bin) {
  const r = spawnSync("sh", ["-lc", `command -v ${bin} 2>/dev/null`], { encoding: "utf8" });
  if (r.status === 0) {
    const out = (r.stdout || "").trim();
    return out ? out : null;
  }
  return null;
}

function isInstalled() {
  return !!which("zoekt-webserver");
}

function isGitRepo(root) {
  return exists(path.join(root, ".git"));
}

function hasIndex(root) {
  const dir = zoektIndexDir(root);
  if (!exists(dir)) return false;
  return fs.readdirSync(dir).some((f) => f.endsWith(".zoekt"));
}

function readDaemon(root) {
  const p = zoektDaemonPath(root);
  if (!exists(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeDaemon(root, data) {
  mkdirp(zoektDir(root));
  fs.writeFileSync(zoektDaemonPath(root), JSON.stringify(data, null, 2));
}

function isPidRunning(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeApi(port) {
  const url = `http://127.0.0.1:${port}/api/search`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Q: "file:.",
        Opts: { TotalMaxMatchCount: 1, NumContextLines: 0 },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function buildIndex(root, { force = false } = {}) {
  mkdirp(zoektIndexDir(root));
  if (!force && hasIndex(root)) return { ok: true, skipped: true };

  const bin = isGitRepo(root) ? "zoekt-git-index" : "zoekt-index";
  if (!which(bin)) throw new Error(`Missing ${bin} in PATH`);

  const args = ["-index", zoektIndexDir(root), root];
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `Zoekt index failed: ${bin} ${args.join(" ")}\n${r.stderr || r.stdout || ""}`
    );
  }
  return { ok: true, indexed: true };
}

async function ensureWebserver(root, { port = 6070, autoIndex = false } = {}) {
  if (!isInstalled()) throw new Error("zoekt-webserver not found in PATH");

  const df = readDaemon(root);
  if (df?.pid && df?.port && isPidRunning(df.pid)) {
    if (await probeApi(df.port)) return { ok: true, reused: true, port: df.port, pid: df.pid };
  }

  if (!hasIndex(root)) {
    if (!autoIndex)
      throw new Error(
        "Zoekt index missing; run `sextant zoekt index` or pass --zoekt-build"
      );
    buildIndex(root, { force: false });
  }

  const ports = [port, ...Array.from({ length: 30 }, (_, i) => port + i + 1)];
  mkdirp(zoektDir(root));
  const lf = path.join(zoektDir(root), "webserver.log");
  const out = fs.openSync(lf, "a");

  for (const p of ports) {
    const args = ["-rpc", "-index", zoektIndexDir(root), "-listen", `127.0.0.1:${p}`];
    const child = spawn("zoekt-webserver", args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();

    await sleep(250);
    if (await probeApi(p)) {
      writeDaemon(root, { pid: child.pid, port: p, startedAt: new Date().toISOString() });
      return { ok: true, started: true, port: p, pid: child.pid };
    }

    try {
      process.kill(child.pid, "SIGTERM");
    } catch {}
    await sleep(75);

    if (p === 6070) {
      const child2 = spawn("zoekt-webserver", ["-rpc", "-index", zoektIndexDir(root)], {
        cwd: root,
        detached: true,
        stdio: ["ignore", out, out],
      });
      child2.unref();

      await sleep(300);
      if (await probeApi(6070)) {
        writeDaemon(root, { pid: child2.pid, port: 6070, startedAt: new Date().toISOString() });
        return { ok: true, started: true, port: 6070, pid: child2.pid };
      }

      try {
        process.kill(child2.pid, "SIGTERM");
      } catch {}
      await sleep(75);
    }
  }

  throw new Error("Failed to start zoekt-webserver (rpc). Check .planning/intel/zoekt/webserver.log");
}

function b64(s) {
  if (!s) return "";
  try {
    return Buffer.from(s, "base64").toString("utf8");
  } catch {
    return s;
  }
}

function normalize(json) {
  const result = json?.Result || json?.result || json;
  const files = result?.Files || result?.files || [];

  const hits = [];
  for (const f of files) {
    const fileName = f.FileName || f.fileName;
    const fileScore = f.Score || f.score || null;
    const lineMatches = f.LineMatches || f.lineMatches || [];

    for (const lm of lineMatches) {
      const ranges = (lm.LineFragments || lm.lineFragments || [])
        .filter((fr) => fr.Match)
        .map((fr) => ({ start: fr.Start, end: fr.End }));

      hits.push({
        path: fileName,
        lineNumber: lm.LineNumber ?? lm.lineNumber ?? null,
        line: b64(lm.Line).replace(/\n$/, ""),
        before: b64(lm.Before).split(/\r?\n/).filter(Boolean),
        after: b64(lm.After).split(/\r?\n/).filter(Boolean),
        ranges,
        provider: "zoekt",
        score: lm.Score ?? lm.score ?? fileScore,
      });
    }
  }

  return {
    provider: "zoekt",
    stats: {
      matchCount: hits.length,
      fileCount: result?.FileCount ?? result?.fileCount ?? files.length ?? null,
    },
    hits,
  };
}

async function search(root, q, opts = {}) {
  const { port } = await ensureWebserver(root, {
    port: opts.port ?? 6070,
    autoIndex: !!opts.autoIndex,
  });

  const url = `http://127.0.0.1:${port}/api/search`;
  const payload = {
    Q: q,
    Opts: {
      TotalMaxMatchCount: opts.totalMaxMatchCount ?? 500,
      NumContextLines: opts.contextLines ?? 1,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Zoekt search failed: HTTP ${res.status}`);
  const json = await res.json();
  const norm = normalize(json);

  const maxHits = opts.maxHits ?? 50;
  if (norm.hits.length > maxHits) norm.hits = norm.hits.slice(0, maxHits);

  return { ...norm, details: { port } };
}

module.exports = {
  isInstalled,
  hasIndex,
  buildIndex,
  ensureWebserver,
  search,
};
