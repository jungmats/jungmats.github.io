/* Agent Journeys dashboard — reads /api/analytics/* from the same Worker.
 *
 * Forms, per the dataviz method: headline numbers as stat tiles; the funnel
 * and every distribution as ranked horizontal bars in one hue (magnitude,
 * not identity); journeys per day as stacked bars in four fixed categorical
 * hues, with legend and per-segment tooltips; everything else as tables.
 * Every bar carries its value as text, so nothing is read from color alone.
 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "—");

// Outcome groups: fixed order, fixed hue. Color follows the outcome, never its rank.
const OUTCOMES = [
  { key: "achieved", label: "Achieved", color: "var(--cat-1)", statuses: ["achieved"] },
  { key: "ended", label: "Ended early (not achieved or cancelled)", color: "var(--cat-2)", statuses: ["not_achieved", "cancelled"] },
  { key: "abandoned", label: "Abandoned (idle)", color: "var(--cat-3)", statuses: ["abandoned"] },
  { key: "active", label: "Still active", color: "var(--cat-4)", statuses: ["active"] },
];
const outcomeOf = (status) => OUTCOMES.find((o) => o.statuses.includes(status)) ?? OUTCOMES[3];
const STATUS_LABEL = { achieved: "Achieved", not_achieved: "Not achieved", cancelled: "Cancelled", abandoned: "Abandoned", active: "Active" };
const pill = (status) => `<span class="pill" style="--pill:${outcomeOf(status).color}">${esc(STATUS_LABEL[status] ?? status)}</span>`;

const HUMAN = {
  kinds: "Intent", stages: "Journey stage", principal_types: "Acting for", organization_sizes: "Organisation size",
  regions: "Region", discovery_sources: "How they found us", constraint_fields: "Hard constraints on", decision_criteria: "Decision criteria",
};

/* ------------------------------------------------------------- tooltip */

