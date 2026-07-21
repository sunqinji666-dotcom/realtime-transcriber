const transcriptEl = document.querySelector("#transcript");
const statusEl = document.querySelector("#status");
const hintEl = document.querySelector("#hint");
const toggleButton = document.querySelector("#toggleButton");
const clearButton = document.querySelector("#clearButton");
const modelNameEl = document.querySelector("#modelName");
const unitPriceEl = document.querySelector("#unitPrice");
const elapsedTimeEl = document.querySelector("#elapsedTime");
const estimatedCostEl = document.querySelector("#estimatedCost");
const totalCostEl = document.querySelector("#totalCost");
const resetTotalButton = document.querySelector("#resetTotalButton");
const visualizerEl = document.querySelector("#visualizer");

const totalStorageKey = "jack-realtime-transcriber-total-ms";
const visualizerBars = Array.from({ length: 36 }, () => {
  const bar = document.createElement("span");
  bar.style.setProperty("--level", "14%");
  bar.style.setProperty("--i", String(visualizerEl.children.length));
  visualizerEl.appendChild(bar);
  return bar;
});
transcriptEl.replaceChildren();
const transcriptSlots = Array.from({ length: 4 }, (_, index) => {
  const slot = document.createElement("span");
  slot.className = `line line-${index}${index === 0 ? " placeholder" : ""}`;
  slot.textContent = index === 0 ? "点击开始，然后直接说话。" : "";
  slot.style.setProperty("--line-font", index === 0 ? "44px" : "50px");
  transcriptEl.appendChild(slot);
  return slot;
});

let socket = null;
let audioContext = null;
let mediaStream = null;
let workletNode = null;
let analyser = null;
let analyserData = null;
let visualizerFrame = 0;
let isRecording = false;
let isReady = false;
let finalText = "";
let interimText = "";
let sessionText = "";
let displayLines = [];
let sessionId = "";
let lastSavedSessionId = "";
let pricePerSecond = 0.00033;
let activeStartedAt = 0;
let accumulatedMs = 0;
let totalMs = Number(localStorage.getItem(totalStorageKey) || 0);
let meterTimer = null;
let transcriptDir = "";
let renderQueued = false;

const formatDuration = (milliseconds) => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};

const currentBillableMs = () => {
  if (!activeStartedAt) return accumulatedMs;
  return accumulatedMs + (Date.now() - activeStartedAt);
};

const currentTotalMs = () => {
  if (!activeStartedAt) return totalMs;
  return totalMs + (Date.now() - activeStartedAt);
};

const renderMeter = () => {
  const milliseconds = currentBillableMs();
  const seconds = milliseconds / 1000;
  const totalSeconds = currentTotalMs() / 1000;
  elapsedTimeEl.textContent = formatDuration(milliseconds);
  estimatedCostEl.textContent = `约 ${(seconds * pricePerSecond).toFixed(4)} 元`;
  totalCostEl.textContent = `约 ${(totalSeconds * pricePerSecond).toFixed(4)} 元`;
};

const currentSessionText = () => {
  const confirmed = sessionText.trim();
  const current = interimText.trim();
  if (confirmed && current && !confirmed.endsWith(current)) {
    return `${confirmed}\n${current}`.trim();
  }
  return (confirmed || current).trim();
};

const saveSessionTranscript = async () => {
  const text = currentSessionText();
  if (!text || !sessionId || lastSavedSessionId === sessionId) return;

  const durationMs = currentBillableMs();
  const estimatedCost = (durationMs / 1000) * pricePerSecond;
  setHint("正在保存本次识别文字。");

  const response = await fetch("/api/save-transcript", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      text,
      durationMs,
      estimatedCost,
      model: modelNameEl.textContent,
    }),
  });

  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.message || "保存失败。");
  }

  lastSavedSessionId = sessionId;
  setHint(`已保存本次文字：${result.file}`);
};

const startMeter = () => {
  activeStartedAt = Date.now();
  clearInterval(meterTimer);
  meterTimer = setInterval(renderMeter, 500);
  renderMeter();
};

const pauseMeter = () => {
  if (activeStartedAt) {
    const segmentMs = Date.now() - activeStartedAt;
    accumulatedMs += segmentMs;
    totalMs += segmentMs;
    localStorage.setItem(totalStorageKey, String(Math.round(totalMs)));
    activeStartedAt = 0;
  }
  clearInterval(meterTimer);
  meterTimer = null;
  renderMeter();
};

