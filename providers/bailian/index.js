import { createOpenAICompatProvider } from '../openai-compat.js'

/**
 * 阿里云百炼 preset。OpenAI 兼容模式端点 = dashscope compatible-mode。
 */
export default createOpenAICompatProvider({
  id: 'bailian',
  displayName: '阿里云百炼',
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
})
