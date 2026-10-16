/**
 * A plausible reconstruction of the user's original prompt, built from the
 * intent envelope and the logged step fields with a fixed template.
 *
 * Deliberately not a language model: deterministic, free, and it can never
 * invent something the agent did not declare. The dashboard labels it as a
 * reconstruction. An LLM-written version is an open decision
 * (AGENT-JOURNEY-PROTOCOL.md §11).
 */
type Obj = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const OP_WORDS: Record<string, string> = {
  lt: "under", lte: "at most", gt: "over", gte: "at least", eq: "exactly",
  neq: "not", in: "one of", not_in: "none of", contains: "including",
};

function sentence(s: string): string {
  const t = s.trim().replace(/[.\s]+$/, "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) + "." : "";
}

function fmtValue(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "number") return v.toLocaleString("en-US");
  return String(v);
}

const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");

/** "I'm a head of e-commerce at a 50-249-person industrial supplies company in CH" */
function describePrincipal(p: Obj): string | null {
  const role = str(p.role) ?? (p.type === "consumer" ? "private customer" : null);
  const org = [p.organization_size ? `${p.organization_size}-person` : null, str(p.industry),
    p.organization_size || p.industry || p.type === "business" ? "company" : null].filter(Boolean).join(" ");
  const region = str(p.region);
  if (!role && !org && !region) return null;

  let s = "I'm";
  if (role) s += ` ${article(role)} ${role}`;
  if (org) s += role ? ` at ${article(org)} ${org}` : ` with ${article(org)} ${org}`;
  if (region) s += role || org ? ` in ${region}` : ` based in ${region}`;
  return s;
}

export function reconstructPrompt(intent: Obj, stepData: Record<string, Obj>): string {
  const parts: string[] = [];

  const who = describePrincipal(obj(intent.principal));
  const summary = str(intent.request_summary);
  const goal = str(intent.goal);

  if (who) parts.push(sentence(who));
  if (summary) parts.push(sentence(summary));
  else if (goal) parts.push(sentence(goal));

  const constraints = arr(intent.constraints).map((c) => {
    const o = obj(c);
    if (str(o.note) && !o.field) return str(o.note);
    const unit = str(o.unit) ? ` ${o.unit}` : "";
    return [str(o.field), OP_WORDS[String(o.op)] ?? o.op, o.value !== undefined ? fmtValue(o.value) + unit : null]
      .filter(Boolean).join(" ");
  }).filter(Boolean);
  if (constraints.length) parts.push(sentence(`It must be: ${constraints.join("; ")}`));

  const criteria = arr(intent.decision_criteria).map((c) => {
    const o = obj(c);
    const dir = str(o.direction);
    return dir ? `${dir} ${o.criterion}` : String(o.criterion);
  });
  if (criteria.length) parts.push(sentence(`What matters most, in order: ${criteria.join(", ")}`));

  const alts = arr(intent.alternatives_considered).map(String);
  if (alts.length) parts.push(sentence(`I'm also looking at ${alts.join(", ")}`));

  const facts: string[] = [];
  for (const fields of Object.values(stepData)) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined || v === "") continue;
      facts.push(`${k.replace(/_/g, " ")}: ${fmtValue(v)}`);
    }
  }
  if (facts.length) parts.push(sentence(`Details: ${facts.join("; ")}`));

  const deliverable = str(intent.expected_deliverable);
  const authority = obj(intent.authority);
  if (deliverable) parts.push(sentence(`Give me ${deliverable}`));
  if (authority.can_commit === false) parts.push("Don't commit to anything without asking me.");

  return parts.join(" ");
}