const setStatus = (text, live = false) => {
  statusEl.textContent = text;
  statusEl.classList.toggle("live", live);
};

const setHint = (text) => {
  hintEl.textContent = text;
};

const microphoneErrorMessage = (error) => {
  if (error?.name === "NotAllowedError" || /permission denied/i.test(error?.message || "")) {
    return "麦克风权限被拒绝了。请在浏览器地址栏左侧允许麦克风，然后刷新页面再点开始。";
  }
  if (error?.name === "NotFoundError") {
    return "没有找到可用麦克风。请检查系统输入设备。";
  }
  if (error?.name === "NotReadableError") {
    return "麦克风正在被其他软件占用。请关闭占用麦克风的软件后重试。";
  }
  return error?.message || "启动失败，请检查麦克风权限。";
};

const subtitleFontSize = (text) => {
  const length = [...String(text || "").trim()].length;
  if (length <= 8) return "78px";
  if (length <= 16) return "72px";
  if (length <= 28) return "64px";
  if (length <= 42) return "56px";
  return "50px";
};

const renderNow = () => {
  renderQueued = false;
  const visibleLines = [...displayLines.slice(-3)];
  if (interimText) visibleLines.push(interimText);

  if (!visibleLines.length) {
    transcriptSlots.forEach((slot, index) => {
      slot.className = `line line-${index}${index === 0 ? " placeholder" : ""}`;
      slot.textContent = index === 0 && !isRecording ? "点击开始，然后直接说话。" : "";
      slot.style.setProperty("--line-font", index === 0 ? "44px" : "50px");
    });
    return;
  }

  const lines = visibleLines.slice(-4).reverse();
  transcriptSlots.forEach((slot, index) => {
    const text = lines[index] || "";
    slot.className = `line line-${index}${index === 0 && interimText && text === interimText ? " interim" : ""}`;
    slot.style.setProperty("--line-font", subtitleFontSize(text));
    if (slot.textContent !== text) slot.textContent = text;
  });
};

const render = () => {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(renderNow);
};

const clearTranscriptStage = () => {
  transcriptSlots.forEach((slot, index) => {
    slot.className = `line line-${index}`;
    slot.textContent = "";
  });
};

const stopAudio = async () => {
  cancelAnimationFrame(visualizerFrame);
  visualizerFrame = 0;
  analyser = null;
  analyserData = null;
  visualizerEl.classList.remove("listening");
  visualizerEl.classList.remove("armed");
  visualizerBars.forEach((bar) => {
    bar.style.setProperty("--level", "14%");
    bar.style.setProperty("--opacity", "0.38");
  });
  workletNode?.disconnect();
  workletNode = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
};

const stop = async () => {
  const shouldSave = Boolean(currentSessionText()) && lastSavedSessionId !== sessionId;
  isRecording = false;
  isReady = false;
  toggleButton.textContent = "开始";
  toggleButton.classList.remove("recording");
  socket?.send(JSON.stringify({ type: "stop" }));
  socket?.close();
  socket = null;
  await stopAudio();
  pauseMeter();
  setStatus("已停止");
  if (shouldSave) {
    try {
      await saveSessionTranscript();
    } catch (error) {
      console.error(error);
      setHint(error?.message || "本次文字保存失败。");
    }
  } else {
    setHint("已停止。本次没有新的识别文字需要保存。");
  }
};

const startAudio = async () => {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule("/pcm-worklet.js");

  const source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.72;
  analyserData = new Uint8Array(analyser.frequencyBinCount);
  source.connect(analyser);
  await audioContext.audioWorklet.addModule("/pcm-worklet.js");

  workletNode = new AudioWorkletNode(audioContext, "pcm-worklet", {
    processorOptions: { targetSampleRate: 16000 },
  });

  workletNode.port.onmessage = (event) => {
    if (socket?.readyState === WebSocket.OPEN && isReady) {
      socket.send(event.data);
    }
  };

  source.connect(workletNode);
  workletNode.connect(audioContext.destination);
  visualizerEl.classList.add("listening");
  visualizerEl.classList.remove("armed");
  drawVisualizer();
};

