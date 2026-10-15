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
    --hide-password    输入密码时不回显（默认可见）
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

def _resource_root() -> Path:
    """资源根目录。

    源码运行时就是脚本所在目录；用 PyInstaller 打包成 exe 后，`__file__` 指向
    临时解包目录，真正的资源在 `sys._MEIPASS` 下。
    """
    bundled = getattr(sys, "_MEIPASS", None)
    if bundled:
        return Path(bundled)
    return Path(__file__).resolve().parent


REPO = _resource_root()
SERVER_ENTRY = REPO / "src" / "stdio.ts"
LOGIN_ENTRY = REPO / "src" / "login-cli.ts"
LOGIN_HTTP_ENTRY = REPO / "src" / "urs-login-cli.ts"
# 打包时会带上自己的 node.exe，这样用户不需要装 Node
BUNDLED_NODE = REPO / "node" / "node.exe"


def is_frozen() -> bool:
    """是否运行在 PyInstaller 打出来的 exe 里。"""
    return bool(getattr(sys, "frozen", False))


def self_cmd() -> str:
    """当前程序的调用方式：源码里是 `python mooc.py`，exe 里就是它自己的文件名。"""
    if is_frozen():
        return Path(sys.executable).name
    return "python mooc.py"


def owns_console() -> bool:
    """控制台是不是本进程独占的。

    双击 exe 时 Windows 会为它新建一个控制台（只有它一个进程）；从已经打开的终端里
    运行则不是。用来决定"结束前要不要等用户按回车"，否则双击后窗口一闪就没了、
    用户根本看不到结果。
    """
    if sys.platform != "win32":
        return False
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        buffer = (ctypes.c_uint * 8)()
        count = kernel32.GetConsoleProcessList(buffer, 8)
        return count == 1
    except Exception:
        return False


_builtin_print = print


def print(*args, **kwargs):  # noqa: A001 - 有意遮蔽内置 print
    """统一的输出入口，只做一件事：

    把消息里的 `python mooc.py` 换成当前实际的调用方式。打包成 exe 之后，再让用户
    "去跑 python mooc.py xxx"就是错的了 —— 用户手里只有 mooc.exe，没有仓库。
    用遮蔽内置 print 的方式做，是因为这种提示散布在几十处，逐个改又容易漏。
    """
    if is_frozen():
        args = tuple(
            arg.replace("python mooc.py", self_cmd()) if isinstance(arg, str) else arg
            for arg in args
        )
    _builtin_print(*args, **kwargs)

OK = "✅"
BAD = "❌"
SKIP = "⏭️ "
WARN = "⚠️ "

# 这些类型 study_unit 处理不了，需要人来做（答题之类）
MANUAL_TYPES = {"quiz", "other"}


