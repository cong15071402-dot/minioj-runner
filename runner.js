// Trình chấm riêng cho MiniOJ: biên dịch bằng g++ thật và chạy từng test trong môi trường hạn chế.
// Service này KHÔNG chứa mật khẩu database hay mã admin. Chỉ nhận yêu cầu có RUNNER_TOKEN.
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const PORT = +process.env.PORT || 10000;
const TOKEN = process.env.RUNNER_TOKEN || "";
const ROOT = process.env.RUNNER_TMP || "/tmp/runner";
const PCH = process.env.PCH_DIR || "/pch";
const MEM_MB = +process.env.MEM_MB || 256;
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const UIDS = Array.from({ length: Math.max(1, +process.env.RUNNER_SLOTS || 1) }, (_, i) => 60001 + i);

fs.mkdirSync(ROOT, { recursive: true });
for (const d of fs.readdirSync(ROOT)) if (d.startsWith("j-")) { try { fs.rmSync(path.join(ROOT, d), { recursive: true, force: true }); } catch (e) {} }
fs.chmodSync(ROOT, 0o711);

/* ---- hàng đợi: mỗi "ô" dùng một uid riêng để các bài chấm không đọc được thư mục của nhau ---- */
let freeSlots = UIDS.slice(); const waiters = [];
const acquire = () => new Promise(r => { if (freeSlots.length) r(freeSlots.pop()); else waiters.push(r); });
const release = u => { const w = waiters.shift(); if (w) w(u); else freeSlots.push(u); };

/* diệt MỌI tiến trình của một uid (kể cả tiến trình con còn sót, fork bomb): người dùng thường gọi kill -9 -1 là chỉ diệt được tiến trình của chính uid đó */
function countUid(uid) {
  let n = 0;
  try {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try { const m = /Uid:\s+(\d+)/.exec(fs.readFileSync("/proc/" + d + "/status", "utf8")); if (m && +m[1] === uid) n++; } catch (e) {}
    }
  } catch (e) {}
  return n;
}
function killAll(uid) {
  if (!IS_ROOT || !uid) return;
  for (let i = 0; i < 30 && countUid(uid) > 0; i++) {
    spawnSync("bash", ["-c", "kill -9 -1"], { uid, gid: uid, stdio: "ignore", timeout: 3000 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  }
}

/* ---- chạy một lệnh với giới hạn CPU, bộ nhớ, tiến trình, kích thước file ---- */
function exec(cmd, args, o) {
  return new Promise(resolve => {
    const lim = `ulimit -c 0; ulimit -H -t ${o.cpu + 1}; ulimit -S -t ${o.cpu}; ulimit -v ${o.memMB * 1024}; ulimit -f ${o.fileKB || 20480}; ulimit -u ${o.nproc || 64}; exec "$@"`;
    const opt = {
      cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: o.cwd, TMPDIR: o.cwd, LANG: "C" }
    };
    if (IS_ROOT && o.uid) { opt.uid = o.uid; opt.gid = o.uid; }
    let p; try { p = spawn("bash", ["-c", lim, "bash", cmd, ...args], opt); } catch (e) { return resolve({ fail: e.message }); }
    let out = Buffer.alloc(0), err = Buffer.alloc(0), killed = null, done = false, exitInfo = null;
    const t0 = process.hrtime.bigint();
    const finish = (code, sig) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code, sig, killed, ms: Number((process.hrtime.bigint() - t0) / 1000000n), out: out.toString("utf8"), stderr: err.toString("utf8") });
    };
    const kill = why => {
      if (!killed) {
        killed = why; try { p.kill("SIGKILL"); } catch (e) {}
        killAll(o.uid);
        setTimeout(() => finish(null, "SIGKILL"), 2000);
      }
    };
    const timer = setTimeout(() => kill("TLE"), o.wall);
    p.stdout.on("data", d => { if (out.length < o.maxOut) out = Buffer.concat([out, d]); if (out.length >= o.maxOut) kill("OLE"); });
    p.stderr.on("data", d => { if (err.length < 8000) err = Buffer.concat([err, d]); });
    p.on("error", e => { if (!done) { done = true; clearTimeout(timer); resolve({ fail: e.message }); } });
    p.on("exit", (code, sig) => { exitInfo = [code, sig]; killAll(o.uid); });
    p.on("close", (code, sig) => finish(code, sig));
    p.stdin.on("error", () => {});
    p.stdin.end(o.input == null ? undefined : o.input);
  });
}

