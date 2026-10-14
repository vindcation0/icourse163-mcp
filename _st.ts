// TEMPORARY probe - safe to delete. Full per-unit state table.
import { readFileSync } from "node:fs";

const FILE = "C:\\Users\\vindacation\\icourse163-cookie.txt";
let cookie = readFileSync(FILE, "utf8").trim();
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const ORIGIN = "https://www.icourse163.org";
const LEARN = `${ORIGIN}/learn/XDU-1450750234?tid=1475848441`;
const termId = "1475848441";

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
const moc = JSON.parse(
  await (
    await fetch(`${ORIGIN}/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey=${encodeURIComponent(csrf)}`, {
      method: "POST",
      headers: {
        cookie, origin: ORIGIN, referer: LEARN,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "user-agent": UA,
      },
      body: new URLSearchParams({ termId }).toString(),
      redirect: "manual",
    })
  ).text(),
).result.mocTermDto;

const CT: Record<number, string> = { 1: "video", 3: "pdf", 4: "rich", 5: "quiz" };
const fmt = (ms: unknown) =>
  typeof ms === "number" && ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "-";

let done = 0;
let todo: string[] = [];
for (const ch of moc.chapters ?? []) {
  console.log(`\n## ${ch.name}`);
  for (const ls of ch.lessons ?? []) {
    for (const u of ls.units ?? []) {
      const ok = String(u.completePercent) === "1";
      if (ok) done += 1;
      else todo.push(`${u.id}(${CT[u.contentType] ?? u.contentType})`);
      console.log(
        `${ok ? "   " : "!! "} ${String(u.id).padEnd(11)} ${(CT[u.contentType] ?? u.contentType).padEnd(5)} ` +
          `pct=${String(u.completePercent).slice(0, 8).padEnd(8)} mod=${fmt(u.gmtModified)}  ${u.name}`,
      );
    }
  }
}
console.log(`\n=== done ${done} / remaining ${todo.length}: ${todo.join(" ")}`);