def find_node() -> str:
    """优先用随包自带的 node.exe，其次用系统装的。"""
    if BUNDLED_NODE.exists():
        return str(BUNDLED_NODE)
    node = shutil.which("node") or shutil.which("node.exe")
    if node is None:
        die(
            "找不到 node。请先安装 Node.js 18 以上版本：https://nodejs.org/\n"
            "   装完关掉这个窗口重新打开一次。\n"
            "   （如果你用的是打包好的 exe，说明解包不完整，请重新解压一份完整的。）"
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
    chunk: float,
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
                "report_chunk_sec": chunk,
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
            chunks = out.get("report_chunks")
            if isinstance(chunks, int) and chunks > 1:
                detail += f"，{chunks} 段上报"
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


# --------------------------------------------------------------------------- #
# 设置
#
# 三层优先级：命令行参数 > 配置文件 > 内置默认值。
# 命令行只在**显式给了**的时候才覆盖（所以这些选项的 argparse 默认值是 None），
# 这样"设置里存了倍速 2、偶尔想跑一次 1 倍速"这种用法才成立。
# 配置文件只写**与默认值不同**的项，所以以后改默认值能对老用户生效。
# --------------------------------------------------------------------------- #

SETTINGS_PATH = Path.home() / ".config" / "icourse163-mcp" / "settings.json"

VIDEO_DEFAULTS: dict[str, float] = {"chunk": 0.0, "rate": 2.0, "delay": 0.6}
DISPLAY_DEFAULTS: dict[str, bool] = {"password_visible": True}
ADVANCED_DEFAULTS: dict[str, float] = {"timeout": 300.0}

GROUPS = {
    "video": VIDEO_DEFAULTS,
    "display": DISPLAY_DEFAULTS,
    "advanced": ADVANCED_DEFAULTS,
}


def default_settings() -> dict:
    return {group: dict(values) for group, values in GROUPS.items()}


def _coerce(default: object, value: object) -> object | None:
    """只接受与默认值同类型的值，其余一律忽略（手改配置文件不该炸）。"""
    if isinstance(default, bool):
        return value if isinstance(value, bool) else None
    if isinstance(default, float):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return float(value)
    return None


def load_settings() -> dict:
    """读配置；文件缺失或损坏都不致命（损坏时警告并使用默认值）。"""
    settings = default_settings()
    if not SETTINGS_PATH.exists():
        return settings
    try:
        # utf-8-sig：Windows 记事本另存为 UTF-8 会写 BOM，用 utf-8 读会让 json 解析失败，
        # 用户的设置就被静默忽略了。这里容错掉。
        raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        print(f"{WARN} 设置文件读不了，本次用默认值：{SETTINGS_PATH}")
        print(f"   （{exc}）")
        return settings
    if not isinstance(raw, dict):
        print(f"{WARN} 设置文件格式不对，本次用默认值：{SETTINGS_PATH}")
        return settings
    for group, defaults in GROUPS.items():
        stored = raw.get(group)
        if not isinstance(stored, dict):
            continue
        for key, default in defaults.items():
            if key not in stored:
                continue
            coerced = _coerce(default, stored[key])
            if coerced is not None:
                settings[group][key] = coerced
    return settings


def write_settings(settings: dict) -> None:
    """只写改过的项，保留 sparse 结构。"""
    out: dict[str, dict] = {}
    for group, defaults in GROUPS.items():
        changed = {
            key: settings[group][key]
            for key, default in defaults.items()
            if settings[group].get(key) != default
        }
        if changed:
            out[group] = changed
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def update_settings(group: str, values: dict) -> None:
    settings = load_settings()
    settings[group].update(values)
    write_settings(settings)
    print(f"{OK} 已保存到 {SETTINGS_PATH}")


def apply_settings(args: argparse.Namespace) -> None:
    """把配置填进 args，让下游代码无需改动；命令行显式给了的优先。"""
    settings = load_settings()
    if args.rate is None:
        args.rate = settings["video"]["rate"]
    if args.delay is None:
        args.delay = settings["video"]["delay"]
    if args.chunk is None:
        args.chunk = settings["video"]["chunk"]
    if args.timeout is None:
        args.timeout = settings["advanced"]["timeout"]
    # --hide-password 只表示"这次要隐藏"，所以它优先于设置里的值
    args.password_visible = (
        False if args.hide_password else settings["display"]["password_visible"]
    )


# --------------------------------------------------------------------------- #
# 编号菜单（登录后、设置里都用同一套交互）
# --------------------------------------------------------------------------- #


def ask_choice(
    title: str,
    options: list[str],
    *,
    extra: str = "",
    default: int | None = None,
    back_label: str = "返回",
) -> int | None:
    """列出编号选项并读取选择。

    返回选项下标（0 起）；None 表示"返回上一级"（选了 0、直接回车且没有默认项，
    或读到 EOF）。非法输入会提示并重新列出，不会退出。
    """
    while True:
        print(f"\n{title}")
        if extra:
            print(extra)
        for index, label in enumerate(options, start=1):
            print(f"   {index}. {label}")
        print(f"   0. {back_label}")
        hint = "请输入序号"
        if default is not None:
            hint += f"（直接回车={default + 1}）"
        try:
            raw = input(f"\n{hint}：").strip()
        except EOFError:
            print()
            return None
        if raw == "":
            return default
        if raw == "0":
            return None
        if raw.isdigit():
            picked = int(raw)
            if 1 <= picked <= len(options):
                return picked - 1
        print(f"{WARN} 请输入 1~{len(options)}，或 0 返回。")


def ask_number(prompt: str, current: float, low: float, high: float) -> float | None:
    """读一个数值；回车保持原值，非数字或越界会提示重来，EOF 返回 None。"""
    while True:
        try:
            raw = input(f"   {prompt}（{low}~{high}，当前 {current}，回车保持不变）：").strip()
        except EOFError:
            print()
            return None
        if raw == "":
            return None
        try:
            value = float(raw)
        except ValueError:
            print(f"{WARN} 请输入 {low}~{high} 之间的数字。")
            continue
        if not low <= value <= high:
            print(f"{WARN} 超出范围，请输入 {low}~{high} 之间的数字。")
            continue
        return value


def settings_video_menu() -> None:
    while True:
        video = load_settings()["video"]
        mode = (
            f"分块上报（每 {video['chunk']:.0f} 秒一段）"
            if video["chunk"] > 0
            else "一次报满"
        )
        picked = ask_choice(
            "—— 视频播放设置 ——",
            [
                f"上报方式        {mode}",
                f"视频倍速        {video['rate']}",
                f"单元之间停顿    {video['delay']} 秒",
            ],
            extra="   上报方式决定服务端看到的是「一跳 0→100」还是「逐段推进」。",
        )
        if picked is None:
            return
        if picked == 0:
            settings_report_mode_menu()
        elif picked == 1:
            value = ask_number("视频倍速", video["rate"], 0.5, 2.0)
            if value is not None:
                update_settings("video", {"rate": value})
        elif picked == 2:
            value = ask_number("单元之间停顿秒数", video["delay"], 0.0, 10.0)
            if value is not None:
                update_settings("video", {"delay": value})


def settings_report_mode_menu() -> None:
    picked = ask_choice(
        "上报方式 —— 选一种",
        [
            "一次报满        约 1.5 秒/单元    服务端日志里是一跳 0→100",
            "分块上报        每 60 秒一段      服务端看到逐段推进，但真实耗时约 时长÷倍速",
        ],
        extra="   注意：分块上报的耗时是它存在的意义，不是缺点。",
    )
    if picked is None:
        return
    update_settings("video", {"chunk": 0.0 if picked == 0 else 60.0})


def settings_display_menu() -> None:
    while True:
        visible = load_settings()["display"]["password_visible"]
        picked = ask_choice(
            "—— 密码显示设置 ——",
            [f"输入密码时可见    {'是' if visible else '否'}"],
            extra=(
                "   可见：含特殊字符或输入法时不容易打错，但会留在终端回滚区/录屏里。\n"
                "   隐藏：更安全，但盲打容易出错。"
            ),
        )
        if picked is None:
            return
        update_settings("display", {"password_visible": not visible})


def settings_menu() -> None:
    while True:
        settings = load_settings()
        video = settings["video"]
        visible = settings["display"]["password_visible"]
        mode = f"分块 {video['chunk']:.0f}s" if video["chunk"] > 0 else "一次报满"
        picked = ask_choice(
            "设置",
            [
                f"视频播放设置    上报={mode}，倍速={video['rate']}",
                f"密码显示设置    输入密码时{'可见' if visible else '不显示'}",
                "恢复默认值",
            ],
            extra=f"   配置文件：{SETTINGS_PATH}",
        )
        if picked is None:
            return
        if picked == 0:
            settings_video_menu()
        elif picked == 1:
            settings_display_menu()
        elif picked == 2:
            confirm = ask_choice("确定恢复默认值吗？", ["确定，删除配置文件"], back_label="取消")
            if confirm == 0:
                try:
                    SETTINGS_PATH.unlink()
                    print(f"{OK} 已恢复默认值（配置文件已删除）")
                except FileNotFoundError:
                    print("   本来就是默认值。")
                except OSError as exc:
                    print(f"{BAD} 删不掉：{exc}")


SESSION_PATH = Path.home() / ".config" / "icourse163-mcp" / "session"


def main_actions(args: argparse.Namespace) -> list[tuple[str, object]]:
    """两个菜单共用的动作列表，免得两处各写一份、日后漂移。

    带「重新登录」是必须的：双击 exe 的用户没法加命令行参数，会话失效后如果菜单里
    没有这一项，他就只能干看着了。
    """
    return [
        ("开始刷课（挑一门课，把没学完的刷完）", lambda: cmd_auto(args)),
        ("查看状态（登录还有效吗）", cmd_status),
        ("列出我的课程", cmd_courses),
        ("设置（视频播放 / 密码显示）", settings_menu),
        ("重新登录（换账号，或登录失效时用）", lambda: cmd_login(args)),
    ]


def run_menu(args: argparse.Namespace, footer: str = "") -> None:
    actions = main_actions(args)
    while True:
        picked = ask_choice(
            "要做什么？",
            [label for label, _ in actions],
            extra=footer,
            back_label="退出",
        )
        if picked is None:
            print("   再见。")
            return
        print()
        try:
            actions[picked][1]()  # type: ignore[operator]
        except SystemExit:
            # 子命令的退出码语义只作用于它自己，菜单继续。
            pass


def first_run_menu(args: argparse.Namespace) -> None:
    """不带参数运行（例如双击 exe）时的入口。

    **本机还没有会话时直接进登录，不摆菜单** —— 第一次用除了登录没别的能做，
    摆出选项只是让人多点一次。登录成功后 cmd_login 会接着给出编号菜单。
    """
    if not SESSION_PATH.exists():
        print("🎓 中国大学MOOC 一键刷课")
        print("\n   第一次用，先登录。登录一次以后就不用再输了。\n")
        cmd_login(args)
        return

    print("🎓 中国大学MOOC 一键刷课\n")
    print("   本机已保存会话。要是提示失效，选 2 看一眼、选 5 重新登录。")
    run_menu(args)


def post_login_menu(args: argparse.Namespace) -> None:
    """登录成功后的编号菜单。

    非交互式环境（管道、重定向）不提问，只打印提示后返回，避免 EOFError 崩掉脚本。
    """
    if not sys.stdin.isatty():
        print("   下一步：python mooc.py auto（刷课）或 python mooc.py status（体检）")
        return
    run_menu(args)


def cmd_login(args: argparse.Namespace) -> None:
    """登录。

    默认走纯 HTTP 通道：约 4 秒，不打开浏览器。它复现了 URS 组件的请求（SM4 信封、
    工作量证明、RSA 密码），实测可用。失败时**不自动弹浏览器** —— 只告诉你怎么切换。

    --browser 走 Playwright 通道，能处理验证码/短信，但会打开 Chrome 窗口。
    """
    # 来自"设置"或 --hide-password；用正向命名，免得满屏双重否定
    hidden = not args.password_visible
    if args.browser:
        if not LOGIN_ENTRY.exists():
            die(f"找不到 {LOGIN_ENTRY}。请把本脚本放在 icourse163-mcp 仓库根目录下运行。")
        print("即将打开浏览器登录中国大学MOOC（可处理验证码/短信）。")
        if hidden:
            print("按提示输入账号，然后输入密码（密码不显示，也不会被保存）。\n")
        else:
            print("按提示输入账号，然后输入密码。")
            print("（密码会显示出来；要隐藏请输入：python mooc.py login --hide-password）\n")
        browser_command = [find_node(), "--import", "tsx", str(LOGIN_ENTRY)]
        if hidden:
            browser_command.append("--hide-password")
        completed = subprocess.call(browser_command, cwd=str(REPO))
        print()
        if completed == 0:
            print(f"{OK} 登录成功，会话已保存在本机。")
            post_login_menu(args)
        else:
            print(f"{BAD} 浏览器登录没成功（退出码 {completed}）。")
            print("   若站点要求短信/扫码验证，可以用浏览器插件复制 cookie 后：")
            print("   python mooc.py login --browser 并参考 docs/login.md 的 --cookie-file 一节。")
        return

    if not LOGIN_HTTP_ENTRY.exists():
        die(f"找不到 {LOGIN_HTTP_ENTRY}。请把本脚本放在 icourse163-mcp 仓库根目录下运行。")
    print("用纯 HTTP 登录中国大学MOOC —— 不打开浏览器，约 4 秒。")
    print(f"（账号通道：{args.channel}）")
    if hidden:
        print("（密码不显示）")
    else:
        print("（密码会显示出来；想隐藏就改设置：python mooc.py settings）")
    print()
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
    if hidden:
        command.append("--hide-password")
    completed = subprocess.call(command, cwd=str(REPO))
    print()
    if completed == 0:
        print(f"{OK} 登录成功，会话已保存在本机。")
        post_login_menu(args)
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
    browser = bool(status.get("web_session_markers"))
    print(f"\n状态：{'✅ 可用' if usable else '❌ 不可用'}")
    print(f"  本机已保存会话：{'是' if status.get('stored') else '否'}")
    print(f"  API 令牌（NTESSTUDYSI）：{'有' if markers.get('ntesstudysi') else '无'}")
    print(f"  网页会话（STUDY_SESS）：{'有' if markers.get('study_sess') else '无'}")
    print(f"  课程数量：{status.get('course_count', 0)}")
    # 这两个字段只表示 cookie 标记是否存在，不代表浏览器路径真的能用（实测过两者都在
    # 却仍被弹去登出的情况），所以不要写成"可用"。
    print(f"  浏览器路径标记齐全：{'是' if browser else '否'}（标记存在 ≠ 一定可用）")
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
            chunk=args.chunk,
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
            chunk=args.chunk,
        )


