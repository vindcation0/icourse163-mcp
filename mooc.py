#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
中国大学MOOC 一键刷课 —— 对 icourse163-mcp 的傻瓜封装。

只用 Python 标准库，不需要 pip install 任何东西，**登录和刷课都不需要浏览器**。
它通过 stdio 驱动本仓库的 MCP 服务器；登录走 Node 命令行（MCP 按设计不接收密码，
密码永远不会经过 AI 或本脚本）。

登录默认走纯 HTTP 通道：复现 URS 组件的请求（SM4 信封 + 工作量证明 + RSA 密码），
约 4 秒。若站点要求验证码/短信，改用 `login --browser`。

用法：
    python mooc.py                 显示能做什么
    python mooc.py login           第一次用：输账号密码登录（密码不显示，约 4 秒）
    python mooc.py status          看看登录还有效吗
    python mooc.py courses         列出所有课程
    python mooc.py units <课程ID> <学期ID>
    python mooc.py study <课程ID> <学期ID> [选项]
    python mooc.py auto            最省事：挑一门课，把没学完的刷完

login 的选项：
    --browser          改用浏览器登录（能处理验证码/短信）
    --channel phone    登录通道（默认 phone）
    -u <手机号>         直接指定账号

study / auto 的选项：
    --rate 2           视频播放倍速（0.5~2，默认 2）
    --unit <单元ID>    只刷指定单元
    --dry-run          只列出要刷什么，不动手
    --timeout 300      单个单元的超时秒数
    --transport rpc    优先用 RPC（默认），可选 playwright / auto
