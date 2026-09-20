# 模型对比：为什么默认推荐 Hy-MT2-1.8B，为什么不用 MiLMMT

2026-09-20 实测。机器：Apple M5 Pro / 48 GB，LM Studio（llama.cpp Metal 后端与 MLX 后端）。
复现方法见文末。

## 结论

| | qwen3.6-35b-a3b | **hy-mt2-1.8b** | milmmt-46-1b-v1.0 |
| --- | --- | --- | --- |
| 类型 | 通用 MoE 大模型（激活 3B） | 翻译专用（腾讯，2026-05） | 翻译专用（小米，2026-08） |
| 量化 / 文件大小 | MLX 4bit / 20.4 GB | GGUF Q8_0 / 1.91 GB | GGUF Q8_0 / 1.07 GB |
| 常驻内存 | 约 19 GB | 约 2.4 GB | 约 1.2 GB |
| 加载耗时 | 约 15 秒 | 约 1 秒（文件已在系统缓存时；刚下载完的冷启动是 16 秒） | 未单独计时 |
| 15 句耗时 | 3.1 秒 | 0.9 秒 | 0.9 秒 |
| 驱动方式 | 编号批量 + 系统提示词 | 逐句，官方「背景信息」模板，4 路并发 | 逐句，补全式提示词，4 路并发 |
| 能利用上文 / 视频标题 | 能 | 能 | **不能** |
| 习语、短语动词 | 好 | 偶尔直译 | 时对时错 |
| 术语、指代 | 好 | 好 | **经常错** |

- **默认推荐 `hy-mt2-1.8b`**：内存是大模型的约 1/8，速度快 3 倍，术语和句意可靠。代价是习语偶尔直译。
- **追求译文质量用 `qwen3.6-35b-a3b`**：配合「提前翻译 10 分钟」和「闲置后卸载」，压力也比一口气翻完整个视频小得多。
- **不用 MiLMMT-46-1B**：原因见下一节。

## 为什么不用 MiLMMT

