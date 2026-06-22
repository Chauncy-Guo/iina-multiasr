# MultiASR Subtitles for IINA

> 给 IINA 播放器用的字幕插件：把本地纯英文视频的音频抽取出来，送去云端 ASR（语音识别）生成英文字幕，再由 LLM 把英文字幕翻译成目标语言（简体中文 / 繁体 / 日 / 韩 / 法 / 德 / 西 / 俄 / 葡 / 意 / 阿 / 泰 / 越 等），在 IINA 中以双语形式加载。

**已验证的 ASR + 翻译 pipeline**：
- ASR: Xiaomi **MiMo**（`mimo-v2.5` 多模态 `input_audio` 模式）
- Translation: Xiaomi **MiMo**（`mimo-v2.5` chat completions）
- 实测样本：`01. Trailer FCND-w2lV5_S2_2A.mp4`（1 分 41 秒英文 trailer）→ 12 条英文字幕 + 12 条简体中文翻译，10 秒内完成。

---

## 功能特性

- **多 ASR 后端**
  - ? **MiMo (Xiaomi)** — Token Plan Key，多模态 `input_audio` 转录，输出带时间戳的 SRT
  - ? **Doubao Seed ASR 2.0 (ByteDance)** — WebSocket 大模型流式 ASR
- **多翻译后端**
  - ? **MiMo (Xiaomi)** — 与 ASR 共用 API Key
  - ? **DeepSeek** — OpenAI 兼容协议（需自行准备 API）
- **多目标语言** — 13 种语言可选
- **可选手动 / 自动加载**
  - 翻译字幕作为 IINA 第二字幕轨道显示
- **本地 ffmpeg 抽取音频** — 无需联网下载
- **完全云端依赖** — 不下载 / 安装任何本地模型

---

## 安装

### 1. 准备依赖