"""

from __future__ import annotations

import argparse
import json
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

# Windows 控制台默认不是 UTF-8，中文和 emoji 会炸，先修好
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

REPO = Path(__file__).resolve().parent
SERVER_ENTRY = REPO / "src" / "stdio.ts"
LOGIN_ENTRY = REPO / "src" / "login-cli.ts"
LOGIN_HTTP_ENTRY = REPO / "src" / "urs-login-cli.ts"

OK = "✅"
BAD = "❌"
SKIP = "⏭️ "
WARN = "⚠️ "

# 这些类型 study_unit 处理不了，需要人来做（答题之类）
MANUAL_TYPES = {"quiz", "other"}


def find_node() -> str:
    node = shutil.which("node") or shutil.which("node.exe")
    if node is None:
        die(
            "找不到 node。请先安装 Node.js 18 以上版本：https://nodejs.org/\n"
            "   装完关掉这个窗口重新打开一次。"
        )
    return node


def die(message: str, code: int = 2) -> None:
    print(f"\n{BAD} {message}\n")
    raise SystemExit(code)


# --------------------------------------------------------------------------- #
# MCP 客户端
# --------------------------------------------------------------------------- #


class Mcp:
    """本机 stdio MCP 服务器的极简客户端（换行分隔的 JSON-RPC）。"""

    def __init__(self, timeout: float = 300.0) -> None:
        if not SERVER_ENTRY.exists():
            die(f"找不到 {SERVER_ENTRY}。请把本脚本放在 icourse163-mcp 仓库根目录下运行。")
        self.timeout = timeout
        self.next_id = 0
        self.lines: "queue.Queue[str]" = queue.Queue()
        self.proc = subprocess.Popen(
            [find_node(), "--import", "tsx", str(SERVER_ENTRY)],
            cwd=str(REPO),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()
        self._request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "mooc.py", "version": "1.0.0"},
            },
        )
        self._notify("notifications/initialized")

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            if line.strip():
                self.lines.put(line)

    def _send(self, payload: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def _id(self) -> int:
        self.next_id += 1
        return self.next_id

    def _notify(self, method: str) -> None:
        self._send({"jsonrpc": "2.0", "method": method})

    def _request(self, method: str, params: dict) -> dict:
        request_id = self._id()
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            try:
                line = self.lines.get(timeout=self.timeout)
            except queue.Empty:
                die(
                    f"{method} 等了 {self.timeout:.0f} 秒还没结果，已放弃。\n"
                    "   如果是在刷剧集很长的视频，可以用 --timeout 加大，例如 --timeout 900"
                )
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue  # 不是 JSON 就丢掉（正常不该出现）
            if message.get("id") != request_id:
                continue
            if "error" in message:
                die(f"服务器报错：{message['error']}")
            return message.get("result", {})

    def call(self, name: str, arguments: dict | None = None) -> dict:
        result = self._request(
            "tools/call", {"name": name, "arguments": arguments or {}}
        )
        structured = result.get("structuredContent")
        if isinstance(structured, dict):
            return structured
        for block in result.get("content", []):
            if block.get("type") == "text":
                try:
                    return json.loads(block["text"])
                except json.JSONDecodeError:
                    continue
        return {}

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()

    def __enter__(self) -> "Mcp":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


# --------------------------------------------------------------------------- #
# 帮助函数
# --------------------------------------------------------------------------- #


def pct_text(percent) -> str:
    if percent is None:
        return "未学"
    if percent >= 0.999:
        return "已完成"
    return f"{percent * 100:.1f}%"


def is_done(unit: dict) -> bool:
    value = unit.get("complete_percent")
    return isinstance(value, (int, float)) and value >= 0.999


def flatten_units(lessons) -> list[dict]:
    units: list[dict] = []
    for lesson in lessons or []:
        for unit in lesson.get("units", []):
            units.append({**unit, "lesson": lesson.get("name", "")})
    return units


def check_session(mcp: Mcp) -> dict:
    """返回会话状态；不可用时直接给出该敲什么命令。"""
    status = mcp.call("session_status")
    if status.get("api") == "ok":
        return status
    stored = status.get("stored")
    print(f"{BAD} 登录不可用（{status.get('status')}）")
    if not stored:
        print("   本机还没有保存过登录信息。")
    elif status.get("cookies", {}).get("ntesstudysi"):
        print("   保存的登录信息已经过期。")
    else:
        print("   保存的登录信息不完整。")
    print("\n   请先运行：\n     python mooc.py login\n")
    raise SystemExit(1)


def pick_course(mcp: Mcp, keyword: str | None, term: str | None) -> tuple[str, str, str]:
    """从已选课程里挑一个 (课程ID, 学期ID, 学校简称)。"""
    result = mcp.call("list_courses")
    courses = result.get("courses", [])
    if not courses:
        die("这门号下没有已选课程。确认登录的是正确的账号？")

    if keyword or term:
        matched = [
            c
            for c in courses
            if (not keyword or keyword in c["name"])
            and (not term or c["term_id"] == term)
        ]
        if not matched:
            die(f"没有匹配的课程（关键词={keyword!r} 学期={term!r}）。用 `python mooc.py courses` 看看有哪些。")
        courses = matched

    if len(courses) == 1:
        chosen = courses[0]
        print(
            f"   课程：{chosen['name']}（{chosen['school']}）学期 {chosen['term_id']}"
        )
        return chosen["id"], chosen["term_id"], chosen["school"]

    if not sys.stdin.isatty():
        listing = "、".join(f"{c['name']}({c['term_id']})" for c in courses)
        die(
            "有多门课程，但当前不是交互式终端，没法让你选序号。\n"
            f"   可选：{listing}\n"
            "   请改用：python mooc.py study <course_id> <term_id> --school <学校简称>\n"
            "   或：  python mooc.py auto --course <课程名关键词> --term <学期ID>"
        )

    print("\n   你有这些课程：")
    for index, course in enumerate(courses, start=1):
        print(f"     {index:>2}. {course['name']}（{course['school']}）学期 {course['term_id']}")
    while True:
        try:
            raw = input("\n   请输入序号（直接回车=1）：").strip() or "1"
        except EOFError:
            die("没有收到输入。请改用 --course / --term 指定课程。")
        if raw.isdigit() and 1 <= int(raw) <= len(courses):
            chosen = courses[int(raw) - 1]
            return chosen["id"], chosen["term_id"], chosen["school"]
        print("   请输入列表里的序号。")


def study_one(mcp: Mcp, arguments: dict) -> dict:
    """调用一次 study_unit；遇到服务端限流就等一会重试一次。

    服务器对连续请求会回 "并发限制，请稍后再试"。批量刷课时它偶尔出现，
    重试通常就好了 —— 这也是它和真正的“签名被拒”共用同一条错误文案的坑。
    """
    outcome = mcp.call("study_unit", arguments)
    for _ in range(2):
        if not outcome.get("isError"):
            return outcome
        message = "; ".join(str(e.get("message", "")) for e in outcome.get("errors", []))
        if "并发限制" not in message:
            return outcome
        print("      …服务器限流，等 2.5 秒重试")
        time.sleep(2.5)
        outcome = mcp.call("study_unit", arguments)
    return outcome


def study_units(
    mcp: Mcp,
    course_id: str,
    term_id: str,
    school: str,
    *,
    only_unit: str | None,
    rate: float,
    transport: str,
    dry_run: bool,
    delay: float,
) -> None:
    result = mcp.call(
        "list_term_units",
        {"course_id": course_id, "term_id": term_id, "school_short_name": school},
    )
    if result.get("status") != "ok":
        for error in result.get("errors", []):
            print(f"   {BAD} [{error.get('where')}] {error.get('message')}")
        die("取不到课件列表，先解决上面的问题。")

    units = flatten_units(result.get("lessons"))
    if only_unit:
        units = [unit for unit in units if unit["id"] == only_unit]
        if not units:
            die(f"这门课里没有单元 {only_unit}。用 `python mooc.py units {course_id} {term_id}` 看一下。")

    total = len(units)
    done_units = [unit for unit in units if is_done(unit)]
    todo = [unit for unit in units if not is_done(unit)]
    todo_media = [unit for unit in todo if unit["type"] not in MANUAL_TYPES]
    todo_manual = [unit for unit in todo if unit["type"] in MANUAL_TYPES]

    print(
        f"\n   共 {total} 个单元：已完成 {len(done_units)}，待处理 {len(todo)}"
        f"（其中 {len(todo_media)} 个可自动刷，{len(todo_manual)} 个需要手动）"
    )

    if not todo_media:
        print(f"\n{OK} 没有需要自动刷的了。")
        if todo_manual:
            print(f"   {WARN} 还有 {len(todo_manual)} 个测验/讨论需要你自己处理：")
            for unit in todo_manual[:10]:
                print(f"      - {unit['name']}（{unit['type']}）")
        return

    if dry_run:
        print("\n   --dry-run，只列出要刷的：")
        for unit in todo_media:
            print(f"      {unit['type']:<5} {pct_text(unit.get('complete_percent')):>7}  {unit['name']}  [{unit['id']}]")
        return

    print()
    succeeded = 0
    failed: list[tuple[dict, str]] = []
    for index, unit in enumerate(todo_media, start=1):
        label = f"[{index}/{len(todo_media)}] {unit['name']}（{unit['type']}，{pct_text(unit.get('complete_percent'))}）"
        print(f"   {label}")
        out = study_one(
            mcp,
            {
                "course_id": course_id,
                "term_id": term_id,
                "unit_id": unit["id"],
                "school_short_name": school,
                "playback_rate": rate,
                "transport": transport,
            },
        )
        if out.get("isError"):
            message = "; ".join(
                f"[{e.get('where')}] {e.get('message')}" for e in out.get("errors", [])
            )
            print(f"      {BAD} {out.get('status')}  {message}")
            failed.append((unit, out.get("status", "error")))
        else:
            succeeded += 1
            detail = ""
            if out.get("page_count"):
                detail = f"{out['page_count']} 页"
            elif out.get("learned_sec"):
                detail = f"{out['learned_sec']}s"
            print(f"      {OK} 完成 {detail}（{out.get('transport')}）")
        if delay > 0 and index < len(todo_media):
            time.sleep(delay)

    print(f"\n   本轮：成功 {succeeded}，失败 {len(failed)}")
    if failed:
        print(f"   {WARN} 失败的单元：")
        for unit, status in failed[:10]:
            print(f"      - {unit['name']}  [{unit['id']}]  {status}")
        print("     常见原因：被服务器限流（加大 --delay 再跑，例如 --delay 2）、")
        print("     登录已失效（python mooc.py login）、或该单元需要真人操作（弹题测验）。")
        print("     直接重跑即可 —— 已经完成的单元会自动跳过。")

    # 复查一遍，给个可信的结论
    verification = mcp.call(
        "list_term_units",
        {"course_id": course_id, "term_id": term_id, "school_short_name": school},
    )
    after = flatten_units(verification.get("lessons"))
    done_after = sum(1 for unit in after if is_done(unit))
    print(f"\n   复查：{done_after}/{len(after)} 个单元已完成")


# --------------------------------------------------------------------------- #
# 子命令
# --------------------------------------------------------------------------- #


def cmd_login(args: argparse.Namespace) -> None:
    """登录。

    默认走纯 HTTP 通道：约 4 秒，不打开浏览器。它复现了 URS 组件的请求（SM4 信封、
    工作量证明、RSA 密码），实测可用。失败时**不自动弹浏览器** —— 只告诉你怎么切换。

    --browser 走 Playwright 通道，能处理验证码/短信，但会打开 Chrome 窗口。
    """
    if args.browser:
        if not LOGIN_ENTRY.exists():
            die(f"找不到 {LOGIN_ENTRY}。请把本脚本放在 icourse163-mcp 仓库根目录下运行。")
        print("即将打开浏览器登录中国大学MOOC（可处理验证码/短信）。")
        print("按提示输入账号，然后输入密码（密码不会显示出来，也不会被保存）。\n")
        completed = subprocess.call(
            [find_node(), "--import", "tsx", str(LOGIN_ENTRY)], cwd=str(REPO)
        )
        print()
        if completed == 0:
            print(f"{OK} 登录成功，会话已保存在本机。")
            print("   下一步：python mooc.py auto")
        else:
            print(f"{BAD} 浏览器登录没成功（退出码 {completed}）。")
            print("   若站点要求短信/扫码验证，可以用浏览器插件复制 cookie 后：")
            print("   python mooc.py login --browser 并参考 docs/login.md 的 --cookie-file 一节。")
        return

    if not LOGIN_HTTP_ENTRY.exists():
        die(f"找不到 {LOGIN_HTTP_ENTRY}。请把本脚本放在 icourse163-mcp 仓库根目录下运行。")
    print("用纯 HTTP 登录中国大学MOOC —— 不打开浏览器，约 4 秒。")
    print(f"（账号通道：{args.channel}）\n")
    command = [
        find_node(),
        "--import",
        "tsx",
        str(LOGIN_HTTP_ENTRY),
        "--channel",
        args.channel,
    ]
    if args.username:
        command += ["-u", args.username]
    completed = subprocess.call(command, cwd=str(REPO))
    print()
    if completed == 0:
        print(f"{OK} 登录成功，会话已保存在本机。")
        print("   下一步：python mooc.py status（体检）或 python mooc.py auto（刷课）")
        return
    print(f"{BAD} 纯 HTTP 登录没成功（退出码 {completed}）。")
    print("   常见原因与对策：")
    print("     · 站点要求滑动验证码 → 纯 HTTP 处理不了，改用浏览器：")
    print("         python mooc.py login --browser")
    print("     · 账号被要求短信验证 → 同上")
    print("     · 提示账号格式错误 → 手机号通道要填 11 位手机号（不是邮箱）")
    print("   详细原理与已知边界见 docs/adr/0005-urs-http-login.md")


def cmd_status() -> None:
    with Mcp() as mcp:
        status = mcp.call("session_status")
    markers = status.get("cookies", {})
    usable = status.get("api") == "ok"
    browser = bool(status.get("browser_path_ready"))
    print(f"\n状态：{'✅ 可用' if usable else '❌ 不可用'}")
    print(f"  本机已保存会话：{'是' if status.get('stored') else '否'}")
    print(f"  API 令牌（NTESSTUDYSI）：{'有' if markers.get('ntesstudysi') else '无'}")
    print(f"  网页会话（STUDY_SESS）：{'有' if markers.get('study_sess') else '无'}")
    print(f"  课程数量：{status.get('course_count', 0)}")
    print(f"  浏览器路径可用：{'是' if browser else '否'}")
    print()
    if not usable:
        if not status.get("stored"):
            print("  👉 还没有登录过，请运行：python mooc.py login")
        else:
            print("  👉 登录已失效，请重新运行：python mooc.py login")
    elif browser:
        print("  👉 一切正常。直接跑：python mooc.py auto")
    else:
        print("  👉 可以刷课（走 RPC 通道，不需要浏览器），但网页通道不可用。")
        print("     如果要用 --transport playwright，请先重新 python mooc.py login")
    print()


def cmd_courses() -> None:
    with Mcp() as mcp:
        check_session(mcp)
        result = mcp.call("list_courses")
    courses = result.get("courses", [])
    if not courses:
        print("\n没有已选课程。\n")
        return
    print(f"\n共 {len(courses)} 条课程/学期：\n")
    for course in courses:
        print(f"  {course['name']}（{course['school']}）")
        print(f"     course_id={course['id']}  term_id={course['term_id']}")
    print("\n刷课：python mooc.py study <course_id> <term_id>")
    print("或直接：python mooc.py auto\n")


def cmd_units(course_id: str, term_id: str, school: str) -> None:
    with Mcp() as mcp:
        check_session(mcp)
        result = mcp.call(
            "list_term_units",
            {"course_id": course_id, "term_id": term_id, "school_short_name": school},
        )
    if result.get("status") != "ok":
        for error in result.get("errors", []):
            print(f"  {BAD} [{error.get('where')}] {error.get('message')}")
        raise SystemExit(1)
    units = flatten_units(result.get("lessons"))
    done = sum(1 for unit in units if is_done(unit))
    print(f"\n共 {len(units)} 个单元，已完成 {done}：\n")
    for unit in units:
        mark = OK if is_done(unit) else ("  " if unit["type"] in MANUAL_TYPES else "→ ")
        print(f"  {mark} {unit['type']:<5} {pct_text(unit.get('complete_percent')):>7}  {unit['name']}")
        print(f"        unit_id={unit['id']}   lesson={unit.get('lesson', '')}")
    print()


def cmd_study(args: argparse.Namespace, *, interactive: bool) -> None:
    with Mcp(timeout=args.timeout) as mcp:
        check_session(mcp)
        if interactive:
            course_id, term_id, school = pick_course(mcp, args.course, args.term)
        else:
            course_id, term_id, school = args.course_id, args.term_id, args.school
        study_units(
            mcp,
            course_id,
            term_id,
            school,
            only_unit=args.unit,
            rate=args.rate,
            transport=args.transport,
            dry_run=args.dry_run,
            delay=args.delay,
        )


def cmd_auto(args: argparse.Namespace) -> None:
    print("🎓 中国大学MOOC 一键刷课\n")
    with Mcp(timeout=args.timeout) as mcp:
        status = check_session(mcp)
        print(f"   会话：{OK} 可用（{status.get('course_count', 0)} 条课程/学期）")
        course_id, term_id, school = pick_course(mcp, args.course, args.term)
        study_units(
            mcp,
            course_id,
            term_id,
            school,
            only_unit=args.unit,
            rate=args.rate,
            transport=args.transport,
            dry_run=args.dry_run,
            delay=args.delay,
        )


USAGE = """\
中国大学MOOC 一键刷课 —— 登录和刷课都不需要浏览器

  python mooc.py login            第一次用，先登录（输账号密码，密码不显示；约 4 秒）
  python mooc.py auto             最省事：挑一门课，把没学完的视频/文档刷完
  python mooc.py status           看看登录还有效吗
  python mooc.py courses          列出所有课程，拿到 course_id / term_id
  python mooc.py units <课程ID> <学期ID> [--school XDU]
  python mooc.py study <课程ID> <学期ID> [--school XDU] [--unit 单元ID] [--dry-run]

