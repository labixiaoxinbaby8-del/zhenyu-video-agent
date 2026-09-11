// 帧语 · 阿里云百炼（DashScope）配音接入层（零外部依赖，用 Node 内置 fetch）
//
// 脚本生成和文生图走的是智谱 BigModel（见 zhipu.js），配音这一块用的是另一个
// 账号/项目——阿里云百炼平台的 Qwen3-TTS，两边互不共享余额，所以单独开一个
// 模块、单独一把 Key（环境变量 ALIYUN_TTS_API_KEY，兼容早期起名的
// ZHIPU_TTS_API_KEY，两个都读，前者优先）。
'use strict';

const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

function apiKey() {
  var key = process.env.ALIYUN_TTS_API_KEY || process.env.ZHIPU_TTS_API_KEY;
  if (!key) throw new Error('未设置 ALIYUN_TTS_API_KEY 环境变量');
  return key;
}

function hasApiKey() {
  return !!(process.env.ALIYUN_TTS_API_KEY || process.env.ZHIPU_TTS_API_KEY);
}

// Our internal Chinese voice-style labels (already shown throughout the UI
// and picked by pickVoiceBgm() in server.js) mapped to actual Qwen3-TTS voice
// IDs. Keep this in sync with VOICE_BGM_RULES's label set in server.js.
var VOICE_ID_MAP = {
  '知性女声': 'Maia',   // 四月 · 知性与温柔的融合
  '活泼童声': 'Mochi',  // 沙小弥 · 聪慧早熟童声
  '沉稳男声': 'Andre',  // 安德雷 · 磁性自然沉稳男生
  '温柔姐姐音': 'Serena' // 苏瑶 · 温柔小姐姐
};
var DEFAULT_VOICE_ID = 'Cherry'; // 芊悦 · 阳光积极、亲切自然

function voiceIdFor(label) {
  return VOICE_ID_MAP[label] || DEFAULT_VOICE_ID;
}

async function synthesizeSpeech(text, opts) {
  opts = opts || {};
  var res = await fetch(DASHSCOPE_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || 'qwen3-tts-flash',
      input: { text: text, voice: opts.voice || DEFAULT_VOICE_ID, language_type: 'Chinese' }
    })
  });
  var body = await res.json().catch(function () { return null; });
  if (!res.ok) {
    var msg = (body && body.message) || (body && body.error && body.error.message) || ('HTTP ' + res.status);
    throw new Error('阿里云配音接口出错：' + msg);
  }
  var url = body && body.output && body.output.audio && body.output.audio.url;
  if (!url) throw new Error('阿里云配音接口没有返回音频链接');
  // Short-lived signed URL — download immediately, caller persists the bytes.
  var audioRes = await fetch(url);
  if (!audioRes.ok) throw new Error('下载生成的配音失败：HTTP ' + audioRes.status);
  var buf = Buffer.from(await audioRes.arrayBuffer());
  return { buffer: buf, contentType: 'audio/wav' };
}

module.exports = {
  hasApiKey: hasApiKey,
  voiceIdFor: voiceIdFor,
  synthesizeSpeech: synthesizeSpeech
};
