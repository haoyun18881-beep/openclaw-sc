#!/usr/bin/env python3
"""
杉杉CPU · 丝滑动画悬浮窗 (340×420)
数据源: http://127.0.0.1:18790/health
零依赖，仅 Python 标准库
"""

import tkinter as tk
import ctypes
import json
import urllib.request
import threading
import os
import platform

# MCP 端口：优先从环境变量读取，否则默认 18790
MCP_HOST = os.environ.get("MCP_HOST", "127.0.0.1")
MCP_PORT = os.environ.get("MCP_PORT", "18790")
HEALTH_URL = f"http://{MCP_HOST}:{MCP_PORT}/health"
REFRESH_MS = 3000  # 3秒刷新，避免1秒一次太频繁

# 连接状态
_connection_ok = True

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except:
        pass

class LobsterSmoothAnimationUI:
    def __init__(self):
        self.root = tk.Tk()
        self.width = 340
        self.collapsed_height = 42
        self.expanded_height = 420
        self.current_height = self.collapsed_height
        self.is_expanding = False
        self.animation_timer = None
        self.data = {}

        # 窗口初始位置：屏幕居中偏右上（根据不同分辨率自适应）
        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()
        init_x = min(screen_w - self.width - 20, screen_w - 380)
        init_y = 20
        self.root.geometry(f"{self.width}x{self.collapsed_height}+{init_x}+{init_y}")
        self.root.overrideredirect(True)
        self.root.config(bg='#020202')
        self.root.attributes("-transparentcolor", "#020202")
        self.root.attributes("-topmost", True)

        self.canvas = tk.Canvas(self.root, bg="#020202", bd=0, highlightthickness=0)
        self.canvas.place(x=0, y=0, width=self.width, height=self.expanded_height)

        self.main_container = tk.Frame(self.root, bg="#12131A", bd=0)
        self.main_container.place(x=1, y=1, width=self.width-2, height=self.expanded_height-2)
        self.refresh_bg(self.collapsed_height)
        self.setup_widgets()

        self.main_container.bind("<Enter>", self.on_mouse_enter)
        self.main_container.bind("<Leave>", self.on_mouse_leave)
        self.main_container.bind("<Button-1>", self.start_drag)
        self.main_container.bind("<B1-Motion>", self.drag)
        self.root.bind("<Escape>", lambda e: self.root.destroy())

    def refresh_bg(self, current_height):
        self.canvas.delete("all")
        radius = 14
        x1, y1, x2, y2 = 0, 0, self.width, current_height
        pts = [x1+radius,y1, x2-radius,y1, x2,y1, x2,y1+radius, x2,y2-radius, x2,y2, x2-radius,y2, x1+radius,y2, x1,y2, x1,y2-radius, x1,y1+radius, x1,y1]
        self.canvas.create_polygon(pts, fill="#12131A", outline="#2A2B36", width=1, smooth=True)

    def animate_size(self, target_height):
        if self.animation_timer:
            self.root.after_cancel(self.animation_timer)
        diff = target_height - self.current_height
        if abs(diff) > 2:
            step = int(diff * 0.35)
            if step == 0: step = 1 if diff > 0 else -1
            self.current_height += step
            x, y = self.root.winfo_x(), self.root.winfo_y()
            self.root.geometry(f"{self.width}x{self.current_height}+{x}+{y}")
            self.refresh_bg(self.current_height)
            self.animation_timer = self.root.after(10, lambda: self.animate_size(target_height))
        else:
            self.current_height = target_height
            x, y = self.root.winfo_x(), self.root.winfo_y()
            self.root.geometry(f"{self.width}x{self.current_height}+{x}+{y}")
            self.refresh_bg(self.current_height)
            if target_height == self.expanded_height:
                self.content_frame.pack(fill="both", expand=True, padx=12, pady=(0,10))

    def on_mouse_enter(self, event):
        self.is_expanding = True
        self.animate_size(self.expanded_height)

    def on_mouse_leave(self, event):
        x, y = self.root.winfo_pointerxy()
        wx, wy = self.root.winfo_x(), self.root.winfo_y()
        if not (wx <= x <= wx + self.width and wy <= y <= wy + self.expanded_height):
            self.is_expanding = False
            self.content_frame.pack_forget()
            self.animate_size(self.collapsed_height)

    def setup_widgets(self):
        self.top_bar = tk.Frame(self.main_container, bg="#12131A")
        self.top_bar.pack(fill="x", padx=14, pady=(10,4))
        self.top_bar.bind("<Button-1>", self.start_drag)
        self.top_bar.bind("<B1-Motion>", self.drag)

        title = tk.Label(self.top_bar, text="杉杉CPU · 📊 仪表盘",
                         bg="#12131A", fg="#A0A5B5",
                         font=("Microsoft YaHei", 9, "bold"))
        title.pack(side="left")
        title.bind("<Button-1>", self.start_drag)
        title.bind("<B1-Motion>", self.drag)

        top_tip = tk.Label(self.top_bar, text="[自动展开]",
                           bg="#12131A", fg="#707585",
                           font=("Microsoft YaHei", 8))
        top_tip.pack(side="right")

        self.content_frame = tk.Frame(self.main_container, bg="#12131A")

        # B. 核心卡片
        core = tk.Frame(self.content_frame, bg="#12131A")
        core.pack(fill="x", pady=6)

        f_eff = tk.Frame(core, bg="#1A1B24", width=150, height=68)
        f_eff.pack_propagate(False)
        f_eff.pack(side="left", expand=True, padx=(0,4))
        tk.Label(f_eff, text="N 效率因子", bg="#1A1B24", fg="#707585",
                 font=("Microsoft YaHei", 8)).pack(anchor="w", padx=10, pady=(6,0))
        self.lbl_eff = tk.Label(f_eff, text="0.00", bg="#1A1B24", fg="#FFB84D",
                                font=("Arial", 16, "bold"))
        self.lbl_eff.pack(anchor="w", padx=10)

        f_meta = tk.Frame(core, bg="#1A1B24", width=150, height=68)
        f_meta.pack_propagate(False)
        f_meta.pack(side="right", expand=True, padx=(4,0))
        tk.Label(f_meta, text="H 代谢率", bg="#1A1B24", fg="#707585",
                 font=("Microsoft YaHei", 8)).pack(anchor="w", padx=10, pady=(6,0))
        self.lbl_meta = tk.Label(f_meta, text="0 /s", bg="#1A1B24", fg="#FFFFFF",
                                 font=("Arial", 16, "bold"))
        self.lbl_meta.pack(anchor="w", padx=10)

        # C. Worker
        f_worker = tk.Frame(self.content_frame, bg="#1A1B24", height=72)
        f_worker.pack_propagate(False)
        f_worker.pack(fill="x", pady=6)
        tk.Label(f_worker, text="WORKER 池 & 队列", bg="#1A1B24", fg="#707585",
                 font=("Microsoft YaHei", 8)).pack(anchor="w", padx=12, pady=(6,0))
        self.lbl_worker_stat = tk.Label(f_worker, text="0 / 12", bg="#1A1B24", fg="#00FF66",
                                        font=("Arial", 14, "bold"))
        self.lbl_worker_stat.pack(side="left", padx=12, pady=(0,4))
        self.lbl_queue_detail = tk.Label(f_worker, text="等待: 0 | 高: 0 | 普: 0",
                                         bg="#1A1B24", fg="#A0A5B5",
                                         font=("Microsoft YaHei", 8))
        self.lbl_queue_detail.pack(side="right", padx=12, pady=(0,4))

        # D. 内存
        f_mem = tk.Frame(self.content_frame, bg="#1A1B24")
        f_mem.pack(fill="x", pady=6)
        self.lbl_mem_title = tk.Label(f_mem, text="内存水位 (状态: 充足)",
                                      bg="#1A1B24", fg="#707585",
                                      font=("Microsoft YaHei", 8))
        self.lbl_mem_title.pack(anchor="w", padx=12, pady=(8,2))
        self.lbl_mem_val = tk.Label(f_mem, text="-- GB", bg="#1A1B24", fg="#00FF66",
                                    font=("Arial", 18, "bold"))
        self.lbl_mem_val.pack(anchor="w", padx=12)
        self.lbl_mem_detail = tk.Label(f_mem, text="已使用 --% | 总计 -- GB",
                                       bg="#1A1B24", fg="#505565",
                                       font=("Microsoft YaHei", 8))
        self.lbl_mem_detail.pack(anchor="w", padx=12, pady=(2,10))

        # E. 底部
        self.lbl_status = tk.Label(self.content_frame,
                                   text="🤖 子 AGENT：0 活跃 / 0 总计",
                                   bg="#12131A", fg="#00FF66",
                                   font=("Microsoft YaHei", 8, "bold"))
        self.lbl_status.pack(side="bottom", pady=(10,2))

        # 连接状态指示（显示在 status 下方）
        self.lbl_conn = tk.Label(self.content_frame,
                                 text="", bg="#12131A", fg="#FF5555",
                                 font=("Microsoft YaHei", 7))
        self.lbl_conn.pack(side="bottom", pady=(0,4))

        # 数据更新
        self._tick()

    def _tick(self):
        threading.Thread(target=self._fetch, daemon=True).start()
        self.root.after(REFRESH_MS, self._tick)

    def _fetch(self):
        global _connection_ok
        try:
            req = urllib.request.Request(HEALTH_URL, headers={"User-Agent":"SmoothDash"})
            with urllib.request.urlopen(req, timeout=3) as r:
                self.data = json.loads(r.read().decode())
            _connection_ok = True
        except Exception as e:
            self.data = {}
            _connection_ok = False
            self._last_error = str(e)
        self.root.after(0, self._upd)

    def _upd(self):
        d, p = self.data, self.data.get("pool", {})
        total, busy = p.get("total", 0), p.get("busy", 0)
        nu = busy / max(total, 1)
        self.lbl_eff.config(text=f"{nu:.2f}")
        eta = busy + p.get("inFlight", 0)
        self.lbl_meta.config(text=f"{eta} /s")
        self.lbl_worker_stat.config(text=f"{busy} / {p.get('maxWorkers',12)}")
        qd, qh, qn = p.get("queueDepth",0), p.get("queueHigh",0), p.get("queueNormal",0)
        self.lbl_queue_detail.config(text=f"等待: {qd} | 高: {qh} | 普: {qn}")
        mem = d.get("memory", {})
        free_gb = mem.get("freeGB", "--")
        used_pct = mem.get("usedPct", "--")
        total_gb = mem.get("totalGB", "--")
        level = mem.get("level", "green")
        label = mem.get("label", "充足")
        self.lbl_mem_title.config(text=f"内存水位 (状态: {label})")
        mem_c = "#FF5555" if level in ("red","meltdown") else "#FFB84D" if level=="yellow" else "#00FF66"
        self.lbl_mem_val.config(text=f"{free_gb} GB", fg=mem_c)
        self.lbl_mem_detail.config(text=f"已使用 {used_pct}% | 总计 {total_gb} GB")
        active = d.get("userActive")
        if active is True:
            self.lbl_status.config(text="🟢 用户：在线", fg="#00FF66")
        elif active is False:
            self.lbl_status.config(text="🔴 用户：离线", fg="#FF5555")

        # 连接状态
        if not _connection_ok:
            self.lbl_conn.config(text=f"⚠ MCP 连接失败 ({MCP_HOST}:{MCP_PORT})", fg="#FF5555")
        else:
            self.lbl_conn.config(text="")

    def start_drag(self, event):
        self.x, self.y = event.x, event.y

    def drag(self, event):
        x = self.root.winfo_x() + event.x - self.x
        y = self.root.winfo_y() + event.y - self.y
        # 防拖出屏幕外（保留最小可见区域）
        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()
        x = max(-self.width + 40, min(x, screen_w - 40))
        y = max(0, min(y, screen_h - 40))
        self.root.geometry(f"+{x}+{y}")

    def run(self):
        self.root.mainloop()

if __name__ == "__main__":
    app = LobsterSmoothAnimationUI()
    app.run()
