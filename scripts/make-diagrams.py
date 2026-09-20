#!/usr/bin/env python3
"""Writes the editable draw.io sources behind the README diagrams (docs/diagrams/*.drawio).

Geometry lives here rather than in hand-edited XML so the three diagrams share one look.
Export afterwards with:  scripts/export-diagrams.sh
"""
from pathlib import Path
from xml.sax.saxutils import quoteattr

OUT = Path(__file__).resolve().parent.parent / "docs" / "diagrams"
FONT = "fontFamily=Helvetica;fontSize=13;"
PALETTE = {
    "blue": ("#dae8fc", "#6c8ebf"),
    "green": ("#d5e8d4", "#82b366"),
    "yellow": ("#fff2cc", "#d6b656"),
    "orange": ("#ffe6cc", "#d79b00"),
    "red": ("#f8cecc", "#b85450"),
    "grey": ("#f5f5f5", "#666666"),
    "purple": ("#e1d5e7", "#9673a6"),
    "white": ("#ffffff", "#999999"),
}


class Diagram:
    def __init__(self, name):
        self.name = name
        self.cells = []
        self.n = 1

    def _id(self, hint):
        self.n += 1
        return f"{hint}-{self.n}"

    def box(self, label, x, y, w, h, color="blue", parent="1", extra="", hint="box"):
        fill, stroke = PALETTE[color]
        cid = self._id(hint)
        style = f"rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor={fill};strokeColor={stroke};{FONT}{extra}"
        self._vertex(cid, label, style, x, y, w, h, parent)
        return cid

    def container(self, label, x, y, w, h, color="grey", hint="group"):
        fill, stroke = PALETTE[color]
        cid = self._id(hint)
        style = (
            f"swimlane;startSize=30;rounded=1;arcSize=6;html=1;fillColor={fill};strokeColor={stroke};"
            f"swimlaneFillColor=#ffffff;fontStyle=1;pointerEvents=0;{FONT}"
        )
        self._vertex(cid, label, style, x, y, w, h, "1")
        return cid

    def cylinder(self, label, x, y, w, h, color="green", parent="1"):
        fill, stroke = PALETTE[color]
        cid = self._id("store")
        style = f"shape=cylinder3;boundedLbl=1;size=10;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};{FONT}"
        self._vertex(cid, label, style, x, y, w, h, parent)
        return cid

    def text(self, label, x, y, w, h, extra="", parent="1"):
        cid = self._id("text")
        style = f"text;html=1;whiteSpace=wrap;align=center;verticalAlign=middle;strokeColor=none;fillColor=none;{FONT}{extra}"
        self._vertex(cid, label, style, x, y, w, h, parent)
        return cid

    def shape(self, style, x, y, w, h, label="", parent="1"):
        cid = self._id("shape")
        self._vertex(cid, label, style + FONT, x, y, w, h, parent)
        return cid

    def _vertex(self, cid, label, style, x, y, w, h, parent):
        self.cells.append(
            f'<mxCell id="{cid}" value={quoteattr(label)} style="{style}" vertex="1" parent="{parent}">'
            f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>'
        )

    def edge(self, src, dst, label="", exit=None, entry=None, extra="", points=None, both=False):
        cid = self._id("edge")
        style = "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;strokeColor=#555555;strokeWidth=1.5;labelBackgroundColor=#ffffff;" + FONT
        if both:
            style += "startArrow=classic;startFill=1;"
        if exit:
            style += f"exitX={exit[0]};exitY={exit[1]};exitDx=0;exitDy=0;"
        if entry:
            style += f"entryX={entry[0]};entryY={entry[1]};entryDx=0;entryDy=0;"
        style += extra
        pts = ""
        if points:
            pts = '<Array as="points">' + "".join(f'<mxPoint x="{px}" y="{py}"/>' for px, py in points) + "</Array>"
        self.cells.append(
            f'<mxCell id="{cid}" value={quoteattr(label)} style="{style}" edge="1" parent="1" source="{src}" target="{dst}">'
            f'<mxGeometry relative="1" as="geometry">{pts}</mxGeometry></mxCell>'
        )
        return cid

    def write(self):
        body = "\n        ".join(self.cells)
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<mxfile host="drawio" version="26.0.0">\n'
            f'  <diagram name="{self.name}">\n'
            '    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" page="0" math="0" shadow="0">\n'
            '      <root>\n        <mxCell id="0"/>\n        <mxCell id="1" parent="0"/>\n        '
            + body
            + "\n      </root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n"
        )
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f"{self.name}.drawio").write_text(xml, encoding="utf-8")


