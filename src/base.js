/**
 * The adapter contract, re-declared locally.
 *
 * `ctx.llm.registerAdapter()` consumes an adapter *structurally*: it calls
 * `providerInfo`, `providerRetryPolicy`, `imageRequestPricing`,
 * `imageRequestTarget`, `listModels`, `resolveModel`, and `prepareCall`, and
 * never asks what class the object is. Depending on `@deepseek-ai/dsh-llm` here
 * would therefore buy nothing but an install-time peer-resolution requirement,
 * so this file restates the contract with the same default answers instead.
 *
 * Keep the defaults equal to the upstream ones: an adapter that silently
 * changes a default (image pricing, image target) would change what the token
 * meter reports for requests it did not make.
 *
 * @module src/base.js
 */

/**
 * Message-and-stream adapter base. Every method has the same signature and
 * default as `@deepseek-ai/dsh-llm`'s `LlmAdapter`.
 */
export class Adapter {
  /**
   * Describe one provider route this adapter owns.
   * @param {string} provider - the registered route.
   * @returns {{id: string, name: string}} detached display metadata.
   */
  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  /**
   * Return this route's retry policy, or `undefined` for the normal defaults.
   * The router retries inside its own dispatch loop (it can fail over between
   * attempts, which the agent-level retry executor cannot), so it deliberately
   * declares no policy of its own: a failed turn is reported once, with every
   * member it tried already named in the message.
   * @returns {undefined}
   */
  providerRetryPolicy() {
    return undefined
  }

  /**
   * Declare no provider-side image pricing.
   * @returns {undefined}
   */
  imageRequestPricing() {
    return undefined
  }

  /**
   * Preserve normalized image dimensions, as the upstream default does.
   * @param {string} _provider - registered route.
   * @param {string} _model - exact model id.
   * @param {{width: number, height: number, bytes: number}} image - normalized image.
   * @returns {{width: number, height: number, maxBytes: number}} unchanged target.
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /**
   * List discoverable models.
   * @returns {Promise<Array<object>>} an empty catalog by default.
   */
  listModels() {
    return Promise.resolve([])
  }

  /**
   * Resolve all metadata available for one exact model.
   * @param {string} provider - registered route.
   * @param {string} model - exact model id.
   * @returns {Promise<object>} identity-only metadata by default.
   */
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /**
   * Bind model metadata and the eventual dispatch to one adapter generation.
   * @param {string} provider - registered route.
   * @param {string} model - exact model id.
   * @param {AbortSignal} [signal] - cancellation for model resolution.
   * @returns {Promise<{model: object, stream: (options: object) => AsyncIterable<object>}>} the prepared call.
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * Stream one model call.
   * @returns {AsyncIterable<object>} chunk stream.
   */
  async *stream() {
    throw new Error('this adapter does not implement stream()')
  }
}
