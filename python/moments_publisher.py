# -*- coding: utf-8 -*-
"""
moments_publisher.py — 朋友圈发布侧车（由 DSH 插件按需拉起）
模式：
  --inspect            只读探测：枚举微信主窗口 UIA 树（绝不点击），用于适配控件结构
  --dry-run --text T   演练发布流程：每一步只验证"能找到控件"，不真点
  --publish --text T   真实发布（阶段2联调后才启用）
约定：本脚本永远是插件 spawn 的短命子进程；所有输出走 print（JSON 行）。
"""
import sys
import json
import time
import argparse

import uiautomation as uia

WECHAT_PROCESS = "Weixin.exe"  # 微信 4.x 主进程


def find_wechat_window():
    """找微信主窗口（按进程名+类名启发式）"""
    for _ in range(3):
        win = uia.WindowControl(searchDepth=1, Name="微信")
        if win.Exists(3, 1):
            return win
        win = uia.WindowControl(searchDepth=1, ClassName="mmui::MainWindow")
        if win.Exists(3, 1):
            return win
        time.sleep(1)
    # 兜底：遍历所有顶层窗口找 Weixin 进程的
    desktop = uia.GetRootControl()
    for w in desktop.GetChildren():
        try:
            if w.ClassName and "mmui" in str(w.ClassName):
                return w
        except Exception:
            continue
    return None


def dump_tree(ctrl, depth=0, max_depth=6, max_children=30, out=None):
    if out is None:
        out = []
    if depth > max_depth or ctrl is None:
        return out
    try:
        out.append({
            "depth": depth,
            "type": ctrl.ControlTypeName,
            "name": (ctrl.Name or "")[:40],
            "class": str(ctrl.ClassName or "")[:40],
            "autoId": str(ctrl.AutomationId or "")[:40],
        })
    except Exception as e:
        out.append({"depth": depth, "error": str(e)[:60]})
        return out
    try:
        kids = ctrl.GetChildren()
    except Exception:
        return out
    for i, k in enumerate(kids):
        if i >= max_children:
            out.append({"depth": depth + 1, "truncated": True})
            break
        dump_tree(k, depth + 1, max_depth, max_children, out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inspect", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--publish", action="store_true")
    ap.add_argument("--text", default="")
    ap.add_argument("--images", nargs="*", default=[])
    args = ap.parse_args()

    result = {"mode": "inspect" if args.inspect else ("dry-run" if args.dry_run else ("publish" if args.publish else "?")), "ok": False}

    win = find_wechat_window()
    if win is None:
        result["error"] = "未找到微信主窗口（微信未登录或未运行？）"
        print(json.dumps(result, ensure_ascii=False))
        return
    result["window"] = {"name": win.Name, "class": win.ClassName}

    if args.inspect:
        result["tree"] = dump_tree(win, max_depth=5, max_children=20)
        result["ok"] = True

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
