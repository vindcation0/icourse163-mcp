#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mooc.py 编号菜单的桩测试。

这个环境没有真实 TTY，所以用假的 input()/isatty() 驱动菜单，验证：
编号渲染、层级嵌套、返回上一级、非法输入、持久化、优先级，以及 Windows 记事本
写入 BOM 时不至于让设置被静默忽略。

跑法：python tests/mooc_menus_test.py
"""
import argparse
import builtins
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import mooc  # noqa: E402

TMP = Path(tempfile.mkdtemp())
mooc.SETTINGS_PATH = TMP / "settings.json"

failures = []


def check(label, condition, detail=""):
    mark = "OK  " if condition else "FAIL"
    print(f"{mark} {label}" + (f"   {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


def run(scripted, fn, *a, **k):
    """Feed scripted answers to input(); pretend stdin is a TTY. Returns captured output."""
    answers = list(scripted)
    buf = io.StringIO()

    def fake_input(prompt=""):
        buf.write(str(prompt))
        if not answers:
            raise EOFError
        answer = answers.pop(0)
        buf.write(answer + "\n")
        return answer

    real_input = builtins.input
    real_isatty = sys.stdin.isatty
    builtins.input = fake_input
    sys.stdin.isatty = lambda: True
    try:
        with redirect_stdout(buf):
            try:
                fn(*a, **k)
            except SystemExit:
                buf.write("[SystemExit]")
    finally:
        builtins.input = real_input
        sys.stdin.isatty = real_isatty
    return buf.getvalue()


def args(**over):
    base = dict(
        rate=None, delay=None, chunk=None, timeout=None, hide_password=False,
        browser=False, channel="phone", username=None, help=False, command=None,
        course_id=None, term_id=None, school="", course=None, term=None, unit=None,
        transport="rpc", dry_run=False,
    )
    base.update(over)
    return argparse.Namespace(**base)


print("=== 1. 不带参数：主菜单 4 项 + 退出 ===")
out = run(["0"], mooc.first_run_menu, args())
check("列出 1~4 项", all(f"   {i}." in out for i in (1, 2, 3, 4)), out)
check("没有第 5 项", "   5." not in out)
check("有 0 退出", "   0. 退出" in out, out)
check("未登录时提示先登录", "还没登录过" in out or "已保存会话" in out, out)
check("退出有反馈", "再见" in out, out)

print("\n=== 2. 登录后菜单：多出「设置」 ===")
out = run(["0"], mooc.post_login_menu, args())
check("列出 1~4", all(f"   {i}." in out for i in (1, 2, 3, 4)), out)
check("第 4 项是设置", "4. 设置" in out, out)
check("0 是退出", "   0. 退出" in out, out)

print("\n=== 3. 非法输入：提示并重新列出，不退出 ===")
out = run(["9", "abc", "0"], mooc.first_run_menu, args())
check("非法输入有警告", out.count("请输入 1~4") >= 2, out)
check("之后仍能正常退出", "再见" in out, out)

print("\n=== 4. 进入设置 → 视频播放设置 → 改成「分块上报」并落盘 ===")
out = run(["1", "1", "2", "0", "0", "0"], mooc.settings_menu)
check("设置主菜单有 3 组", "1. 视频播放设置" in out and "2. 密码显示设置" in out and "3. 恢复默认值" in out, out)
check("视频子菜单有上报方式/倍速/停顿", "上报方式" in out and "视频倍速" in out and "单元之间停顿" in out, out)
check("有分块选项", "分块上报" in out, out)
check("保存提示", "已保存到" in out, out)
saved = json.loads(mooc.SETTINGS_PATH.read_text(encoding="utf-8"))
check("配置文件写了 chunk=60", saved.get("video", {}).get("chunk") == 60.0, json.dumps(saved))
check("只写改过的项（sparse）", "display" not in saved, json.dumps(saved))

print("\n=== 5. 密码显示设置可切换 ===")
out = run(["2", "1", "0", "0"], mooc.settings_menu)
check("切换后有保存提示", "已保存到" in out, out)
saved = json.loads(mooc.SETTINGS_PATH.read_text(encoding="utf-8"))
check("password_visible=false 落盘", saved.get("display", {}).get("password_visible") is False, json.dumps(saved))
out = run(["2", "1", "0", "0"], mooc.settings_menu)
saved = json.loads(mooc.SETTINGS_PATH.read_text(encoding="utf-8"))
check("再切一次回到默认即被移除", "display" not in saved, json.dumps(saved))

print("\n=== 6. 0 只返回上一级，不退出程序 ===")
out = run(["1", "0", "0"], mooc.settings_menu)
check("进入视频设置再返回到设置主菜单", out.count("设置") > 1, out)
check("没有提前输出退出语", "再见" not in out, out)

print("\n=== 7. 损坏的配置文件不致命 ===")
mooc.SETTINGS_PATH.write_text("{ this is not json", encoding="utf-8")
out = run(["0"], mooc.settings_menu)
check("有警告但继续", "设置文件读不了" in out, out)
check("菜单仍然渲染", "视频播放设置" in out, out)
loaded = mooc.load_settings()
check("回退到默认值", loaded["video"]["chunk"] == 0.0 and loaded["display"]["password_visible"] is True)

print("\n=== 8. 优先级：命令行 > 配置文件 > 默认 ===")
mooc.SETTINGS_PATH.write_text(json.dumps({"video": {"rate": 1.5}}), encoding="utf-8")
a = args(rate=None)
mooc.apply_settings(a)
check("没给命令行时用配置文件（1.5）", a.rate == 1.5, str(a.rate))
a = args(rate=0.75)
mooc.apply_settings(a)
check("命令行覆盖配置文件（0.75）", a.rate == 0.75, str(a.rate))
a = args()
mooc.apply_settings(a)
check("其余项走默认值", a.chunk == 0.0 and a.delay == 0.6 and a.timeout == 300.0)
a = args(hide_password=False)
mooc.apply_settings(a)
check("hide_password 未给 → 按配置文件（当前默认可见）", a.password_visible is True)
a = args(hide_password=True)
mooc.apply_settings(a)
check("--hide-password 覆盖设置", a.password_visible is False)

print("\n=== 9. 非法值被忽略，不炸 ===")
mooc.SETTINGS_PATH.write_text(
    json.dumps({"video": {"rate": "fast", "chunk": None}, "display": {"password_visible": "yes"}}),
    encoding="utf-8",
)
loaded = mooc.load_settings()
check("非数字被忽略", loaded["video"]["rate"] == 2.0, str(loaded["video"]["rate"]))
check("非布尔被忽略", loaded["display"]["password_visible"] is True, str(loaded["display"]["password_visible"]))

print("\n=== 10. 非交互式不提问 ===")
real_isatty = sys.stdin.isatty
sys.stdin.isatty = lambda: False
buf = io.StringIO()
with redirect_stdout(buf):
    mooc.post_login_menu(args())
sys.stdin.isatty = real_isatty
check("打印一行提示而不是提问", "下一步" in buf.getvalue() and "请输入序号" not in buf.getvalue(), buf.getvalue())

print("\n=== 11. 恢复默认值 ===")
mooc.SETTINGS_PATH.write_text(json.dumps({"video": {"chunk": 60}}), encoding="utf-8")
out = run(["3", "1"], mooc.settings_menu)
check("确认后删除文件", not mooc.SETTINGS_PATH.exists(), out)


print("\n=== 12. 带 BOM 的配置文件（Windows 记事本另存为 UTF-8）也要能读 ===")
mooc.SETTINGS_PATH.write_text('{"display":{"password_visible":false}}', encoding="utf-8-sig")
loaded = mooc.load_settings()
check("BOM 不会让设置被静默忽略", loaded["display"]["password_visible"] is False, str(loaded))
bom_args = args()
mooc.apply_settings(bom_args)
check("BOM 配置能影响 password_visible", bom_args.password_visible is False)
mooc.SETTINGS_PATH.unlink()

print()
if failures:
    print(f"!!! {len(failures)} 项失败: {failures}")
    sys.exit(1)
print("ALL CHECKS PASSED")