[MiLMMT-46](https://huggingface.co/xiaomi-research/MiLMMT-46-1B-v1.0) 比 Hy-MT2 更新、更小，论文（[arXiv 2608.10812](https://arxiv.org/abs/2608.10812)）
也报告了对 Hy-MT2、TranslateGemma、Seed-X 的领先。但在字幕这个场景里它不合适：

1. **没有上下文通道。** 它只在一种补全式提示词上训练过：

   ```text
   Translate this from English to Chinese (Simplified):
   English: <一句原文>
   Chinese (Simplified):
   ```

   没有聊天模板，也没有放背景信息的位置。而字幕是被切碎的口语，单看一句经常无从判断词义：
   编程视频里的 *push*、*branch*，做饭视频里的 *two of these*。Hy-MT2 的官方模板里有「背景信息」栏，
   扩展把视频标题和前两句放进去，这些词就能翻对。

2. **实测的错误正好是这一类，而且是会误导学习者的那种。** 同一句话：

   | 原文 | hy-mt2-1.8b（带上文） | milmmt-46-1b |
   | --- | --- | --- |
   | …clean it up before you **push**. | 在推送之前清理… | 在**推车**前清理它 |
   | …we left off with a pretty messy **branch**. | 相当混乱的分支 | 相当混乱的**枝干** |
   | You just run **rebase** with the interactive flag… | 运行 rebase 命令 | 运行…**重新合并**命令 |
   | **Day-old rice** is the secret here, fresh rice just turns to mush. | 秘诀在于使用隔夜米饭 | 秘诀在于**新鲜的**日粮米（意思反了） |
   | I'm going to crack **two of these** right into the middle. | 把其中两个直接劈成两半 | 把**这两根夹**在中间 |
   | that one kind of blew my mind when i first **learned it** | 第一次了解到这一点时 | 第一次学到**这个词**时 |

   对照学习时，译文不地道还能从英文看出来；译文把意思说反了，学习者是发现不了的。

3. **省下的资源换不回这些错误。** 它比 Hy-MT2-1.8B 少占约 1.2 GB 内存，速度相同（都是 0.9 秒 / 15 句）。
   在一台能跑 35B 模型的机器上，这点差距没有意义。

4. **论文里的领先是"无参考质量评估"分数**，而它的强化学习阶段正是以这类评估器的打分为奖励训练的。
   指标和训练目标同源，不能直接当作实际质量的证据——上面的实测也印证了这一点。

5. **分发渠道。** 官方只发布了 safetensors；LM Studio 能直接用的 GGUF / MLX 都是社区转换的。Hy-MT2 有官方 GGUF，
   Hugging Face 和魔搭都有，国内下载快。

公平地说，MiLMMT 并非一无是处：*If anything blows up* 它译成了「如果情况变得很糟糕」，比 Hy-MT2 的「爆炸了」好。
它的 4B / 12B 版本没有测；但上面第 1 条是格式上的限制，模型再大也没有地方放上文。

## Hy-MT2-1.8B 的短板，以及提示词救不了它

Hy-MT2-1.8B 的问题集中在习语和短语动词：

| 原文 | qwen3.6-35b-a3b | hy-mt2-1.8b |
| --- | --- | --- |
| If anything **blows up**, don't panic… | 如果出了什么问题，别慌 | 如果有什么东西**爆炸了**，不要惊慌 |
| …and we're pretty much **good to go**. | 基本就可以出锅了 | 我们就差不多**可以开始了** |
| …last time we **left off** with a pretty messy branch. | 上次我们停在了… | 上次我们最后得到的是… |
| From there you can squash **these two** into one. | 把这两个**提交**压缩成一个 | 将这两个**部分**合并为一个 |

试过用它官方的四种模板去引导（背景信息、背景信息 + 「习语要意译」的要求、个性化任务列表、风格指定），
每种跑两次，*blows up* 八次全部译成「爆炸了」（下面完整结果那次运行是「炸开了」，同样是直译）。这是 1.8B 模型的能力上限，不是提示词问题，所以扩展保持最简单的「背景信息」模板。

## 完整并排结果

测试句是为本项目编写的三段"视频"，刻意包含口语习语、依赖上一句才能理解的指代，以及没有标点的语音识别文本。
Hy-MT2 按官方建议以 temperature 0.7 采样，措辞每次运行会略有不同；下面是同一次运行的输出（Qwen 一列来自紧邻的另一次运行）。

### Git rebase explained

| # | 原文 | qwen3.6-35b-a3b | hy-mt2-1.8b | milmmt-46-1b |
| --- | --- | --- | --- | --- |
| 1 | Alright, so last time we left off with a pretty messy branch. | 好，上次我们停在了一个相当混乱的分支上。 | 好吧，上次我们最后得到的是一个相当混乱的分支。 | 好了，上次我们说到这里时还剩下了一个相当混乱的枝干。 |
| 2 | Today I'm going to show you how to clean it up before you push. | 今天我要展示一下在推送之前如何清理它。 | 今天我将向你们展示如何在推送之前清理这个问题。 | 今天我就教你如何在推车前清理它。 |
| 3 | It's not as scary as people make it sound. | 它并没有人们说的那么可怕。 | 它并不像人们说的那么可怕。 | 它并不像人们所说的那样可怕。 |
| 4 | You just run rebase with the interactive flag, and it opens up your editor. | 你只需要运行带有交互标志的 rebase，它就会打开你的编辑器。 | 你只需使用交互式标志运行 rebase 命令，编辑器就会打开。 | 只需运行带有交互选项的重新合并命令，编辑器就会打开。 |
| 5 | From there you can squash these two into one. | 从那里你可以把这两个提交压缩成一个。 | 从那里开始，你可以将这两个部分合并为一个。 | 从那里，你可以把这两个问题合并在一起。 |
| 6 | If anything blows up, don't panic, you can always bail out with abort. | 如果出了什么问题，别慌，你随时可以用 abort 退出。 | 如果有什么东西炸开了，不要惊慌，你随时可以用 abort 退出。 | 如果情况变得很糟糕，请不要惊慌；你可以随时使用“中止”功能来撤离。 |

### Weeknight fried rice

| # | 原文 | qwen3.6-35b-a3b | hy-mt2-1.8b | milmmt-46-1b |
| --- | --- | --- | --- | --- |
| 7 | Day-old rice is the secret here, fresh rice just turns to mush. | 隔夜饭是这里的关键，新煮的饭只会变成糊状。 | 这里的秘诀在于使用隔夜米饭，新鲜米饭只会变成糊状。 | 这里秘诀在于新鲜的日粮米，否则就会变成烂泥。 |
| 8 | Get your pan ripping hot before anything goes in. | 在放入任何食材前，先把锅烧到滚烫。 | 在放入任何食材之前，先把锅烧热到非常热的状态。 | 在放入任何东西之前，让你的煎锅变得非常热。 |
| 9 | Push the rice to the side and grab your eggs. | 把饭推到一边，然后准备鸡蛋。 | 把米饭放到一边，然后拿起鸡蛋。 | 把米饭推到一边，然后抓起你的鸡蛋。 |
| 10 | I'm going to crack two of these right into the middle. | 我要把两个鸡蛋直接打入锅中央。 | 我打算把其中两个直接劈成两半。 | 我要把这两根夹在中间。 |
| 11 | Give it a quick toss, and we're pretty much good to go. | 快速翻炒几下，基本就可以出锅了。 | 快速颠一下，我们就差不多可以开始了。 | 试一下，基本上就没问题了。 |

### Why is the sky blue（无标点，模拟语音识别字幕）

| # | 原文 | qwen3.6-35b-a3b | hy-mt2-1.8b | milmmt-46-1b |
| --- | --- | --- | --- | --- |
| 12 | so why does the sky look blue in the first place | 那么，天空为什么一开始看起来是蓝色的呢？ | 那么，为什么天空一开始看起来是蓝色的呢？ | 那么，为什么天空一开始就是蓝色的呢？ |
| 13 | it turns out shorter wavelengths get scattered way more than longer ones | 事实证明，较短波长的光比长波长的光散射得更厉害。 | 原来，较短的波长比较长的波长更容易被散射。 | 事实证明，短波长的光线散射的范围要比长波束更大。 |
| 14 | which is also why sunsets end up looking red | 这也是为什么日落看起来是红色的原因。 | 这也是为什么日落最终看起来是红色的。 | 这也是日落为什么看起来会是红色的原因。 |
| 15 | that one kind of blew my mind when i first learned it | 我第一次了解到这一点时，简直惊呆了。 | 当我第一次了解到这一点时，真是令人惊叹。 | 当我第一次学到这个词时，它给我留下了深刻的印象。 |

第 10 句值得单独说一下：三个模型里只有 Qwen 从上一句推断出 *these* 是鸡蛋、*crack … into the middle* 是"打进锅中央"。
两个小模型都翻错了，Hy-MT2 至少还保留了"两个"和"敲开"的意思。第 12 句的 *in the first place*（"究竟、到底"）三个模型都直译成了"一开始"。

## 其他查过但没有测的模型

| 模型 | 没测的原因 |
| --- | --- |
| Hy-MT2-7B（Q4_K_M 4.6 GB） | 最可能补上习语短板的中间档；每个 token 的计算量比激活 3B 的 Qwen MoE 还大，GPU 负担未必下降。值得之后补测 |
| Hy-MT2-30B-A3B（约 18 GB） | 内存占用与 Qwen 35B 相当，失去了换小模型的意义 |
| MiLMMT-46-4B / 12B | 同样没有上下文通道 |
| TranslateGemma 4B / 12B / 27B（Google，2026-01） | 比 Hy-MT2 早；提示词格式又是另一套，需要单独适配 |
| Cohere North-Small-Translate-1.0（2026-08） | 218B 参数，CC-BY-NC 许可 |
| NiuTrans LMT-60（2025-11）、NVIDIA Riva-Translate-4B-v2（2026-04） | 早于 Hy-MT2，没有看到针对中英的优势 |

## 复现

在 LM Studio 里准备好要比的模型，然后：

```bash
npm run bench -- hy-mt2-1.8b qwen/qwen3.6-35b-a3b
```

脚本按模型名选择驱动方式（`hy-mt` / `hunyuan-mt` → 逐句官方模板；`milmmt` / `gemmax` → 补全式；其余 → 编号批量），
也可以用环境变量 `STRATEGY=mt|completion|chat` 强制指定。计时前会先发一个热身请求，把模型加载的时间排除在外。