const tip = $("tooltip");
document.addEventListener("mousemove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.getAttribute("data-tip");
  tip.hidden = false;
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY + 14}px`;
});

/* ------------------------------------------------------------ builders */

function barList(items, { total, unit = "" } = {}) {
  if (!items?.length) return `<p class="empty">No data yet.</p>`;
  const max = Math.max(...items.map((i) => i.n), 1);
  return `<div class="bars">${items.map((i) => `
    <div class="bar-row" data-tip="${esc(i.key)}: ${i.n}${unit}${total ? ` (${pct(i.n, total)})` : ""}">
      <span class="bar-label" title="${esc(i.key)}">${esc(i.key)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(i.n / max) * 100}%; display:block"></span></span>
      <span class="bar-value">${i.n}${total ? `<small>${pct(i.n, total)}</small>` : ""}</span>
    </div>`).join("")}</div>`;
}

function group(title, items, opts) {
  return `<div class="bar-group"><h3>${esc(title)}</h3>${barList(items, opts)}</div>`;
}

function renderTiles(s) {
  const t = s.totals;
  $("t-started").textContent = t.started;
  const achieved = t.by_status.achieved ?? 0;
  $("t-achieved").textContent = achieved;
  $("t-achieved-note").textContent = t.started ? `${pct(achieved, t.started)} of journeys started` : "";
  $("t-verified").textContent = pct(t.verified, t.started);
  $("t-verified-note").textContent = `${t.verified} signed, ${t.unverified} unsigned`;
  $("t-complete").textContent = t.avg_completeness === null ? "—" : `${Math.round(t.avg_completeness * 100)}%`;
}

function renderFunnel(s) {
  const started = s.funnel[0]?.n ?? 0;
  $("funnel").innerHTML = barList(s.funnel.map((f) => ({ key: f.step, n: f.n })), { total: started });
}

function renderDaily(s) {
  const days = s.daily.map((d) => ({
    day: d.day,
    counts: Object.fromEntries(OUTCOMES.map((o) => [o.key, o.statuses.reduce((a, st) => a + (d[st] ?? 0), 0)])),
  }));
  if (!days.length) {
    $("daily").innerHTML = `<p class="empty">No journeys in this period.</p>`;
    $("daily-legend").innerHTML = "";
    return;
  }
  const W = 560, H = 220, padL = 32, padB = 26, padT = 8, padR = 8;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(1, ...days.map((d) => OUTCOMES.reduce((a, o) => a + d.counts[o.key], 0)));
  const step = max <= 5 ? 1 : Math.ceil(max / 4);
  const top = Math.ceil(max / step) * step;
  const band = plotW / days.length;
  const barW = Math.max(3, Math.min(36, band * 0.62));
  const gap = 2;

  let grid = "";
  for (let v = 0; v <= top; v += step) {
    const y = padT + plotH * (1 - v / top);
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" class="chart-grid"/>
      <text x="${padL - 6}" y="${y + 3}" text-anchor="end" class="chart-axis">${v}</text>`;
  }
  const every = Math.ceil(days.length / 8);
  const bars = days.map((d, i) => {
    const x = padL + i * band + (band - barW) / 2;
    let y = padT + plotH;
    let first = true;
    const segs = OUTCOMES.map((o, idx) => {
      const n = d.counts[o.key];
      if (!n) return "";
      const h = Math.max(1, (n / top) * plotH - gap);
      y -= h + (first ? 0 : gap);
      first = false;
      const isTop = OUTCOMES.slice(idx + 1).every((o2) => !d.counts[o2.key]);
      const r = isTop ? 4 : 0;
      return `<path d="${roundedTop(x, y, barW, h, r)}" style="fill:${o.color}" data-tip="${d.day} · ${o.label}: ${n}"/>`;
    }).join("");
    const label = i % every === 0
      ? `<text x="${x + barW / 2}" y="${H - 8}" text-anchor="middle" class="chart-axis">${new Date(d.day + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>`
      : "";
    return segs + label;
  }).join("");

  $("daily").innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Journeys per day, stacked by outcome">${grid}${bars}</svg>`;
  $("daily-table").innerHTML = table(
    [{ label: "Day" }, ...OUTCOMES.map((o) => ({ label: o.label.replace(/ \(.*\)$/, ""), num: true }))],
    [...days].reverse().map((d) => [esc(d.day), ...OUTCOMES.map((o) => d.counts[o.key])]),
  );
  $("daily-legend").innerHTML = OUTCOMES.map((o) => `<span class="legend-item"><span class="swatch" style="background:${o.color}"></span>${o.label}</span>`).join("");
}

