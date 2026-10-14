// TEMPORARY probe - safe to delete. Is userId required in the signed payload?
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SIGN_KEY = "fu2s2kxcswgn5hqanx7asmlogyr5wu29";
let cookie = readFileSync("C:\\Users\\vindacation\\.config\\icourse163-mcp\\session", "utf8").trim();
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const ORIGIN = "https://www.icourse163.org";
const LEARN = `${ORIGIN}/learn/XDU-1450750234?tid=1475848441`;
const termId = "1475848441";

const sign = (b: string, n: number, t: number) =>
  createHash("md5").update(`${b}${n}${t}${SIGN_KEY}`, "utf8").digest("hex").toUpperCase();

const warm = await fetch(`${ORIGIN}/`, { headers: { cookie, "user-agent": UA }, redirect: "manual" });
for (const raw of typeof warm.headers.getSetCookie === "function" ? warm.headers.getSetCookie() : []) {
  const pair = raw.split(";")[0].trim();
  const eq = pair.indexOf("=");
  if (eq <= 0) continue;
  const n = pair.slice(0, eq).trim();
  const parts = cookie.split(";").map((s) => s.trim()).filter(Boolean).filter((p) => p.slice(0, p.indexOf("=")).trim() !== n);
  parts.push(pair);
  cookie = parts.join("; ");
}
const csrf = /NTESSTUDYSI=([^;]+)/.exec(cookie)?.[1] ?? "";

// where does userId live? look at the course panel response
const panelText = await (
  await fetch(`${ORIGIN}/web/j/learnerCourseRpcBean.getMyLearnedCoursePanelList.rpc?csrfKey=${encodeURIComponent(csrf)}`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN, referer: `${ORIGIN}/`, "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "edu-script-token": csrf, "user-agent": UA },
    body: new URLSearchParams({ type: "30", p: "1", psize: "1", courseType: "1" }).toString(),
    redirect: "manual",
  })
).text();
console.log("panel response keys containing 'user':");
for (const m of panelText.matchAll(/"([a-zA-Z]*[uU]ser[a-zA-Z]*)"\s*:\s*("?[^,}"]*"?)/g)) {
  console.log(`   ${m[1]} = ${m[2]}`);
}
const uidFromPanel = /"userId"\s*:\s*"?(\d+)"?/.exec(panelText)?.[1] ?? null;
console.log("userId extracted:", uidFromPanel);

const videoId = 1216009818;
const total = 1126;

async function save(label: string, dto: Record<string, unknown>) {
  const bodyJson = JSON.stringify({ dto });
  const timestamp = Date.now();
  const nonce = Math.floor(9000 * Math.random()) + 1000;
  const res = await fetch(`${ORIGIN}/web/j/courseRpcBean.saveMocContentLearn.rpc?csrfKey=${encodeURIComponent(csrf)}`, {
    method: "POST",
    headers: {
      cookie, origin: ORIGIN, referer: LEARN, "user-agent": UA,
      "content-type": "application/json;charset=UTF-8",
      "edu-script-token": csrf,
      timestamp: String(timestamp), nonce: String(nonce), system: "v1",
      "auth-signature": sign(bodyJson, nonce, timestamp),
    },
    body: bodyJson,
    redirect: "manual",
  });
  console.log(`  ${label}\n     -> ${res.status} ${(await res.text()).slice(0, 170)}`);
}

const base = {
  unitId: 1305575052, // already at completePercent 1 -> no side effect
  finished: true,
  index: 1,
  duration: 60000,
  courseId: 1450750234,
  lessonId: 1265444035,
  videoId,
  termId: 1475848441,
  contentType: 1,
  action: "LEARN_TIME_COUNT",
  videoTime: total,
  learnedVideoTimeCount: 60,
};

console.log("\n=== is userId required? ===");
await save("WITH userId", { ...base, userId: uidFromPanel ?? "1597616487" });
await new Promise((r) => setTimeout(r, 1500));
await save("WITHOUT userId", { ...base });
await new Promise((r) => setTimeout(r, 1500));
await save("with numeric userId", { ...base, userId: Number(uidFromPanel ?? 1597616487) });