USAGE = """\
中国大学MOOC 一键刷课 —— 登录和刷课都不需要浏览器

  python mooc.py login            第一次用，先登录（输账号密码，密码不显示；约 4 秒）
                                  ← 登录成功后会列出编号菜单，输入序号即可继续
  python mooc.py auto             最省事：挑一门课，把没学完的视频/文档刷完
  python mooc.py status           看看登录还有效吗
  python mooc.py courses          列出所有课程，拿到 course_id / term_id
  python mooc.py units <课程ID> <学期ID> [--school XDU]
  python mooc.py study <课程ID> <学期ID> [--school XDU] [--unit 单元ID] [--dry-run]
  python mooc.py settings         编号菜单里改设置（视频播放 / 密码显示）
  python mooc.py settings reset   恢复默认值

不带任何参数运行（双击 exe 也是）会直接给出编号菜单。

login 还能加：
  --browser           改用浏览器登录（能处理验证码/短信，会打开 Chrome 窗口）
  --hide-password     输入密码时不回显（默认可见；可见输入会留在终端回滚区/录屏里）
  --channel phone     登录通道（默认 phone；icourse163 不提供邮箱登录）
  -u <手机号>         直接指定账号，不填则交互式询问

study / auto 还能加：
  --rate 2            视频倍速（0.5~2）
  --chunk 60          分块上报：每 60 秒发一次（0=关闭）
                      默认是"一次报满"，服务端日志里是一跳 0→100；
                      开了它服务端看到的是逐段推进，但真实耗时约 时长/倍速
  --dry-run           只看看要刷什么，不动手
  --timeout 300       单个单元的超时秒数
  --delay 0.6         每个单元之间停顿的秒数（被限流时加大，例如 2）
  --transport rpc     默认 rpc（约 1.5 秒一个单元，不开浏览器）

上面这些不填就走"设置"里保存的值；命令行明确写了就覆盖这一次。

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
    # 这些默认值是 None，好让"命令行明确给了"与"没给、走设置文件"区分开
    parser.add_argument("--rate", type=float, default=None, help="视频倍速（0.5~2）")
    parser.add_argument(
        "--chunk",
        type=float,
        default=None,
        help=(
            "分块上报：每 N 秒发一次签名上报（0=关闭）。"
            "开启后服务端看到的是逐段推进，而不是一次 0→100 跳变；"
            "代价是真实耗时约 时长/倍速"
        ),
    )
    parser.add_argument("--transport", default="rpc", choices=["rpc", "auto", "playwright"])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--delay",
        type=float,
        default=None,
        help="每个单元之间停顿的秒数（减少被限流的概率）",
    )
    parser.add_argument("--timeout", type=float, default=None)
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
    parser.add_argument(
        "--hide-password",
        action="store_true",
        help="输入密码时不回显（默认可见；可见输入会留在终端回滚区/录屏里）",
    )
    args, unknown = parser.parse_known_args()
    if unknown:
        print(f"{WARN} 忽略无法识别的参数：{' '.join(unknown)}")

    if args.help:
        print(USAGE)
        return

    # 必须在任何分支之前解析设置：双击路径（command is None）也会用到 password_visible
    apply_settings(args)

    # 双击 exe / 不带参数运行时给菜单，而不是甩一屏帮助 —— 这才是"打开即用"
    if args.command is None:
        if sys.stdin.isatty():
            first_run_menu(args)
        else:
            print(USAGE)
        return

    if args.command == "login":
        cmd_login(args)
    elif args.command == "status":
        cmd_status()
    elif args.command == "courses":
        cmd_courses()
    elif args.command == "settings":
        if args.course_id == "reset":
            try:
                SETTINGS_PATH.unlink()
                print(f"{OK} 已恢复默认值（配置文件已删除）")
            except FileNotFoundError:
                print("本来就是默认值，无需恢复。")
            except OSError as exc:
                die(f"删不掉设置文件：{exc}")
        else:
            settings_menu()
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
    exit_code = 0
    try:
        main()
    except KeyboardInterrupt:
        print("\n已取消。")
        exit_code = 130
    except SystemExit as exc:
        exit_code = exc.code if isinstance(exc.code, int) else 1
    except Exception as exc:  # 兜底：双击用户看不到 traceback 就白屏了
        print(f"\n{BAD} 出错了：{type(exc).__name__}: {exc}")
        print("   把上面这几行发给开发者即可。")
        exit_code = 1
    # 双击启动的窗口是本进程独占的：程序一结束窗口就关，用户看不到结果。
    # 从已有终端运行时不要停，否则每次都要多按一次回车。
    if owns_console():
        try:
            input("\n按回车键关闭窗口…")
        except (EOFError, KeyboardInterrupt):
            pass
    raise SystemExit(exit_code)