async function runJob(code, inputs, cpu) {
  const slot = await acquire();
  const dir = fs.mkdtempSync(path.join(ROOT, "j-"));
  try {
    if (IS_ROOT) fs.chownSync(dir, slot, slot);
    fs.chmodSync(dir, 0o700);
    const src = path.join(dir, "main.cpp");
    fs.writeFileSync(src, code); if (IS_ROOT) fs.chownSync(src, slot, slot);
    const c = await exec("g++", ["-O2", "-std=c++17", "-pipe", "-I", PCH, "-o", "prog", "main.cpp"],
      { uid: slot, cwd: dir, wall: 30000, cpu: 25, memMB: 3072, maxOut: 1e6, nproc: 128 });
    if (c.fail) throw new Error(c.fail);
    if (c.code !== 0) return { ce: true, msg: (c.stderr || c.out || "Lỗi biên dịch").split(dir + "/").join("").slice(0, 3000) };
    const results = []; const t0 = Date.now();
    let tle = 0;
    for (const input of inputs) {
      // đã quá thời gian 3 test thì bỏ qua phần còn lại để không bắt người dùng chờ lâu
      if (tle >= 3 || Date.now() - t0 > 90000) { results.push({ v: "TLE", ms: 0 }); continue; }
      const r = await exec("./prog", [], { uid: slot, cwd: dir, input, wall: cpu * 2000 + 1000, cpu: Math.ceil(cpu) + 1, memMB: MEM_MB, maxOut: 10e6, nproc: 32 });
      if (r.fail) throw new Error(r.fail);
      if (r.killed === "TLE" || r.sig === "SIGXCPU" || (r.sig === "SIGKILL" && !r.killed && r.ms >= cpu * 1000)) { tle++; results.push({ v: "TLE", ms: r.ms }); }
      else if (r.killed === "OLE") results.push({ v: "RTE", msg: "Kết quả in ra quá lớn", ms: r.ms });
      else if (r.sig || r.code !== 0) {
        const mem = /bad_alloc|Cannot allocate/i.test(r.stderr);
        results.push({ v: "RTE", msg: mem ? "Vượt giới hạn bộ nhớ" : (r.stderr.trim().slice(0, 400) || (r.sig ? "Tín hiệu " + r.sig : "Mã thoát " + r.code)), ms: r.ms });
      } else results.push({ out: r.out, ms: r.ms });
    }
    return { results };
  } finally {
    release(slot);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

/* ---- HTTP ---- */
const sha = x => crypto.createHash("sha256").update(String(x)).digest();
let ready = false;
const json = (res, c, o) => { res.writeHead(c, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
http.createServer(async (req, res) => {
  try {
    const url = (req.url || "/").split("?")[0];
    if (url === "/healthz") return json(res, 200, { ok: 1, ready, isolated: IS_ROOT });
    if (req.method !== "POST" || url !== "/judge") return json(res, 404, { error: "Not found" });
    const bearer = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (!TOKEN || !crypto.timingSafeEqual(sha(bearer), sha(TOKEN))) return json(res, 401, { error: "Unauthorized" });
    if (waiters.length > 8) return json(res, 503, { error: "Đang quá tải" });
    let body = "";
    for await (const c of req) { body += c; if (body.length > 8e6) return json(res, 413, { error: "Quá lớn" }); }
    const b = JSON.parse(body || "{}");
    const code = String(b.code || ""), inputs = Array.isArray(b.inputs) ? b.inputs : [];
    if (!code || code.length > 50000 || !inputs.length || inputs.length > 30 || inputs.some(x => typeof x !== "string" || x.length > 3e6))
      return json(res, 400, { error: "Dữ liệu không hợp lệ" });
    const cpu = Math.min(10, Math.max(1, +b.cpu || 3));
    return json(res, 200, await runJob(code, inputs, cpu));
  } catch (e) { console.error(e); return json(res, 500, { error: "Lỗi nội bộ" }); }
}).listen(PORT, async () => {
  console.log("Runner chạy ở cổng", PORT, "| cách ly bằng uid riêng:", IS_ROOT);
  if (!IS_ROOT) console.warn("CẢNH BÁO: không chạy bằng root nên code người dùng KHÔNG được cách ly.");
  try {
    const t = Date.now();
    const r = await runJob("#include <bits/stdc++.h>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}", ["2 3\n"], 2);
    ready = !!(r.results && r.results[0] && String(r.results[0].out).trim() === "5");
    console.log("Tự kiểm tra:", ready ? "OK" : "LỖI " + JSON.stringify(r).slice(0, 200), "(" + (Date.now() - t) + " ms)");
  } catch (e) { console.error("Tự kiểm tra lỗi:", e.message); }
});