def how_it_works():
    d = Diagram("how-it-works")
    server = d.box("YouTube 服务器<br><font color='#666666'>/api/timedtext</font>", 60, 20, 180, 60, "grey", hint="youtube")

    page = d.container("YouTube 页面（浏览器标签页）", 40, 210, 440, 430, "blue", hint="page")
    player = d.box("<b>播放器</b>", 20, 60, 160, 60, "white", parent=page, hint="player")
    inject = d.box("<b>inject.js</b><br>旁听字幕请求", 260, 60, 160, 60, "blue", parent=page, hint="inject")
    content = d.box("<b>content.js</b><br>分句 · 调度 · 渲染", 260, 190, 160, 70, "blue", parent=page, hint="content")
    overlay = d.box("<b>双语字幕</b><br>英文片段 + 整句中文", 20, 190, 160, 70, "yellow", parent=page, hint="overlay")
    cache = d.cylinder("译文缓存<br>重看秒开", 260, 340, 160, 70, "green", parent=page)

    worker = d.container("扩展后台", 640, 210, 220, 430, "purple", hint="worker")
    bg = d.box("<b>background.js</b><br>逐句 / 批量翻译<br>点词查释义", 30, 180, 160, 90, "purple", parent=worker, hint="background")

    local = d.container("你的电脑（不出本机）", 1020, 210, 240, 430, "green", hint="local")
    lms = d.box("<b>LM Studio</b><br>localhost:1234", 30, 190, 180, 70, "green", parent=local, hint="lmstudio")
    model = d.box("<b>本地模型</b><br>hy-mt2-1.8b / 7b<br>或 qwen3.6-35b-a3b", 30, 340, 180, 70, "orange", parent=local, hint="model")

    d.edge(player, server, "① 请求字幕<br>（自带 pot 令牌）", exit=(0.5, 0), entry=(0.5, 1))
    d.edge(player, inject, "② 旁听", exit=(1, 0.5), entry=(0, 0.5))
    d.edge(inject, content, "③ 字幕 + 令牌", exit=(0.5, 1), entry=(0.5, 0))
    d.edge(content, bg, "④ 播放位置之后<br>10 分钟的句子 ⇄ 译文", exit=(1, 0.5), entry=(0, 0.5), both=True)
    d.edge(bg, lms, "⑤ 仅 localhost", exit=(1, 0.5), entry=(0, 0.5), both=True)
    d.edge(lms, model, "按需加载 · 推理", exit=(0.5, 1), entry=(0.5, 0), both=True)
    d.edge(content, overlay, "⑥ 渲染", exit=(0, 0.5), entry=(1, 0.5))
    d.edge(content, cache, "", exit=(0.5, 1), entry=(0.5, 0), both=True)
    d.write()


def sentence_groups():
    d = Diagram("sentence-groups")
    en = [
        "The small corrections your<br>hands make when you",
        "ride slowly are very different<br>from the ones",
        "you make when you<br>ride fast.",
    ]
    xs = [170, 450, 730]
    w, gap_h = 260, 56

    # time axis
    d.text("<b>时间 →</b>", 40, 40, 110, 30, "align=left;")
    for k, x in enumerate(xs):
        d.text(f"字幕片段 {k + 1}", x, 40, w, 30, "fontColor=#666666;")

    # shared English row
    d.text("<b>英文</b><br><font color='#666666'>跟着语音逐段显示</font>", 20, 80, 140, gap_h, "align=left;")
    for k, x in enumerate(xs):
        d.box(en[k], x, 80, w, gap_h, "white", hint=f"en{k + 1}")

    # per-cue translation: drifts
    d.text("<b>逐条翻译</b>（示意）<br><font color='#b85450'>中文语序不同 → 错位</font>", 20, 190, 140, gap_h, "align=left;")
    bad = ["当你", "慢骑时，手上的细微修正与", "快骑时的完全不同。"]
    for k, x in enumerate(xs):
        d.box(bad[k], x, 190, w, gap_h, "red", hint=f"bad{k + 1}")
    d.text("✗ 屏幕上是 “The small corrections…”，<br>中文却只有“当你”", xs[0], 250, w, 44, "fontColor=#b85450;fontSize=12;")

    # sentence translation: one box spanning all three
    d.text("<b>按整句翻译</b><br><font color='#4f7f3a'>本项目的做法</font>", 20, 340, 140, gap_h, "align=left;")
    d.box("慢骑时你手上的细微修正，和快骑时的完全不同。", xs[0], 340, xs[2] + w - xs[0], gap_h, "green", hint="good")
    d.text("✓ 一句只翻译一次，在它的三个片段期间一直显示", xs[0], 400, xs[2] + w - xs[0], 30, "fontColor=#4f7f3a;fontSize=12;")
    d.write()


