#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 mooc.py 打包成双击即用的 exe。

为什么要把 node.exe 和 node_modules 一起塞进去：刷课/登录的全部逻辑都在 Node 侧
（签名 RPC、URS 纯 HTTP 登录）。要让用户"不装 Node 也能用"，就必须把这些带上。
代价是体积（node.exe 约 87MB + 依赖约 40MB）。

策略选择（试过又放弃的）：先试过用 esbuild 把 Node 侧打成单文件再打包，但
`@napi-rs/keyring` 是原生 `.node` 模块、`playwright-core` 又依赖一个没装的可选包
`chromium-bidi`，两者都无法静态打包。为了让 exe 的行为与已验证的源码版本**完全一致**，
这里选择原样带上 node_modules，而不是去改 Node 代码把一个已经验证过的路径改坏。

产出 `dist/mooc/mooc.exe`（onedir）。不用 onefile 是因为 onefile 每次启动都要把
~130MB 解压到临时目录，冷启动要好几秒；onedir 是一打开就进菜单。

跑法：python scripts/build-exe.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
STAGE = REPO / "packaging" / "stage"
DIST = REPO / "dist"

# 运行期用不到：typescript 只给 tsc 用，@types 只给编辑器用。tsx 走 esbuild，不需要它们。
PRUNE = {"typescript", "@types"}

SKIP_TOP = {".git", "dist", "build", "packaging", "node_modules", "tests", "__pycache__"}


def log(message: str) -> None:
    print(f"  {message}", flush=True)


def fresh(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)


def copy_runtime_deps() -> None:
    """把 node_modules 复制到 stage，跳过纯开发用的包。"""
    src = REPO / "node_modules"
    if not src.is_dir():
        sys.exit("找不到 node_modules，先在本仓库跑一次 npm ci")
    dst = STAGE / "node_modules"
    dst.mkdir(parents=True, exist_ok=True)
    copied = skipped = 0
    for entry in src.iterdir():
        if entry.name in PRUNE:
            skipped += 1
            continue
        target = dst / entry.name
        if entry.is_dir():
            shutil.copytree(entry, target, symlinks=True, dirs_exist_ok=True)
        else:
            shutil.copy2(entry, target)
        copied += 1
    log(f"node_modules: 复制 {copied} 项，跳过 {skipped} 项（{', '.join(sorted(PRUNE))}）")


def copy_sources() -> None:
    for name in ("src", "scripts"):
        src = REPO / name
        if src.is_dir():
            shutil.copytree(src, STAGE / name, symlinks=True, dirs_exist_ok=True)
    for name in ("package.json", "tsconfig.json"):
        src = REPO / name
        if src.is_file():
            shutil.copy2(src, STAGE / name)
    log("src / package.json / tsconfig.json 已复制")


def copy_node() -> None:
    node = shutil.which("node") or shutil.which("node.exe")
    if node is None:
        sys.exit("找不到 node.exe，无法自带运行时")
    dst = STAGE / "node"
    dst.mkdir(parents=True, exist_ok=True)
    shutil.copy2(node, dst / "node.exe")
    size = (dst / "node.exe").stat().st_size / 1024 / 1024
    log(f"自带 node.exe: {size:.1f} MB（来源 {node}）")


def run_pyinstaller() -> None:
    add_data = f"{STAGE}{';' if sys.platform == 'win32' else ':'}."
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        "mooc",
        "--console",
        f"--add-data={add_data}",
        "--distpath",
        str(DIST),
        "--workpath",
        str(REPO / "packaging" / "pyi-work"),
        "--specpath",
        str(REPO / "packaging"),
        "--exclude-module",
        "tkinter",
        "--exclude-module",
        "unittest",
        str(REPO / "mooc.py"),
    ]
    log("运行 PyInstaller（要几分钟）…")
    result = subprocess.run(command, cwd=str(REPO))
    if result.returncode != 0:
        sys.exit(f"PyInstaller 失败，退出码 {result.returncode}")


def main() -> None:
    print("打包 mooc.exe\n")
    fresh(STAGE)
    fresh(DIST / "mooc")
    STAGE.mkdir(parents=True, exist_ok=True)

    copy_node()
    copy_sources()
    copy_runtime_deps()
    run_pyinstaller()

    exe = DIST / "mooc" / ("mooc.exe" if sys.platform == "win32" else "mooc")
    if not exe.exists():
        sys.exit(f"没找到产出：{exe}")
    total = sum(f.stat().st_size for f in (DIST / "mooc").rglob("*") if f.is_file())
    print(f"\n完成：{exe}")
    print(f"整个目录 {total / 1024 / 1024:.0f} MB —— 发出去要连**整个 mooc 目录**一起给")
    print("用户双击 mooc.exe 即可。")


if __name__ == "__main__":
    main()
