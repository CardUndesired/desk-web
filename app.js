import { drawCandles, drawLine, drawScoreRing, reducedMotion } from "./chart.js";

const POLL_MS = 15000;
const RETRY_MS = 5000;
const RANGES = ["LIVE", "1H", "4H", "1D", "1W", "ALL"];
const cache = {
  state: null,
  charts: {},
  activity: null,
  account: null,
  settings: null,
  coins: {},
  audits: {},
  decisions: {},
};
let bundleReady = false;
let lastOkAt = null;
let retryAt = 0;
let offline = false;
let chartRange = "LIVE";
let route = { tab: "home", overlay: null, mint: null, agent: null };

function appBase() {
  const path = location.pathname;
  return path.endsWith("/") ? path : path.replace(/\/[^/]*$/, "/");
}

function consumeHashSecrets() {
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!raw || raw.startsWith("/")) return;
  if (!raw.includes("=")) return;
  const params = new URLSearchParams(raw.replace(/&/g, "&"));
  if (params.get("d")) localStorage.setItem("desk_data_path", params.get("d"));
  if (params.get("t")) localStorage.setItem("desk_app_token", params.get("t"));
  history.replaceState(null, "", location.pathname + location.search + "#/");
}

function dataKey() {
  consumeHashSecrets();
  return localStorage.getItem("desk_data_path");
}

function dataBase() {
  return dataKey();
}

async function openSealed(buf, secret) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf.slice(0, 12) },
    key,
    buf.slice(12)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

