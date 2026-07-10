import { CallbackHandler } from 'langfuse-langchain';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';

/**
 * 获取基于环境变量的监控回调
 * 如果存在 LANGFUSE_PUBLIC_KEY，则初始化 Langfuse 的 CallbackHandler
 * 如果存在 LANGCHAIN_TRACING_V2=true，则初始化 LangSmith 的 LangChainTracer
 * 
 * @returns BaseCallbackHandler[]
 */
export const getTracingCallbacks = (): BaseCallbackHandler[] => {
  const callbacks: BaseCallbackHandler[] = [];

  if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
    const handler = new CallbackHandler({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com',
    });
    callbacks.push(handler);
  }

  if (process.env.LANGCHAIN_TRACING_V2 === 'true') {
    callbacks.push(new LangChainTracer());
  }

  return callbacks;
};
