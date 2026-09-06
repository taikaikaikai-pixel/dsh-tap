import { createOpenAICompatProvider } from '../openai-compat.js'

/**
 * iFlow 心流 preset。2026-08-19 实测：GET /models 不存在（404），
 * /chat/completions 认证方言 = HTTP 200 + {"status":"434","msg":"Invalid apiKey…"}
 * → 走 probeChatKey 验证 + fallbackModels 兜底清单（探针用清单首项）。
 * 清单来源：iFlow 用户配置实例与公开资料；错误项会在聊天时显性暴露，
 * 用户可用"刷新模型"重探（若上游日后补上 /models 则自动回到真实目录）。
 */
export default createOpenAICompatProvider({
  id: 'iflow',
  displayName: 'iFlow 心流',
  baseURL: 'https://apis.iflow.cn/v1',
  fallbackModels: ['qwen3-coder-plus', 'deepseek-v3.2', 'qwen3-max', 'kimi-k2', 'glm-4.7'],
})
