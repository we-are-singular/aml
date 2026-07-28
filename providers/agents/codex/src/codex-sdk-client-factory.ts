import { Codex } from "@openai/codex-sdk"

import type { CodexClient, CodexClientFactory, CodexClientOptions } from "./codex-client-factory.js"

/**
 * Constructs the official Codex SDK behind AML's deterministic test port.
 */
export class CodexSdkClientFactory implements CodexClientFactory {
  /**
   * Creates one invocation-local SDK client without widening the public port.
   */
  create(options: CodexClientOptions): CodexClient {
    // The SDK configuration types are mutable, while AML snapshots every
    // nested value. Codex only reads them while constructing CLI arguments.
    return new Codex({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.codexPathOverride === undefined ? {} : { codexPathOverride: options.codexPathOverride }),
      config: options.config as never,
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
    }) as CodexClient
  }
}