- [IINA](https://iina.io/) ≥ 1.4.0
- `ffmpeg` 4.0+（`brew install ffmpeg`）
- 至少一个 ASR 后端的 API Key（默认推荐 **MiMo**）

### 2. 准备 API Key

| 后端 | 申请地址 | 备注 |
|---|---|---|
| Xiaomi MiMo | <https://platform.xiaomimimo.com> | 推荐 Token Plan（`tp-` 开头），区域选 `token-plan-cn` |
| ByteDance Doubao | <https://www.volcengine.com/product/asr> | 需要火山引擎账号 + 开通 Seed ASR |
| DeepSeek | <https://platform.deepseek.com> | 仅作翻译时需要 |

### 3. 安装插件

IINA 提供 **3 种安装方式**，按推荐顺序：

#### 方式 1：IINA 内直接安装 GitHub 仓库（推荐 ?）

IINA → **设置 → 插件 → Install from GitHub** → 输入

```
Chauncy-Guo/iina-multiasr
```

→ 点 **Install**。

`ghRepo` + `ghVersion` 字段已配置，IINA 会自动检查更新。

#### 方式 2：安装本地 `.iinaplgz` 包

```bash
git clone https://github.com/Chauncy-Guo/iina-multiasr.git
cd iina-multiasr
./bundle.sh                                # 产出 dist/
iina-plugin pack .                        # 产出 iina-multiasr-0.1.0.iinaplgz
open iina-multiasr-0.1.0.iinaplgz         # 用 IINA 打开
```

> **注意**：`iina-plugin` 不是 npm 包，它是 IINA.app 自带的 CLI，位于
> `/Applications/IINA.app/Contents/MacOS/iina-plugin`。建议加到 PATH：
> ```bash
> export PATH="/Applications/IINA.app/Contents/MacOS:$PATH"
> ```

#### 方式 3：开发模式软链（修改源码即时生效）

```bash
cd /path/to/iina-multiasr
iina-plugin link .     # 创建 symlink → ~/Library/Application Support/com.colliderli.iina/plugins/
```

`dist/` 改动后需重新 `./bundle.sh`，IINA 重启时自动重新加载。

---

## 支持的模型

### ASR

| 模型 | Token Plan 支持 | 表现 | 说明 |
|---|---|---|---|
| `mimo-v2.5` | ? **默认** | ? 已验证 | 多模态 chat，`input_audio` 接收 WAV；SRT 输出在 `reasoning_content` |
| `mimo-v2-omni` | ? | ? 已验证 | 同 v2.5，行为类似 |
| `mimo-v2.5-pro` | ? | — | 拒绝图像输入："No endpoints found that support image input" |
| `mimo-v2.5-asr` | ? | — | Token Plan 不支持专用 `/audio/transcriptions` 端点（需要非 Token Plan 套餐 + 不同请求格式） |
| `mimo-v2-pro` | ? | — | 5xx Internal Server Error |
| `mimo-v2-tts` / `-tts-voiceclone` / `-tts-voicedesign` | — | — | 全部是 **TTS**（语音合成）模型，与 ASR 无关 |

**结论**：Token Plan 套餐下，**只有多模态 chat 模型**（`mimo-v2.5`、`mimo-v2-omni`）能直接做 ASR。
专用 ASR 模型需要单独申请"Token Plan 之外的套餐"或使用火山引擎端点。

**为什么选 `mimo-v2.5` 而不是 `mimo-v2.5-pro`？**
- `mimo-v2.5-pro` 拒绝图像/音频输入（多模态接口不支持它）
- `mimo-v2.5` 是官方推荐的多模态 ASR 模型，Token Plan 全功能可用
- 如果需要更高质量，可以改用 `mimo-v2-omni`（行为类似，但是更新版本）

**为什么不直接用 `mimo-v2.5-asr`？**
- `mimo-v2.5-asr` 的接口是 OpenAI Whisper 兼容的 `/v1/audio/transcriptions` multipart
- 这个端点在 Token Plan 上**返回 404**
- 需要在小米平台开通非 Token Plan 套餐（按量计费）才能用

### 翻译

| 后端 | 默认 | 协议 |
|---|---|---|
| **Xiaomi MiMo** | ? | OpenAI 兼容 chat/completions，`api-key` 鉴权 |
| **DeepSeek** | 可选 | OpenAI 兼容 chat/completions，`Authorization: Bearer` |

---

## 使用方法

1. IINA → **设置 → MultiASR Subtitles**
2. 填入 ASR + （可选）翻译的 API Key
3. 选中"启用翻译"并选择目标语言
4. 用 IINA 打开一个本地英文视频
5. 菜单 **字幕 → 在线搜索字幕 → Cloud ASR + Translate** → 选择模型
6. IINA 会显示 OSD 进度（抽取音频 → ASR → 翻译 → 加载字幕）
7. 英文字幕加载为第一字幕，翻译字幕作为第二字幕（双语显示）

---

## 配置项

所有配置都在 `MultiASR Subtitles` 偏好设置页面里：

| 项 | 默认值 | 说明 |
|---|---|---|
| **ASR Provider** | `MiMo ASR (Xiaomi)` | 二选一：MiMo / Doubao |
| **Translate after ASR** | ? | 是否启用翻译 |
| **Target Language** | `Simplified Chinese` | 13 种目标语言可选 |
| **Auto-load secondary** | ? | 自动把翻译字幕挂为 IINA 第二字幕轨道 |
| `mimo_api_key` | _空_ | Xiaomi MiMo Token Plan Key (`tp-...`) |
| `mimo_endpoint` | `https://token-plan-cn.xiaomimimo.com/v1` | Token Plan 端点 |
| `mimo_asr_model` | `mimo-v2.5` | 多模态模型 |
| `mimo_translation_model` | `mimo-v2.5` | 翻译模型 |
| `doubao_app_id` / `doubao_access_token` | _空_ | 火山引擎凭据 |
| `translator_provider` | `mimo` | 翻译后端 |
| `deepseek_api_key` | _空_ | DeepSeek API Key（备用翻译） |
| `ffmpeg_path` | `/opt/homebrew/bin/ffmpeg` | Apple Silicon 默认路径，Intel 用 `/usr/local/bin/ffmpeg` |
| `request_timeout_sec` | `900` | 长视频转录超时 |

---

## 工作流程

```
┌─────────────┐   ffmpeg   ┌─────────────┐
│  本地视频    │ ─────────? │  16k mono   │
│  (mp4/mkv)  │            │  PCM WAV    │
└─────────────┘            └──────┬──────┘
                                  │ base64
                                  ▼
                          ┌──────────────────┐
                          │ MiMo /chat/      │
                          │ completions +    │
                          │ input_audio      │
                          │ (mimo-v2.5)      │
                          └──────┬───────────┘
                                 │ reasoning_content
                                 │ (含 SRT 块)
                                 ▼
                          ┌──────────────────┐
                          │ extract + parse  │
                          │ + re-number      │
                          └──────┬───────────┘
                                 │  English SRT
                                 ▼
                       (optional translate)
                                 │
                                 ▼
                          ┌──────────────────┐
                          │ MiMo /chat/      │
                          │ completions      │
                          │ (SRT → SRT)      │
                          └──────┬───────────┘
                                 │  Chinese SRT
                                 ▼
                          ┌──────────────────┐
                          │  Write to @tmp/  │
                          │ + return paths   │
                          │  to IINA         │
                          └──────────────────┘
```

### 关键实现细节

#### 1. MiMo 是推理模型 — 答案可能在 `reasoning_content` 里

`mimo-v2.5` 是一个 reasoning model。对于音频转写任务，模型倾向于把 SRT 块"思考"进 `reasoning_content` 字段，而 `content` 字段为空。我们优先读 `content`，为空时回退到从 `reasoning_content` 中按 `1\n00:00:00,000 -->` 头模式抽取 SRT 块。

对于纯文本翻译（`text → text`），模型通常会正常把答案写入 `content`。

#### 2. Token Plan 鉴权

`tp-` 开头的 Key 不走 `Authorization: Bearer`，而是走 `api-key: <key>` 自定义头：

```http
POST https://token-plan-cn.xiaomimimo.com/v1/chat/completions
api-key: tp-cs5wq8wapyp6clw2d56ms89i6ryluxxrineptov458kvvxfb
Content-Type: application/json

{
  "model": "mimo-v2.5",
  "messages": [
    { "role": "system", "content": "...SRT rules..." },
    { "role": "user", "content": [
      { "type": "input_audio", "input_audio": { "data": "<base64>", "format": "wav" } },
      { "type": "text", "text": "Transcribe into SRT" }
    ]}
  ],
  "max_completion_tokens": 8192,
  "temperature": 0
}
```

#### 3. ffmpeg 输出格式

提取的音频必须严格为 **16 kHz / mono / 16-bit PCM WAV**，否则 MiMo / Doubao 都会拒收或转写质量下降。

```bash
ffmpeg -i input.mp4 -ac 1 -ar 16000 -c:a pcm_s16le -f wav out.wav
```

注意：`-sample_fmt s16le` 在某些 ffmpeg 版本上不兼容，统一使用 `-c:a pcm_s16le` 指定编码器。

---

## 项目结构

```
iina-multiasr/
├── Info.json              # IINA 插件元数据
├── pref.html              # 偏好设置 UI
├── bundle.sh              # 构建脚本（parcel + iina-plugin pack）
├── package.json
├── src/
│   ├── index.js           # 入口：注册字幕提供者 + pipeline 编排
│   ├── config.js          # 统一读取 / 校验偏好
│   ├── audio/
│   │   └── extractor.js   # ffmpeg 抽音频
│   ├── subtitle/
│   │   └── srt.js         # SRT 解析 / 生成 / 时间戳格式化
│   ├── protocol/
│   │   └── base64.js      # 二进制安全 base64
│   ├── providers/         # ASR 抽象 + 实现
│   │   ├── base.js
│   │   ├── factory.js
│   │   ├── mimo.js        # ? 已验证
│   │   └── doubao.js
│   ├── translators/       # 翻译抽象 + 实现
│   │   ├── base.js
│   │   ├── factory.js
│   │   ├── mimo.js        # ? 已验证
│   │   └── deepseek.js
│   └── utils/
│       ├── http.js        # fetch 包装 + 重试
│       └── logger.js      # iina.console.log 包装
└── .github/
    └── workflows/
        └── compile.yml    # CI: bundle.sh on push
```

---

## 开发

```bash
npm install
npm run prepare   # 等价于 clean + build + build:html
iina-plugin pack .
```

修改源码后重打包，把新 `.iinaplgz` 拖进 IINA 替换即可。

---

## 已知限制

- **MiMo 转写会被截短 ~2 秒**：模型似乎把音频末尾的静音 / 呼吸当作"已结束"，最后一句常停在半句。`max_completion_tokens` 提高到 16384 也无改善，是模型固有行为。
- **没有时间戳对齐保证**：模型自估时间戳，对长视频可能与画面有 1-2 秒偏差。需要精对齐请用 Doubao Seed ASR 2.0（支持词级时间戳）。
- **没有本地缓存**：每次都重新转写。可在 `index.js` 之后扩展 hash + 缓存层。
- **翻译逐条独立**：未做上下文融合，长句可能被拆碎翻译。

---

## 路线图

- [ ] 缓存层（按 `video_path + mtime` 哈希跳过重复转写）
- [ ] Doubao 词级时间戳精确对齐
- [ ] 上下文融合翻译（一次送多条 SRT 而非逐条）
- [ ] 长视频分片（MiMo 长视频实测 1:41 OK，再长可能需要分片）
- [ ] 字幕样式（字号 / 位置）面板

---

## 致谢

- [whisperina](https://github.com/uahkcc/iina-whisperina) — IINA Whisper 插件，本项目的脚手架参考
- Xiaomi [MiMo](https://platform.xiaomimimo.com) 平台
- ByteDance [Doubao ASR](https://www.volcengine.com/product/asr) 服务

## 许可

MIT
