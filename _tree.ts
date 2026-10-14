// TEMPORARY probe - safe to delete. Why does chapter expansion not reveal the unit?
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const SESSION = "C:\\Users\\vindacation\\.config\\icourse163-mcp\\session";
const cookie = readFileSync(SESSION, "utf8").trim();
const LEARN = "https://www.icourse163.org/learn/XDU-1450750234?tid=1475848441";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const TARGET = "1305575062";

const cookies = cookie
  .split(";")
  .map((p) => {
    const i = p.indexOf("=");
    return { name: p.slice(0, i).trim(), value: p.slice(i + 1), domain: ".icourse163.org", path: "/" };
  })
  .filter((c) => c.name.length > 0);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();

await page.goto(LEARN, { waitUntil: "commit", timeout: 60000 });
await page.getByText("课件", { exact: true }).first().waitFor({ state: "visible", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(4000);
const skip = page.getByText("暂不评价", { exact: false }).first();
if ((await skip.count().catch(() => 0)) > 0 && (await skip.isVisible().catch(() => false))) {
  await skip.click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(2000);
}
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(1000);
await page.locator('li.ant-menu-item:has-text("课件")').first().click({ timeout: 8000 }).catch(() => {});
await page.waitForTimeout(7000);

const report = async (label: string) => {
  const info = await page.evaluate(
    new Function(
      "return (function () {" +
        "var blocks = Array.prototype.slice.call(document.querySelectorAll('.m-learnChapterNormal'));" +
        "return {" +
        "  chapterBlocks: blocks.length," +
        "  anyLearnChapterList: document.querySelectorAll('.m-learnChapterList').length," +
        "  totalDataCid: document.querySelectorAll('[data-cid]').length," +
        "  allDataCids: Array.prototype.map.call(document.querySelectorAll('[data-cid]'), function (e) { return e.getAttribute('data-cid'); })," +
        "  blocks: blocks.map(function (b) {" +
        "    var title = b.querySelector('.j-titleName, .titleBox h3, h3');" +
        "    var down = b.querySelector('.j-down');" +
        "    var up = b.querySelector('.j-up');" +
        "    var v = function (el) {" +
        "      if (!el) return 'absent';" +
        "      var s = getComputedStyle(el);" +
        "      return (s.display === 'none' || s.visibility === 'hidden') ? 'hidden' : 'visible';" +
        "    };" +
        "    return {" +
        "      title: (title ? title.textContent : '?').trim().slice(0, 18)," +
        "      cids: b.querySelectorAll('[data-cid]').length," +
        "      down: v(down)," +
        "      up: v(up)" +
        "    };" +
        "  })" +
        "};" +
        "})()",
    ) as () => unknown,
  );
  const typed = info as {
    chapterBlocks: number;
    totalDataCid: number;
    allDataCids: string[];
    blocks: { title: string; cids: number; down: string; up: string }[];
  };
  console.log(`\n=== ${label} ===`);
  console.log("  chapterBlocks:", typed.chapterBlocks, " totalDataCid:", typed.totalDataCid);
  console.log("  dataCids:", JSON.stringify(typed.allDataCids));
  for (const b of typed.blocks) {
    console.log(`   - "${b.title}" cids=${b.cids} caret-up=${b.down} caret-down=${b.up}`);
  }
};

await report("after opening 课件");

console.log("\n=== click every chapter titleBox ===");
const boxes = page.locator(".m-learnChapterNormal .j-titleBox, .m-learnChapterNormal .titleBox");
const n = await boxes.count().catch(() => 0);
console.log("  titleBox count:", n);
for (let i = 0; i < n; i += 1) {
  const ok = await boxes.nth(i).click({ timeout: 3000, force: true }).then(() => true).catch(() => false);
  console.log(`  clicked #${i}: ok=${ok}`);
  await page.waitForTimeout(700);
}
await page.waitForTimeout(2000);
await report("after clicking all titleBoxes");

console.log(`\n  target ${TARGET} present?`, await page.locator(`[data-cid="${TARGET}"]`).count());
await page.screenshot({ path: "_tree.png" }).catch(() => {});
await browser.close();