def lookahead():
    d = Diagram("lookahead")
    x0, width, h = 170, 820, 36

    def bar(y, label, segments, playhead, note):
        d.text(label, 20, y - 4, 140, h + 8, "align=left;")
        x = x0
        for frac, color, text in segments:
            w = round(width * frac / 10) * 10
            fill, stroke = PALETTE[color]
            d.shape(f"rounded=0;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};", x, y, w, h, text)
            x += w
        px = x0 + round(width * playhead / 10) * 10
        d.shape("shape=triangle;direction=south;whiteSpace=wrap;html=1;fillColor=#333333;strokeColor=none;", px - 8, y - 16, 16, 12)
        d.text("播放位置", px - 40, y - 40, 80, 22, "fontSize=12;fontColor=#333333;")
        d.text(note, x0, y + h + 6, width, 24, "align=left;fontSize=12;fontColor=#666666;")

    d.text("<b>一段 60 分钟的视频</b>", x0, 10, width, 26, "align=left;")
    bar(90, "<b>正常播放</b>",
        [(0.2, "green", "已翻译（有缓存）"), (0.17, "blue", "提前翻译 10 分钟"), (0.63, "grey", "暂不翻译")],
        0.2, "窗口随播放向前滚动：GPU 只在补充新句子时忙一下，没看完的部分不白翻。")
    bar(220, "<b>拖到 40 分钟</b>",
        [(0.2, "green", "已翻译"), (0.47, "grey", "跳过，不翻译"), (0.17, "blue", "从新位置接着翻"), (0.16, "grey", "")],
        0.67, "拖动后窗口立刻跟到新位置；拖回去时，跳过的部分才会被翻译。")

    idle = d.box("停止观看 10 分钟", x0, 330, 180, 50, "white", hint="idle")
    unload = d.box("模型自动卸载，内存还给系统", x0 + 300, 330, 240, 50, "orange", hint="unload")
    reload_ = d.box("再看视频时自动按需加载", x0 + 600, 330, 220, 50, "green", hint="reload")
    d.edge(idle, unload)
    d.edge(unload, reload_)
    d.write()


def overlay():
    """What the viewer sees. The translation and the word gloss are real hy-mt2-1.8b output."""
    d = Diagram("overlay")
    dark = "rounded=1;arcSize=3;whiteSpace=wrap;html=1;fillColor=#1f2937;strokeColor=#111827;"
    d.shape(dark, 220, 20, 800, 450)
    d.shape("rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#0b0f17;strokeColor=none;fontColor=#d1d5db;fontSize=11;", 236, 34, 110, 24, "翻译中 42/150")
    d.shape("rounded=0;html=1;fillColor=#4b5563;strokeColor=none;", 240, 446, 760, 4)
    d.shape("rounded=0;html=1;fillColor=#ef4444;strokeColor=none;", 240, 446, 250, 4)

    sub = d.shape(
        "rounded=1;arcSize=10;whiteSpace=wrap;html=1;fillColor=#0b0b0b;strokeColor=none;opacity=85;fontSize=15;spacing=10;",
        300, 320, 640, 100,
        "<font color='#ffffff'>And I want you to pause for a second and notice how strange it is<br>that staying balanced feels so </font>"
        "<font color='#8fd6ff'><b><u>effortless</u></b></font><font color='#ffffff'>.</font><br>"
        "<font color='#ffe2a0' style='font-size:14px'>我希望你能暂停一下，注意一下保持平衡竟然如此轻松这一事实有多奇怪。</font>",
    )
    pop = d.shape(
        "shape=callout;whiteSpace=wrap;html=1;perimeter=calloutPerimeter;position=0.4;position2=0.5;base=16;size=14;"
        "rounded=1;arcSize=12;fillColor=#18181b;strokeColor=#52525b;align=left;spacingLeft=10;spacingTop=2;fontSize=13;",
        610, 236, 210, 84,
        "<font color='#8fd6ff'><b>effortless</b></font><br><font color='#e5e7eb'>在本句中：毫不费力</font>",
    )

    note = "text;html=1;whiteSpace=wrap;align=left;verticalAlign=middle;strokeColor=none;fillColor=none;"
    a = d.shape(note, 0, 300, 190, 50, "<b>英文</b>跟着语音逐段显示<br><font color='#666666'>自动字幕会高亮正在说的词</font>")
    b = d.shape(note, 0, 380, 190, 50, "<b>中文</b>是整句的翻译<br><font color='#666666'>按 Z 遮住，先自己理解</font>")
    c = d.shape(note, 1050, 236, 200, 50, "<b>点单词 / 划选短语</b><br><font color='#666666'>本地模型给出它在本句的意思</font>")
    e = d.shape(note, 1050, 350, 200, 50, "<b>鼠标移到字幕上</b><br><font color='#666666'>自动暂停，移开继续</font>")
    line = "edgeStyle=none;endArrow=oval;endFill=1;endSize=5;strokeColor=#888888;"
    d.edge(a, sub, exit=(1, 0.5), entry=(0, 0.3), extra=line)
    d.edge(b, sub, exit=(1, 0.5), entry=(0, 0.8), extra=line)
    d.edge(c, pop, exit=(0, 0.5), entry=(1, 0.3), extra=line)
    d.edge(e, sub, exit=(0, 0.5), entry=(1, 0.5), extra=line)

    keys = [("A", "上一句"), ("S", "重听这句"), ("D", "下一句"), ("Z", "遮住中文"), ("P", "句末自动暂停")]
    x = 300
    for key, what in keys:
        d.shape("rounded=1;arcSize=20;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#999999;fontStyle=1;", x, 490, 28, 28, key)
        d.shape(note, x + 34, 490, 100, 28, what)
        x += 132
    d.write()


if __name__ == "__main__":
    overlay()
    how_it_works()
    sentence_groups()
    lookahead()
    print("wrote", ", ".join(sorted(p.name for p in OUT.glob("*.drawio"))))
