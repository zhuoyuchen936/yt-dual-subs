# YT Dual Subs · 本地双语字幕

> Chrome extension that shows **bilingual (English + Chinese) subtitles on YouTube**, translated on your own
> machine by a local LLM (LM Studio / Ollama). It reads YouTube's caption track instead of doing speech
> recognition, translates whole sentences ahead of the playhead, and adds language-learning tools:
> hover to pause, click a word for an in-context explanation, sentence-by-sentence hotkeys. No API key, nothing leaves your computer.

看 YouTube 时，用**本机的大模型**把英文字幕翻译成中文，中英对照显示在播放器上。
翻译不出本机（LM Studio / Ollama），不需要任何 API key。

## 它怎么工作

```
YouTube 播放器 ──请求字幕──▶ /api/timedtext?…&pot=令牌
      │                              │
      │  inject.js 旁听这次请求，拿到字幕和令牌
      ▼                              ▼
  content.js：分句 → 从播放位置往前成批送翻 → 叠加层显示（英文片段 + 整句中文）
      │
      ▼
  background.js ──▶ http://localhost:1234/v1/chat/completions（LM Studio）
```

- **不做语音识别**：YouTube 几乎所有英文视频都有字幕轨（人工或自动生成）。直接用它，时间轴精准、零延迟；
  而且能**超前翻译**——按实测速度（10 句 ≈ 3 秒）估算，十几分钟的视频开播后一分钟左右就能全部翻完，拖动进度条会优先翻译新位置。
- **按整句翻译**：一句话常被切成几条字幕。逐条翻译时模型会在行间挪动语序，译文就和英文错位了。
  所以英文按短片段跟着语音走，中文按完整句子翻译，并在这句话的所有片段期间保持显示。
- **翻过的视频有缓存**，重看秒开。

## 安装

1. 准备模型和本地服务：
   ```bash
   lms get "https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF@q8_0"
   ```
   ```bash
   lms server start
   ```
   （Hugging Face 慢的话，同一份文件在[魔搭](https://modelscope.cn/models/Tencent-Hunyuan/Hy-MT2-1.8B-GGUF)也有，下载后放到 `~/.lmstudio/models/tencent/Hy-MT2-1.8B-GGUF/`。）
   服务开着就行，不用手动加载模型：扩展第一次请求时 LM Studio 会按需加载（Hy-MT2-1.8B 约 1 秒），闲置后自动卸载。默认地址 `http://localhost:1234/v1`。
2. Chrome 打开 `chrome://extensions` → 右上角开启**开发者模式** → **加载已解压的扩展程序** → 选择本目录 `yt-dual-subs`。
3. 打开（或刷新）一个 YouTube 视频。左上角会出现「翻译中 n/m」，字幕随即显示。

点工具栏图标可以看连接状态、翻译进度和所有设置。

### 模型建议

下表是同一批字幕在 M5 Pro 上的实测：

| 模型 | 占用内存 | 10 句耗时 | 说明 |
| --- | --- | --- | --- |
| [`hy-mt2-1.8b`](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF)（Q8_0，**推荐**） | 约 2.4 GB | 1.2 秒 | 腾讯的翻译专用模型（Apache-2.0）。逐句请求、4 路并发，天然不会错位。译文准确，偶尔不如大模型地道。查词只能给出"在本句中的译法" |
| `qwen/qwen3.6-35b-a3b`（MLX 4bit） | 约 19 GB | 3.8 秒 | 通用 MoE 模型，译文最自然；查词能给音标、词性、用法 |

自动选择的顺序：已经加载在内存里的模型 → 名字像翻译专用模型的（`hy-mt` / `hunyuan-mt`）→ 列表里第一个。也可以在设置里指定。

两类模型的用法不同，扩展按模型名自动切换（也可在「翻译方式」里手动指定）：

- **通用大模型**：一批句子编号后一次翻译，带系统提示词；发送 `reasoning_effort: "none"` 关闭思考模式（否则每批要先"想" 1000+ token）。
- **翻译专用模型**：这类小模型只在少数几种提示词格式上训练过，也没有系统提示词。所以用官方的「背景信息 + 待翻译文本」模板，一次一句，把视频标题和前两句作为背景；采样参数用官方推荐值。

想两头兼顾：翻译用 `hy-mt2-1.8b`，「查词用的模型」选一个通用模型——只有点词时才会把它加载进来，闲置后又会卸载。

### 降低硬件压力

- **提前翻译**（默认 10 分钟）：只翻译播放位置之后的一小段，随播放补充。GPU 绝大部分时间空闲，没看完的视频也不白翻。选「整个视频」则一口气翻完。
- **闲置后卸载模型**（默认 10 分钟）：请求里带 `ttl`，LM Studio 在停止看视频后把内存还给系统。
- 翻过的句子有缓存，重看不再占用模型。
用 Ollama 时把服务地址改成 `http://localhost:11434/v1`，并设置环境变量 `OLLAMA_ORIGINS=chrome-extension://*`。

## 学习功能

| 操作 | 作用 |
| --- | --- |
| 鼠标移到字幕上 | 自动暂停，移开继续 |
| 点击单词 / 划选短语 | 本地模型给出音标、词性、**在本句中的意思**和用法 |
| `A` / `D` | 上一句 / 下一句 |
| `S` | 重听当前句 |
| `Z` | 遮住中文（悬停才显示）——先自己理解，再对答案 |
| `P` | 句末自动暂停，适合跟读 |

自动生成的字幕带逐词时间戳，会高亮正在说的那个词。

## 已知限制

- 视频完全没有字幕轨时无法工作（直播也不支持）。要覆盖这种情况得走「系统音频 → Whisper → 翻译」路线，是另一套东西。
- 为了拿到字幕令牌，扩展会替你打开播放器的 CC（原生字幕被隐藏，由本扩展的字幕取代）。关掉扩展后原生字幕会显示出来，按 `C` 关闭即可。
- YouTube 改版可能让字幕抓取失效。出问题时左上角会提示；先试试手动点一下 CC 按钮。

## 开发

```bash
npm test            # 分句 / 解析的单元测试（样本按 YouTube json3 字幕的真实结构编写）
npm run test:llm    # 用真实的 service worker 代码对本地模型跑一遍翻译和查词
npm run harness     # http://localhost:8800/watch?v=demo0000001 —— 模拟播放器页面，加载未修改的扩展源码
```

| 文件 | 作用 |
| --- | --- |
| `src/inject.js` | 页面主世界。旁听播放器的字幕请求；按指令让播放器切换字幕轨 |
| `src/segment.js` | json3 字幕 → 显示片段（cue）和翻译句组（group） |
| `src/content.js` | 会话生命周期、翻译调度与缓存、叠加层、快捷键、查词弹窗 |
| `src/background.js` | 调本地模型（流式）、模型自动发现 |
| `src/translate-core.js` | 翻译提示词与「编号. 译文」解析 |
| `src/popup.*` | 状态与设置 |

## License

[MIT](LICENSE)。本项目与 YouTube / Google 无关；字幕内容的版权归各视频作者所有，扩展只在你的浏览器本地处理它们。
