# 实时听写网页版

> 一个本地运行的实时语音转文字网页：从麦克风接收语音、显示逐句结果，并把文稿保存到你的本机目录。

Contact: **Jacksun** · [qinji@jack-sun.com](mailto:qinji@jack-sun.com)

![实时听写主视觉：麦克风输入、实时文字与本地文稿的概念示意。](docs/assets/hero-system-v1.png)

一个极简网页：点击开始，对着麦克风说话，文字实时出现。

## 模型选择

当前默认使用 `fun-asr-realtime`。

原因很简单：它是阿里云百炼实时语音识别推荐模型之一，比 Paraformer 更适合真实口语、方言、实时字幕场景，价格约 `0.00033 元/秒`，仍然很便宜。

页面底部会按本次实际听写时长实时估算费用。默认单价来自 `ASR_PRICE_PER_SECOND=0.00033`，如果之后换模型，记得同步改这个值。

## 运行

```bash
npm install
npm start
```

打开：

```text
http://localhost:5178
```

本项目会优先读取当前目录 `.env`，同时读取：

```text
/Users/jacksun/.codex/skills/aliyun-isi/.env
```

所以你本地已有的 `BAILIAN_API_KEY` 可以直接复用，不需要把密钥写进前端。

每次停止后，本次识别出的旁白文字会保存到桌面文件夹：

```text
/Users/jacksun/Desktop/实时听写文字
```

## 架构

- 浏览器：采集麦克风，转成 16 kHz、单声道、16-bit PCM。
- Node 后端：接收浏览器音频流，代理连接阿里云 WebSocket。
- 阿里云：返回 `result-generated`，前端实时显示中间结果和最终句子。

## 注意

- 麦克风权限在 `localhost` 下可以直接使用。
- API Key 只在 Node 后端读取，不能放进浏览器代码。
- 所有实时模型都要求单声道输入；当前前端会强制用单声道采集。