async function fetchSealed(secret) {
  const res = await fetch(appBase() + "data.enc", { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return openSealed(await res.arrayBuffer(), secret);
}

function applyBundle(bundle) {
  cache.state = bundle.state || null;
  cache.activity = bundle.activity || null;
  cache.account = bundle.account || null;
  cache.settings = bundle.settings || null;
  cache.coins = bundle.coins || {};
  cache.audits = bundle.audits || {};
  cache.decisions = bundle.decisions || {};
  cache.charts = bundle.charts || {};
  bundleReady = true;
}

function offlineBlock(what) {
  return `<div class="pad muted">Couldn't load ${what}. Desk is offline — retrying…</div>`;
}

function el(id) { return document.getElementById(id); }

function money(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function fmtPrice(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  if (Math.abs(x) >= 1) return money(x);
  return "$" + x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
}

function compactUsd(n) {
  if (n == null || Number.isNaN(Number(n))) return "n/a";
  const x = Number(n);
  if (x >= 1e6) return "$" + (x / 1e6).toFixed(2) + "M";
  if (x >= 1e3) return "$" + (x / 1e3).toFixed(1) + "K";
  return money(x);
}

function fmtPct(n, withSign = true) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  const body = Math.abs(x).toFixed(2) + "%";
  if (!withSign) return body;
  return (x > 0 ? "+" : x < 0 ? "-" : "") + body;
}

function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setOdometer(root, next) {
  const chars = String(next).split("");
  const prev = [...root.querySelectorAll("span")].map((n) => n.dataset.ch ?? "");
  root.innerHTML = "";
  chars.forEach((ch, i) => {
    const wrap = document.createElement("span");
    wrap.dataset.ch = ch;
    const inner = document.createElement("i");
    inner.textContent = ch;
    wrap.appendChild(inner);
    root.appendChild(wrap);
    if (!reducedMotion() && prev[i] && prev[i] !== ch && /\d/.test(ch)) {
      inner.style.transform = "translateY(66px)";
      requestAnimationFrame(() => {
        setTimeout(() => { inner.style.transform = "translateY(0)"; }, 30 * (chars.length - 1 - i));
      });
    }
  });
}

function showBanner() {
  const banner = el("banner");
  if (!dataBase()) {
    banner.hidden = false;
    banner.textContent = "Open this app from the link I sent you so it can find the private data path.";
    return;
  }
  if (!offline) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  const wait = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  const last = lastOkAt ? " · last update " + fmtTime(lastOkAt) : "";
  banner.hidden = false;
  banner.textContent = `Desk offline · retrying in ${wait}s${last}`;
}

function setTab(name) {
  route.tab = name;
  route.overlay = null;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  ["home", "agents", "activity", "account"].forEach((id) => {
    el("view-" + id).classList.toggle("active", id === name);
  });
  ["coin", "audit", "agent", "search"].forEach((id) => {
    el("view-" + id).hidden = true;
  });
  render();
}

function openOverlay(name, extra = {}) {
  route.overlay = name;
  Object.assign(route, extra);
  ["coin", "audit", "agent", "search"].forEach((id) => {
    el("view-" + id).hidden = id !== name;
  });
  render();
}

function closeOverlay() {
  route.overlay = null;
  route.mint = null;
  route.agent = null;
  ["coin", "audit", "agent", "search"].forEach((id) => { el("view-" + id).hidden = true; });
  render();
}

function renderHome() {
  const root = el("view-home");
  const state = cache.state;
  if (!state && !offline) {
    root.innerHTML = `<div class="pad"><div class="skel" style="height:66px;margin:8px 0 16px"></div><div class="skel" style="height:180px"></div></div>`;
    return;
  }
  if (!state) {
    root.innerHTML = offline
      ? offlineBlock("home")
      : `<div class="pad muted">Waiting for the desk…</div>`;
    return;
  }
  const todayCls = (state.today_pct || 0) >= 0 ? "up" : "down";
  const agents = state.agents || [];
  root.innerHTML = `
    <div class="balance-row">
      <div class="odo" id="balanceOdo"></div>
      ${state.mode === "PAPER" ? `<span class="paper">PAPER</span>` : ""}
    </div>
    <div class="meta">
      <span class="${todayCls}">${esc(fmtPct(state.today_pct))} today</span>
      <span class="pill green">${esc(Number(state.multiplier || 0).toFixed(2))}×</span>
    </div>
    <div class="ranges" id="ranges">
      ${RANGES.map((r) => `<button data-range="${r}" class="${r === chartRange ? "on" : ""}">${r}</button>`).join("")}
    </div>
    <div class="chart-wrap"><canvas id="homeChart"></canvas></div>
    <div class="cards" id="cards"></div>
    <div class="dots" id="dots">${agents.map((_, i) => `<i${i === 0 ? ' class="on"' : ""}></i>`).join("")}</div>
  `;
  setOdometer(el("balanceOdo"), money(state.balance));
  const chart = (cache.charts[chartRange] || cache.charts.LIVE || { points: [], marks: [] });
  drawLine(el("homeChart"), chart);
  el("ranges").onclick = (ev) => {
    const btn = ev.target.closest("button[data-range]");
    if (!btn) return;
    chartRange = btn.dataset.range;
    renderHome();
  };
  const cards = el("cards");
  agents.forEach((agent) => cards.appendChild(renderCard(agent)));
  cards.addEventListener("scroll", () => {
    const w = cards.clientWidth;
    const i = Math.round(cards.scrollLeft / Math.max(1, w));
    [...el("dots").children].forEach((d, idx) => d.classList.toggle("on", idx === i));
  });
}

function renderCard(agent) {
  const card = document.createElement("button");
  card.className = "agent-card";
  card.style.borderRadius = `${42 * ((window.innerWidth - 32) / 504)}px`;
  const title = agent.title || agent.name;
  let label = agent.label || "Idle";
  let detail = agent.detail || "";
  if (agent.name === "scanner" && !agent.detail) label = "Listening for graduations";
  if (agent.name === "auditor" && !agent.detail) detail = "";
  card.innerHTML = `<h2>${esc(title)}</h2><div class="label">${esc(label)}</div><div class="detail">${esc(detail)}</div>`;
  if (agent.name === "risk" && agent.pills?.length) {
    const pills = document.createElement("div");
    pills.style.display = "flex";
    pills.style.gap = "8px";
    pills.style.marginTop = "auto";
    agent.pills.forEach((p) => {
      const s = document.createElement("span");
      s.className = "pill orange";
      s.textContent = p.text;
      pills.appendChild(s);
    });
    card.appendChild(pills);
  }
  if (agent.name === "analyst") {
    const score = Number(String(label).replace(/[^\d.-]/g, ""));
    if (!Number.isNaN(score) && label.toLowerCase().includes("score")) {
      const wrap = document.createElement("div");
      wrap.className = "ring-wrap";
      const c = document.createElement("canvas");
      wrap.appendChild(c);
      card.appendChild(wrap);
      requestAnimationFrame(() => drawScoreRing(c, score));
    }
  }
  if (agent.name === "auditor") {
    const auditMint = (cache.decisions.auditor?.rows || [])[0]?.mint;
    const layers = (auditMint && cache.audits[auditMint]?.layers) || null;
    const grid = document.createElement("div");
    grid.className = "layers";
    const items = layers || Array.from({ length: 8 }, (_, i) => ({ n: i + 1, pass: null, value: "" }));
    items.forEach((ly) => {
      const s = document.createElement("div");
      s.className = "strip" + (ly.pass === true ? " pass" : ly.pass === false ? " fail" : "");
      s.textContent = ly.name || ("Layer " + ly.n);
      grid.appendChild(s);
    });
    card.appendChild(grid);
  }
  card.addEventListener("click", () => openOverlay("agent", { agent: agent.name }));
  return card;
}

function renderAgents() {
  const root = el("view-agents");
  if (!cache.state) {
    root.innerHTML = offline ? offlineBlock("agents") : `<div class="pad muted">No agents yet.</div>`;
    return;
  }
  const agents = cache.state?.agents || [];
  if (!agents.length) {
    root.innerHTML = `<div class="pad muted">No agents yet.</div>`;
    return;
  }
  root.innerHTML = `<div class="list">${agents.map((a) => `
    <button class="list-row" data-agent="${esc(a.name)}">
      <div><strong>${esc(a.title || a.name)}</strong><div class="sub">${esc(a.label || "")}${a.detail ? " · " + esc(a.detail) : ""}</div></div>
      <span class="muted">${esc(a.status || "")}</span>
    </button>`).join("")}</div>`;
  root.querySelectorAll("[data-agent]").forEach((btn) => {
    btn.onclick = () => openOverlay("agent", { agent: btn.dataset.agent });
  });
}

function renderActivity() {
  const root = el("view-activity");
  if (!cache.activity) {
    root.innerHTML = offline ? offlineBlock("activity") : `<div class="pad muted">Nothing yet tonight</div>`;
    return;
  }
  const rows = cache.activity?.rows || [];
  if (!rows.length) {
    root.innerHTML = `<div class="pad muted">Nothing yet tonight</div>`;
    return;
  }
  root.innerHTML = `<div class="list">${rows.map((r) => `
    <button class="list-row" data-mint="${esc(r.mint || "")}">
      <div><strong>${esc(r.title)}</strong><div class="sub">${esc(r.subtitle || "")}</div></div>
      <span>${esc(r.value || "")}</span>
    </button>`).join("")}</div>`;
  root.querySelectorAll("[data-mint]").forEach((btn) => {
    if (btn.dataset.mint) btn.onclick = () => openCoin(btn.dataset.mint);
  });
}

function settingInput(key, value) {
  const disabled = cache.account?.readonly ? "disabled" : "";
  if (typeof value === "boolean") {
    return `<button class="switch ${value ? "on" : ""}" data-key="${esc(key)}" ${disabled} type="button"><i></i></button>`;
  }
  if (typeof value === "number") {
    return `<input class="num" data-key="${esc(key)}" type="text" value="${esc(value)}" ${disabled} />`;
  }
  return `<span class="muted">${esc(value)}</span>`;
}

function renderAccount() {
  const root = el("view-account");
  const acc = cache.account;
  const grouped = cache.settings?.grouped || {};
  if (!acc) {
    root.innerHTML = offline
      ? offlineBlock("account")
      : `<div class="pad"><div class="skel" style="height:120px"></div></div>`;
    return;
  }
  const groups = Object.keys(grouped);
  root.innerHTML = `
    <div class="list">
      <div class="list-row"><div>Mode</div><strong>${esc(acc.mode)}</strong></div>
      <div class="list-row"><div>Stack</div><strong>${esc(money(acc.stack))}</strong></div>
    </div>
    <div class="list">
      ${acc.profile_url ? `<a class="list-row" href="${esc(acc.profile_url)}" target="_blank" rel="noopener"><div>Your FOMO profile</div><span class="muted">Open</span></a>` : `<div class="list-row"><div>Your FOMO profile</div><span class="muted">Not set</span></div>`}
      <button class="list-row" id="inviteBtn"><div>Invite a friend</div><span class="muted">Share</span></button>
    </div>
    <div class="list">
      <div class="list-row"><div>Telegram</div><strong>${acc.telegram?.connected ? "Connected" : "Not connected"}</strong></div>
      <div class="list-row"><div>Notifications</div><span class="muted">${acc.webpush ? "Web push" : "Telegram only on this host"}</span></div>
    </div>
    ${acc.readonly ? `<p class="hint">This host is read-only. Settings can be changed later in Telegram.</p>` : ""}
    ${groups.map((g) => `
      <div class="group">${esc(g)}</div>
      <div class="list">
        ${Object.entries(grouped[g]).map(([name, val]) => `
          <div class="setting-row">
            <div>${esc(name.replaceAll("_", " "))}</div>
            ${settingInput(g + "." + name, val)}
          </div>`).join("")}
      </div>`).join("")}
  `;
  const invite = el("inviteBtn");
  if (invite) {
    invite.onclick = async () => {
      const url = acc.signup_url;
      if (!url) return;
      try {
        if (navigator.share) await navigator.share({ url, title: "FOMO" });
        else {
          await navigator.clipboard.writeText(url);
          invite.querySelector(".muted").textContent = "Link copied";
        }
      } catch (_) {}
    };
  }
}

function renderCoin() {
  const root = el("view-coin");
  const coin = cache.coins[route.mint];
  root.innerHTML = `
    <button class="back" id="coinBack">‹ Back</button>
    ${!coin ? `<div class="pad muted">${
      !bundleReady && offline
        ? "Couldn't load this coin. Desk is offline — retrying…"
        : bundleReady
          ? "Coin not found."
          : "Loading…"
    }</div>` : `
      <div class="pad">
        <div class="row-between">
          <h1 class="h1">${esc(coin.name)}</h1>
          ${cache.state?.mode === "PAPER" ? `<span class="paper">PAPER</span>` : ""}
        </div>
        <div class="muted">${esc(coin.symbol || coin.name)} · ${esc(coin.chain || "Solana")}${coin.age ? " · " + esc(coin.age) : ""} ${coin.shield ? `<span class="chip" id="shieldChip">${esc(coin.shield)}</span>` : ""}</div>
        <div class="price">${esc(fmtPrice(coin.price))}</div>
        <div class="${(coin.entry_change_pct || 0) >= 0 ? "up" : "down"}">${coin.position ? "▲ " + esc(fmtPct(coin.entry_change_pct)) + " since entry" : ""}</div>
      </div>
      <div class="chart-wrap candle-wrap" style="height:220px"><canvas id="coinChart"></canvas></div>
      <div class="stats">
        <div class="stat"><span>Market cap</span><strong>${esc(compactUsd(coin.stats?.market_cap))}</strong></div>
        <div class="stat"><span>Liquidity</span><strong>${esc(compactUsd(coin.stats?.liquidity))}</strong></div>
        <div class="stat"><span>24h volume</span><strong>${esc(compactUsd(coin.stats?.volume_24h))}</strong></div>
        <div class="stat"><span>Holders</span><strong>${esc(coin.stats?.holders == null ? "n/a" : coin.stats.holders)}</strong></div>
      </div>
      ${coin.position ? `
        <div class="pos-card">
          <strong>Your position · ${esc(money(coin.position.size_usd))} in · Executor</strong>
          <div class="muted">Stop ${esc(fmtPrice(coin.position.stop_price))} · Trail ${coin.position.trail_line == null ? "not armed" : fmtPrice(coin.position.trail_line)} · Timeout ${Math.max(0, Math.round((coin.position.time_left_s || 0) / 60))}m left</div>
        </div>` : ""}
      ${coin.coin_url ? `<a class="btn" href="${esc(coin.coin_url)}" target="_blank" rel="noopener">${coin.position ? "Sell on FOMO" : "Buy on FOMO"}</a>` : ""}
    `}
  `;
  el("coinBack").onclick = closeOverlay;
  const chip = el("shieldChip");
  if (chip) chip.onclick = () => openAudit(route.mint);
  if (coin) {
    const canvas = el("coinChart");
    if (canvas) drawCandles(canvas, { candles: coin.candles || [], exitLines: coin.exit_lines || {} });
  }
}

function layerClass(ly, beaming) {
  if (beaming && ly.n === beaming) return "strip beam";
  if (ly.pass === true) return "strip pass";
  if (ly.pass === false) return "strip fail";
  return "strip";
}

function renderAudit(beamN = 0) {
  const root = el("view-audit");
  const audit = cache.audits[route.mint];
  const coin = cache.coins[route.mint];
  root.innerHTML = `
    <button class="back" id="auditBack">‹ Back</button>
    ${!audit ? `<div class="pad muted">${
      !bundleReady && offline
        ? "Couldn't load this audit. Desk is offline — retrying…"
        : bundleReady && route.mint
          ? "Audit not found."
          : "No coin taken apart yet"
    }</div>` : `
      <div class="pad">
        <h1 class="h1">${audit.reason ? "Rejected · " + esc(audit.reason) : "Cleared · 8/8 parts"}</h1>
        <p class="muted">${audit.reason ? "Grok Bot won't buy " + esc(audit.name) : "Sent to Executor"}</p>
      </div>
      <div class="layers pad">${audit.layers.map((ly) => `
        <div class="${layerClass(ly, beamN)}">${esc(ly.name)}<br><span>${esc(ly.value)}</span></div>
      `).join("")}</div>
      <div class="list">
        <div class="list-row">
          <div>Take apart before buying</div>
          <button class="switch ${cache.settings?.values?.["auditor.enabled"] ? "on" : ""}" disabled type="button"><i></i></button>
        </div>
      </div>
      ${audit.coin_url ? `<a class="btn" href="${esc(audit.coin_url)}" target="_blank" rel="noopener">Open on FOMO</a>` : ""}
    `}
  `;
  const back = el("auditBack");
  if (back) back.onclick = () => { if (coin || cache.coins[route.mint]) openOverlay("coin", { mint: route.mint }); else closeOverlay(); };
}

function playAuditBeam(audit) {
  if (reducedMotion() || !audit?.layers) {
    renderAudit(0);
    return;
  }
  let n = 1;
  const step = () => {
    renderAudit(n);
    const ly = audit.layers.find((x) => x.n === n);
    const wait = ly && ly.value !== "not checked" ? 350 + 150 : 350;
    n += 1;
    if (n <= 8) setTimeout(step, wait);
    else setTimeout(() => renderAudit(0), 150);
  };
  step();
}

function renderAgentDetail() {
  const root = el("view-agent");
  const name = route.agent;
  const dec = cache.decisions[name];
  const rows = dec?.rows || [];
  root.innerHTML = `
    <button class="back" id="agentBack">‹ Back</button>
    <div class="pad"><h1 class="h1">${esc(name)}</h1></div>
    ${!rows.length ? `<div class="pad muted">${
      !bundleReady && offline
        ? "Couldn't load this agent. Desk is offline — retrying…"
        : "No decisions yet."
    }</div>` : `<div class="list">${rows.map((r) => `
      <button class="list-row" data-mint="${esc(r.mint || "")}">
        <div><strong>${esc(r.name || r.mint || "")}</strong><div class="sub">${esc(r.reason || r.status || r.verdict || "")}</div></div>
        <span class="muted">${esc(fmtTime(r.ts))}</span>
      </button>`).join("")}</div>`}
  `;
  el("agentBack").onclick = closeOverlay;
  root.querySelectorAll("[data-mint]").forEach((btn) => {
    if (!btn.dataset.mint) return;
    btn.onclick = () => {
      if (name === "auditor") openAudit(btn.dataset.mint);
      else openCoin(btn.dataset.mint);
    };
  });
}

function renderSearch() {
  const root = el("view-search");
  const q = (route.query || "").trim().toLowerCase();
  const rows = [];
  (cache.activity?.rows || []).forEach((r) => {
    if (!r.mint) return;
    const blob = `${r.name || ""} ${r.mint} ${r.title || ""}`.toLowerCase();
    if (!q || blob.includes(q)) rows.push({ mint: r.mint, name: r.name || r.title, detail: r.subtitle });
  });
  (cache.decisions.scanner?.rows || []).forEach((r) => {
    const blob = `${r.name || ""} ${r.mint}`.toLowerCase();
    if (!q || blob.includes(q)) rows.push({ mint: r.mint, name: r.name, detail: r.reason });
  });
  const seen = new Set();
  const uniq = rows.filter((r) => (seen.has(r.mint) ? false : seen.add(r.mint)));
  root.innerHTML = `
    <button class="back" id="searchBack">‹ Back</button>
    <input class="search-box" id="searchInput" placeholder="Name, symbol, or mint" value="${esc(route.query || "")}" />
    ${!uniq.length ? `<div class="pad muted">${q ? "No matching coin." : "Search a name, symbol, or mint."}</div>` : `<div class="list">${uniq.map((r) => `
      <button class="list-row" data-mint="${esc(r.mint)}"><div><strong>${esc(r.name || r.mint)}</strong><div class="sub">${esc(r.detail || "")}</div></div></button>
    `).join("")}</div>`}
  `;
  el("searchBack").onclick = closeOverlay;
  const input = el("searchInput");
  input.focus();
  input.oninput = () => { route.query = input.value; renderSearch(); };
  root.querySelectorAll("[data-mint]").forEach((btn) => { btn.onclick = () => openCoin(btn.dataset.mint); });
}

function render() {
  showBanner();
  const handle = cache.account?.fomo_handle || "";
  el("avatarBtn").textContent = (handle[0] || "G").toUpperCase();
  if (!route.overlay) {
    if (route.tab === "home") renderHome();
    if (route.tab === "agents") renderAgents();
    if (route.tab === "activity") renderActivity();
    if (route.tab === "account") renderAccount();
  } else if (route.overlay === "coin") renderCoin();
  else if (route.overlay === "audit") renderAudit(0);
  else if (route.overlay === "agent") renderAgentDetail();
  else if (route.overlay === "search") renderSearch();
}

async function openCoin(mint) {
  openOverlay("coin", { mint });
  renderCoin();
}

async function openAudit(mint) {
  openOverlay("audit", { mint });
  playAuditBeam(cache.audits[mint]);
}

function maybeDeepLink() {
  if (deepLinked) return;
  deepLinked = true;
  applyDeepLink();
}

async function refresh() {
  const secret = dataKey();
  if (!secret) { showBanner(); return; }
  try {
    applyBundle(await fetchSealed(secret));
    lastOkAt = cache.state?.updated_at || new Date().toISOString();
    offline = false;
    maybeDeepLink();
    render();
  } catch (err) {
    offline = true;
    retryAt = Date.now() + (cache.state ? POLL_MS : RETRY_MS);
    maybeDeepLink();
    render();
  }
}

function tickBanner() {
  if (offline) showBanner();
}

el("tabbar").onclick = (ev) => {
  const btn = ev.target.closest("[data-tab]");
  if (btn) setTab(btn.dataset.tab);
};
el("avatarBtn").onclick = () => setTab("account");
el("searchBtn").onclick = () => openOverlay("search", { query: "" });
el("bellBtn").onclick = () => setTab("activity");

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

let deepLinked = false;
function applyDeepLink() {
  const q = new URLSearchParams(location.search);
  const tab = q.get("tab");
  const coin = q.get("coin");
  const audit = q.get("audit");
  if (tab && ["home", "agents", "activity", "account"].includes(tab)) setTab(tab);
  if (coin) openCoin(coin);
  else if (audit) openAudit(audit);
}

consumeHashSecrets();
refresh();
setInterval(refresh, POLL_MS);
setInterval(tickBanner, 1000);