login 还能加：
  --browser           改用浏览器登录（能处理验证码/短信，会打开 Chrome 窗口）
  --channel phone     登录通道（默认 phone；icourse163 不提供邮箱登录）
  -u <手机号>         直接指定账号，不填则交互式询问

study / auto 还能加：
  --rate 2            视频倍速（0.5~2，默认 2）
  --dry-run           只看看要刷什么，不动手
  --timeout 300       单个单元的超时秒数
  --delay 0.6         每个单元之间停顿的秒数（被限流时加大，例如 2）
  --transport rpc     默认 rpc（约 1.5 秒一个单元，不开浏览器）

提示：刷课只处理视频和文档。测验/讨论需要你自己做，脚本会列出来。
"""


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("command", nargs="?", default=None)
    parser.add_argument("course_id", nargs="?", default=None)
    parser.add_argument("term_id", nargs="?", default=None)
    parser.add_argument("--help", "-h", action="store_true")
    parser.add_argument("--school", default="")
    parser.add_argument("--course", default=None, help="按课程名筛选（auto 用）")
    parser.add_argument("--term", default=None, help="按学期ID筛选（auto 用）")
    parser.add_argument("--unit", default=None, help="只刷这个单元")
    parser.add_argument("--rate", type=float, default=2.0)
    parser.add_argument("--transport", default="rpc", choices=["rpc", "auto", "playwright"])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--delay",
        type=float,
        default=0.6,
        help="每个单元之间停顿的秒数（默认 0.6，减少被限流的概率）",
    )
    parser.add_argument("--timeout", type=float, default=300.0)
    # login options
    parser.add_argument(
        "--browser",
        action="store_true",
        help="登录时改用浏览器通道（能处理验证码/短信，会打开 Chrome 窗口）",
    )
    parser.add_argument(
        "--channel",
        default="phone",
        choices=["phone", "mail"],
        help="登录通道（默认 phone，即手机号；icourse163 不提供邮箱登录）",
    )
    parser.add_argument("--username", "-u", default=None, help="登录账号（手机号），不填则交互式询问")
    args, unknown = parser.parse_known_args()
    if unknown:
        print(f"{WARN} 忽略无法识别的参数：{' '.join(unknown)}")

    if args.help or args.command is None:
        print(USAGE)
        return

    if args.command == "login":
        cmd_login(args)
    elif args.command == "status":
        cmd_status()
    elif args.command == "courses":
        cmd_courses()
    elif args.command == "units":
        if not args.course_id or not args.term_id:
            die("用法：python mooc.py units <课程ID> <学期ID> [--school XDU]")
        if not args.school:
            print(f"{WARN} 没给 --school，可能取不到课件。先用 courses 或 auto 试试。")
        cmd_units(args.course_id, args.term_id, args.school)
    elif args.command == "study":
        if not args.course_id or not args.term_id:
            die("用法：python mooc.py study <课程ID> <学期ID> [--school XDU]")
        cmd_study(args, interactive=False)
    elif args.command == "auto":
        cmd_auto(args)
    else:
        print(f"{BAD} 不认识这个命令：{args.command}\n")
        print(USAGE)
        raise SystemExit(2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已取消。")
        raise SystemExit(130)
