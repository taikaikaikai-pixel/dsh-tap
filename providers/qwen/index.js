import { createOpenAICompatProvider } from '../openai-compat.js'

/**
 * Qwen Code（portal.qwen.ai）preset。2026-08-19 实测：GET /models 不存在
 * （404），/chat/completions 认证方言 = 标准 401 invalid_api_key。
 * 注意：Qwen OAuth 免费额度已于 2026-04-15 停服（官方文档），本机
 * oauth_creds.json 里的存量 token 大概率已失效——导入时探针会如实拒绝，
 * 不留半成品。Coding Plan（sk-sp- key）是另一端点 coding.dashscope.aliyuncs.com。
 */
export default createOpenAICompatProvider({
  id: 'qwen',
  displayName: 'Qwen Code',
  baseURL: 'https://portal.qwen.ai/v1',
  fallbackModels: ['qwen3-coder-plus', 'qwen3-coder-flash'],
})