const drawVisualizer = () => {
  if (!analyser || !analyserData) return;

  analyser.getByteFrequencyData(analyserData);
  const slice = Math.max(1, Math.floor(analyserData.length / visualizerBars.length));

  visualizerBars.forEach((bar, index) => {
    const start = index * slice;
    const values = analyserData.slice(start, start + slice);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const normalized = Math.min(1, average / 150);
    const centerBoost = 1 - Math.abs(index - visualizerBars.length / 2) / (visualizerBars.length / 2);
    const level = 8 + normalized * 74 + centerBoost * normalized * 16;
    bar.style.setProperty("--level", `${level}%`);
    bar.style.setProperty("--opacity", String(0.28 + normalized * 0.62));
  });

  visualizerFrame = requestAnimationFrame(drawVisualizer);
};

const start = async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("浏览器不支持麦克风");
    setHint("当前浏览器没有暴露麦克风接口，可以换 Chrome 或检查浏览器权限。");
    return;
  }

  isRecording = true;
  isReady = false;
  sessionText = "";
  displayLines = [];
  sessionId = crypto.randomUUID();
  toggleButton.textContent = "停止";
  toggleButton.classList.add("recording");
  visualizerEl.classList.add("armed");
  setStatus("打开麦克风");
  setHint("如果弹出麦克风权限，请点允许。");
  renderNow();

  await startAudio();
  setStatus("连接中");
  setHint("麦克风已经打开，正在连接阿里云实时识别。");

  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/asr`);

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "start" }));
  });

  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "upstream-open") {
      setStatus("启动中");
      setHint("阿里云连接已建立，正在启动识别任务。");
      return;
    }

    if (message.type === "ready") {
      isReady = true;
      setStatus("正在听", true);
      setHint("正在识别。声纹来自本机麦克风输入，费用按识别时长估算。");
      startMeter();
      return;
    }

    if (message.type === "result") {
      if (message.sentenceEnd) {
        const text = message.text.trim();
        if (text && !finalText.endsWith(text)) {
          finalText += `${text}\n`;
          sessionText += `${text}\n`;
          displayLines.push(text);
          displayLines = displayLines.slice(-8);
        }
        interimText = "";
      } else {
        interimText = message.text || "";
      }
      render();
      return;
    }

    if (message.type === "error") {
      console.error(message);
      setStatus("出错");
      setHint(message.message || "识别连接出错，请重试。");
      await stopAudio();
      pauseMeter();
      toggleButton.textContent = "开始";
      toggleButton.classList.remove("recording");
      isRecording = false;
    }
  });

  socket.addEventListener("close", () => {
    if (isRecording) {
      stop();
    }
  });
};

toggleButton.addEventListener("click", () => {
  if (isRecording) {
    stop();
  } else {
    start().catch((error) => {
      console.error(error);
      setStatus("启动失败");
      setHint(microphoneErrorMessage(error));
      stopAudio();
      isRecording = false;
      clearTranscriptStage();
      toggleButton.textContent = "开始";
      toggleButton.classList.remove("recording");
    });
  }
});

clearButton.addEventListener("click", () => {
  if (activeStartedAt) {
    const segmentMs = Date.now() - activeStartedAt;
    totalMs += segmentMs;
    localStorage.setItem(totalStorageKey, String(Math.round(totalMs)));
    activeStartedAt = Date.now();
  }
  finalText = "";
  interimText = "";
  sessionText = "";
  displayLines = [];
  accumulatedMs = 0;
  render();
  renderMeter();
});

resetTotalButton.addEventListener("click", () => {
  totalMs = 0;
  if (activeStartedAt) activeStartedAt = Date.now();
  localStorage.setItem(totalStorageKey, "0");
  renderMeter();
});

fetch("/api/config")
  .then((response) => response.json())
  .then((config) => {
    if (!config.ok) setStatus("缺少密钥");
    if (config.model) modelNameEl.textContent = config.model;
    if (Number.isFinite(config.pricePerSecond)) {
      pricePerSecond = config.pricePerSecond;
    }
    transcriptDir = config.transcriptDir || "";
    unitPriceEl.textContent = `${pricePerSecond.toFixed(5)} 元/秒`;
    if (transcriptDir) setHint(`本次停止后会保存到：${transcriptDir}`);
    renderMeter();
  })
  .catch(() => {});
