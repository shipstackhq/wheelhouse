// A signed pull_request delivery for the connected repository, naming an open ticket, sent to the app running on the copy.
// Signed with the real webhook secret from the environment (never printed). Proves the next webhook lands on the right team.
import crypto from "node:crypto";
const facts = JSON.parse(process.argv[2]);
const base = process.argv[3];
if (!facts.repo || !facts.ticket) {
  console.log("  skip no connected GitHub repository or no open ticket in this data");
  process.exit(0);
}
const secret = process.env.GITHUB_WEBHOOK_SECRET;
if (!secret) {
  console.log("  skip GITHUB_WEBHOOK_SECRET is not set");
  process.exit(0);
}
const body = JSON.stringify({
  action: "opened",
  installation: { id: Number(facts.repo.inst) },
  repository: { id: Number(facts.repo.repo), full_name: "rehearsal/repo" },
  pull_request: { number: 9001, title: `Rehearsal for ${facts.ticket}`, html_url: "https://example.test/pr/9001", state: "open", draft: false, merged: false, user: { login: "rehearsal" }, head: { ref: `wh/${facts.ticket}-rehearsal`, sha: "a".repeat(40) }, base: { ref: "main" } },
});
const signature = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
const r = await fetch(base + "/api/webhooks/github", {
  method: "POST",
  headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "rehearsal-" + Date.now(), "x-hub-signature-256": signature },
  body,
});
const text = await r.text();
const good = r.status === 200 && /"status":"handled"/.test(text);
console.log(`  ${good ? "ok  " : "FAIL"} a signed pull_request webhook for the connected repository of ${facts.repo.team}: HTTP ${r.status} ${text.slice(0, 140)}`);
process.exit(good ? 0 : 1);