function roundedTop(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function table(headers, rows) {
  if (!rows.length) return `<p class="empty">Nothing yet.</p>`;
  return `<div class="table-wrap"><table class="table"><thead><tr>${headers.map((h) => `<th class="${h.num ? "num" : ""}">${esc(h.label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${headers[i].num ? "num" : ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function renderDropoff(s) {
  const rows = s.dropoff.flatMap((d) => d.outcomes.map((o, i) => [i === 0 ? `<b>${esc(d.step)}</b>` : "", esc(o.key.replace(/_/g, " ")), o.n]));
  $("dropoff").innerHTML = table([{ label: "Step" }, { label: "How it stopped" }, { label: "Journeys", num: true }], rows);
  $("rejections").innerHTML = table(
    [{ label: "Call" }, { label: "Reason" }, { label: "Count", num: true }],
    s.rejections.map((r) => [esc(r.step), `<code>${esc(r.reason)}</code>`, r.n]),
  );
}

function renderIntent(s) {
  const total = s.totals.started;
  $("intent").innerHTML = Object.entries(s.intent)
    .map(([k, items]) => group(HUMAN[k] ?? k, items.slice(0, 8), { total }))
    .join("");
  $("fields").innerHTML = s.fields.length
    ? s.fields.map((f) => group(`${f.step} · ${f.field.replace(/_/g, " ")}${f.kind === "buckets" ? " (buckets)" : f.kind === "months" ? " (by month)" : ""}`,
        f.values.slice(0, 10), { total })).join("")
    : `<p class="empty">No logged fields yet.</p>`;
}

function renderTexts(s) {
  const rows = s.texts ?? [];
  $("texts").innerHTML = rows.length
    ? `<div class="table-wrap"><table class="table"><thead><tr><th>Started</th><th>Step</th><th>Field</th><th>Answer</th></tr></thead>
      <tbody>${rows.map((t) => `<tr class="clickable" data-ref="${esc(t.ref)}" tabindex="0">
        <td>${esc(new Date(t.created_at).toLocaleString())}</td><td>${esc(t.step)}</td>
        <td>${esc(t.field.replace(/_/g, " "))}</td><td>${esc(t.text)}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="empty">No free-text answers yet.</p>`;
}

function renderCompetition(s) {
  $("competition").innerHTML =
    group("Also considered", s.competition.considered.slice(0, 10)) +
    group("Chosen instead (from cancel reasons)", s.competition.chosen_instead.slice(0, 10));
}

function renderAgents(s) {
  $("agents").innerHTML =
    table([{ label: "Agent" }, { label: "Journeys", num: true }, { label: "Avg completeness", num: true }],
      s.agents.by_agent.map((a) => [esc(a.key), a.n, `${Math.round(a.avg_completeness * 100)}%`])) +
    `<h3>Claimed product → verified identity</h3>` +
    table([{ label: "Claim → verified" }, { label: "Journeys", num: true }],
      s.agents.claims_vs_verified.map((c) => [esc(c.key), c.n]));
}

/* --------------------------------------------------------- list + detail */

async function loadList() {
  const def = $("f-definition").value;
  const q = new URLSearchParams({ definition: def, days: $("f-days").value });
  if ($("f-status").value) q.set("status", $("f-status").value);
  const data = await (await fetch(`/api/analytics/journeys?${q}`)).json();
  const body = $("list").querySelector("tbody");
  body.innerHTML = data.journeys.length
    ? data.journeys.map((j) => `<tr class="clickable" tabindex="0" data-ref="${esc(j.ref)}">
        <td>${new Date(j.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        <td>${pill(j.status)}${j.end_reason ? `<br><small>${esc(j.end_reason)}</small>` : ""}</td>
        <td>${j.verified ? esc(j.agent) : "<span class=\"no\">unverified</span>"}</td>
        <td>${esc(j.intent)}</td>
        <td>${esc(j.goal)}</td>
        <td class="num">${j.completed_steps.length}/${data.steps.length}</td>
        <td class="num">${Math.round(j.completeness * 100)}%</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="empty">No journeys match.</td></tr>`;
}

async function loadLeads() {
  const isPricing = $("f-definition").value === "price-estimate";
  $("leads-card").hidden = !isPricing;
  if (!isPricing) return;
  const data = await (await fetch(`/api/analytics/leads?days=${$("f-days").value}`)).json();
  $("leads-note").textContent = `Emails agents left when ending a price estimate with step close: a sign of serious interest, not a contact request. After ${data.retention_days} days the name and message are deleted and the email is reduced to its domain. Click a row to open its journey.`;
  $("leads").querySelector("tbody").innerHTML = data.leads.length
    ? data.leads.map((l) => `<tr class="clickable" tabindex="0" data-ref="${esc(l.journey_ref)}">
        <td>${new Date(l.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        <td>${l.purged_at ? `<span class="no">${esc(l.email)}</span>` : esc(l.email)}</td>
        <td>${esc(l.name ?? "—")}</td>
        <td>${esc(l.company ?? "—")}</td>
        <td>${esc(l.options.join(", "))}</td>
        <td class="num">${esc(l.currency)} ${Number(l.total).toLocaleString()}</td>
        <td>${esc(l.message ?? "—")}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="empty">No emails left in this period.</td></tr>`;
}

async function showDetail(ref) {
  const d = await (await fetch(`/api/analytics/journeys/${encodeURIComponent(ref)}`)).json();
  $("d-ref").textContent = d.ref;
  $("d-prompt").textContent = d.reconstructed_prompt || "Not enough declared to reconstruct a prompt.";
  $("d-prompt-note").textContent = d.reconstructed_prompt_note;
  const facts = [
    ["Outcome", pill(d.status) + (d.end_reason ? ` <code>${esc(d.end_reason)}</code>` : "")],
    ["Detail", esc(d.end_detail ?? "—")],
    ["Chosen instead", esc(d.alternative_chosen ?? "—")],
    ["Agent", d.agent ? `${esc(d.agent.name)} <small>(${esc(d.agent.trust_tier)})</small>` : "unverified"],
    ["Human present", d.human_present ? "yes" : "no"],
    ["Intent completeness", `${Math.round(d.completeness * 100)}%`],
    ...(d.lead ? [["Email left", `${esc(d.lead.email)} · estimate ${esc(d.lead.currency)} ${Number(d.lead.total).toLocaleString()}`]] : []),
    ["Steps", d.steps.map((s) => (d.completed_steps.includes(s) ? `<span class="ok">✓ ${esc(s)}</span>` : `<span>· ${esc(s)}</span>`)).join(" ")],
  ];
  $("d-facts").innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  $("d-intent").textContent = JSON.stringify(d.intent, null, 2);
  $("d-fields").textContent = JSON.stringify(d.step_data, null, 2);
  const t0 = d.events[0] ? Date.parse(d.events[0].ts) : 0;
  $("d-events").innerHTML = d.events.map((e) => `<li>
      <span class="t">+${Math.round((Date.parse(e.ts) - t0) / 1000)}s</span>
      <span><b>${esc(e.step)}</b> · <span class="${e.outcome === "accepted" ? "ok" : "no"}">${e.outcome === "accepted" ? "✓ accepted" : "✗ refused"}</span> · ${e.status}
      ${e.reason ? ` · <code>${esc(e.reason)}</code>` : ""}
      ${e.details?.fields ? `<br><small>${esc(e.details.fields.join(", "))}</small>` : ""}
      ${e.details?.missing_steps ? `<br><small>missing: ${esc(e.details.missing_steps.join(", "))}</small>` : ""}</span>
    </li>`).join("");
  $("detail").hidden = false;
  $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

for (const id of ["list", "texts"]) {
  $(id).addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-ref]");
    if (row) showDetail(row.dataset.ref);
  });
  $(id).addEventListener("keydown", (e) => {
    const row = e.target.closest("tr[data-ref]");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); showDetail(row.dataset.ref); }
  });
}
$("leads").addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-ref]");
  if (row && !e.target.closest("a")) showDetail(row.dataset.ref);
});
$("leads").addEventListener("keydown", (e) => {
  const row = e.target.closest("tr[data-ref]");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); showDetail(row.dataset.ref); }
});
$("d-close").addEventListener("click", () => { $("detail").hidden = true; });

/* ---------------------------------------------------------------- load */

async function loadDefinitions() {
  const data = await (await fetch("/.well-known/agent-journeys")).json();
  const want = new URLSearchParams(location.search).get("definition");
  $("f-definition").innerHTML = data.journeys
    .map((j) => `<option value="${esc(j.id)}" ${j.id === want ? "selected" : ""}>${esc(j.title)}</option>`).join("");
}

async function load() {
  const btn = $("refresh");
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const q = new URLSearchParams({ definition: $("f-definition").value, days: $("f-days").value });
    const res = await fetch(`/api/analytics/summary?${q}`);
    if (!res.ok) throw new Error(`analytics returned ${res.status}`);
    const s = await res.json();
    $("notice").hidden = !s.capped;
    $("notice").textContent = s.capped ? `Showing the most recent ${s.journeys_counted} journeys only.` : "";
    renderTiles(s);
    renderFunnel(s);
    renderDaily(s);
    renderDropoff(s);
    renderIntent(s);
    renderTexts(s);
    renderCompetition(s);
    renderAgents(s);
    await loadList();
    await loadLeads();
  } catch (err) {
    $("notice").hidden = false;
    $("notice").textContent = `Could not load: ${err?.message ?? err}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh";
  }
}

$("refresh").addEventListener("click", load);
$("f-definition").addEventListener("change", load);
$("f-days").addEventListener("change", load);
$("f-status").addEventListener("change", loadList);

await loadDefinitions();
await load();
