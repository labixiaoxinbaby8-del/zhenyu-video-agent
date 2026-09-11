// 帧语 · 智谱 BigModel 接入层（零外部依赖，用 Node 内置 fetch）
//
// 两个能力，一把 Key（环境变量 ZHIPU_API_KEY）：
//   - chatComplete()   脚本/分镜文案生成（GLM 对话模型）
//   - generateImage()  分镜画面文生图（CogView），返回下载好的图片 Buffer
//
// 配音不在这里——GLM-TTS 需要单独的语音资源包，账号里一直没开通，最终改用
// 阿里云百炼的 Qwen3-TTS（见 aliyun.js），走的是完全不同的账号/接口。
//
// 网络错误/欠费/内容被拒等一律包装成 Error 抛出，调用方决定怎么优雅降级。
'use strict';

const BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

function apiKey() {
  var key = process.env.ZHIPU_API_KEY;
  if (!key) throw new Error('未设置 ZHIPU_API_KEY 环境变量');
  return key;
}

function hasApiKey() {
  return !!process.env.ZHIPU_API_KEY;
}

async function chatComplete(messages, opts) {
  opts = opts || {};
  var res = await fetch(BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || 'glm-4-flash',
      messages: messages,
      temperature: opts.temperature != null ? opts.temperature : 0.7
    })
  });
  var body = await res.json().catch(function () { return null; });
  if (!res.ok) {
    var msg = (body && body.error && body.error.message) || ('HTTP ' + res.status);
    throw new Error('智谱对话接口出错：' + msg);
  }
  var content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  if (!content) throw new Error('智谱对话接口返回了空内容');
  return content;
}

// Parses a chat reply that's supposed to be pure JSON but, in practice, the
// model sometimes wraps it in ```json fences or adds a stray sentence before
// it — strip that off before parsing rather than failing outright.
function parseJsonReply(text) {
  var trimmed = text.trim();
  var fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) trimmed = fenced[1].trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    var braceStart = trimmed.indexOf('{');
    var braceEnd = trimmed.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      return JSON.parse(trimmed.slice(braceStart, braceEnd + 1));
    }
    throw new Error('无法解析模型返回的 JSON：' + e.message);
  }
}

// The CDN CogView's image URL redirects to has been observed to declare a
// Content-Type that doesn't match the actual bytes (e.g. "image/png" header
// on a JPEG file) — sniff the real format from the file's magic bytes
// instead of trusting the header, so the saved file's extension is honest.
function sniffImageContentType(buf, declared) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return declared || 'image/png';
}

async function generateImage(prompt, opts) {
  opts = opts || {};
  var res = await fetch(BASE_URL + '/images/generations', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model || 'cogview-3-flash', prompt: prompt })
  });
  var body = await res.json().catch(function () { return null; });
  if (!res.ok) {
    var msg = (body && body.error && body.error.message) || ('HTTP ' + res.status);
    throw new Error('智谱文生图接口出错：' + msg);
  }
  var url = body && body.data && body.data[0] && body.data[0].url;
  if (!url) throw new Error('智谱文生图接口没有返回图片链接');
  // The returned URL is a short-lived signed link (expires in days, not
  // months) — download it immediately, the caller persists the bytes.
  var imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error('下载生成的图片失败：HTTP ' + imgRes.status);
  var buf = Buffer.from(await imgRes.arrayBuffer());
  return { buffer: buf, contentType: sniffImageContentType(buf, imgRes.headers.get('content-type')) };
}

module.exports = {
  hasApiKey: hasApiKey,
  chatComplete: chatComplete,
  parseJsonReply: parseJsonReply,
  generateImage: generateImage
};
