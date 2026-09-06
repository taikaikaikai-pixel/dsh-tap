import { createOpenAICompatProvider } from '../openai-compat.js'

/**
 * 火山引擎 Ark（方舟）preset。OpenAI 兼容端点 = /api/v3；
 * 目录 GET /models 用 Bearer <Agent Plan key>。
 */
export default createOpenAICompatProvider({
  id: 'ark',
  displayName: '火山引擎 Ark',
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
})
