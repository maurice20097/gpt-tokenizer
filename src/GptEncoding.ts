/* eslint-disable no-param-reassign */
import { BytePairEncodingCore } from './BytePairEncodingCore.js'
import {
  type EncodingName,
  type ModelName,
  chatModelParams,
  modelToEncodingMap,
} from './mapping.js'
import {
  type EncodingParams,
  type GetMergeableRanksAsyncFn,
  type GetMergeableRanksFn,
  getEncodingParams,
  getModelParamsAsync,
} from './modelParams.js'
import {
  EndOfPrompt,
  EndOfText,
  FimMiddle,
  FimPrefix,
  FimSuffix,
  ImEnd,
  ImSep,
  ImStart,
} from './specialTokens.js'
import { endsWithIncompleteUtfPairSurrogate } from './utfUtil.js'
import { getMaxValueFromMap, getSpecialTokenRegex, processImageFromUrl } from './util.js'

export const ALL_SPECIAL_TOKENS = 'all'

export interface EncodeOptions {
  allowedSpecial?: Set<string>
  disallowedSpecial?: Set<string>
}

enum MultiModalContentType {
  TEXT = 'text',
  IMAGE_URL = 'image_url',
}

enum MultiModalContentDetail {
  LOW = 'low',
  HIGH = 'high',
  AUTO = 'auto',
}

export interface MultiModalContent {
  type: MultiModalContentType;
  text?: string;
  image_url?: {
    url?: string;
    detail?: MultiModalContentDetail;
  };
}

export interface ChatMessage {
  role?: 'system' | 'user' | 'assistant'
  name?: string
  content: string | MultiModalContent[]
}

export interface EncodeChatOptions {
  primeWithAssistantResponse?: string
}

export class GptEncoding {
  static EndOfPrompt = EndOfPrompt
  static EndOfText = EndOfText
  static FimMiddle = FimMiddle
  static FimPrefix = FimPrefix
  static FimSuffix = FimSuffix

  decoder = new TextDecoder('utf8')
  modelName?: ModelName
  private bytePairEncodingCoreProcessor: BytePairEncodingCore
  private specialTokenMapping: Map<string, number>

  private constructor({
    tokenSplitRegex,
    mergeableBytePairRanks,
    specialTokenMapping,
    expectedVocabularySize,
    modelName,
  }: EncodingParams) {
    const maxTokenValue = Math.max(
      getMaxValueFromMap(mergeableBytePairRanks),
      getMaxValueFromMap(specialTokenMapping),
    )
    this.specialTokenMapping = specialTokenMapping

    if (expectedVocabularySize !== undefined) {
      if (
        mergeableBytePairRanks.size + specialTokenMapping.size !==
        expectedVocabularySize
      ) {
        throw new Error(
          'The number of mergeable tokens and special tokens must be equal to explicit_n_vocab.',
        )
      }

      if (maxTokenValue !== expectedVocabularySize - 1) {
        throw new Error(
          'The maximum token value must be equal to explicit_n_vocab - 1.',
        )
      }
    }

    this.bytePairEncodingCoreProcessor = new BytePairEncodingCore({
      bytePairEncoder: mergeableBytePairRanks,
      specialTokenEncoder: specialTokenMapping,
      tokenSplitRegex,
    })

    this.encode = this.encode.bind(this)
    this.decode = this.decode.bind(this)
    this.encodeGenerator = this.encodeGenerator.bind(this)
    this.decodeGenerator = this.decodeGenerator.bind(this)
    this.decodeAsyncGenerator = this.decodeAsyncGenerator.bind(this)
    this.isWithinTokenLimit = this.isWithinTokenLimit.bind(this)
    this.encodeChat = this.encodeChat.bind(this)
    this.encodeChatGenerator = this.encodeChatGenerator.bind(this)
    this.modelName = modelName
  }

  static getEncodingApi(
    encodingName: EncodingName,
    getMergeableRanks: GetMergeableRanksFn,
  ): GptEncoding {
    const modelParams = getEncodingParams(encodingName, getMergeableRanks)
    return new GptEncoding(modelParams)
  }

  static getEncodingApiForModel(
    modelName: ModelName,
    getMergeableRanks: GetMergeableRanksFn,
  ): GptEncoding {
    const encodingName = modelToEncodingMap[modelName]
    const modelParams = getEncodingParams(encodingName, getMergeableRanks)
    return new GptEncoding({ ...modelParams, modelName })
  }

  static async getEncodingApiAsync(
    encodingName: EncodingName,
    getMergeableRanks: GetMergeableRanksAsyncFn,
  ): Promise<GptEncoding> {
    const modelParams = await getModelParamsAsync(
      encodingName,
      getMergeableRanks,
    )
    return new GptEncoding(modelParams)
  }

  static async getEncodingApiForModelAsync(
    modelName: ModelName,
    getMergeableRanks: GetMergeableRanksAsyncFn,
  ): Promise<GptEncoding> {
    const encodingName = modelToEncodingMap[modelName]
    const modelParams = await getModelParamsAsync(
      encodingName,
      getMergeableRanks,
    )
    return new GptEncoding({ ...modelParams, modelName })
  }

  encodeGenerator(
    lineToEncode: string | MultiModalContent[],
    {
      allowedSpecial = new Set<string>(),
      disallowedSpecial = new Set<string>([ALL_SPECIAL_TOKENS]),
    }: EncodeOptions = {},
  ): Generator<number[], number, undefined> {
    const specialTokensSet = new Set<string>(this.specialTokenMapping.keys())

    if (disallowedSpecial.has(ALL_SPECIAL_TOKENS)) {
      disallowedSpecial = new Set<string>(specialTokensSet)
      allowedSpecial.forEach((val) => disallowedSpecial.delete(val))
      disallowedSpecial.forEach((val) => allowedSpecial.delete(val))
    }

    if (allowedSpecial.has(ALL_SPECIAL_TOKENS)) {
      allowedSpecial = specialTokensSet
    }
    
    if (typeof lineToEncode === 'string') {
      if (disallowedSpecial.size > 0) {
        const regexPattern = getSpecialTokenRegex(disallowedSpecial)
        const match = lineToEncode.match(regexPattern)
        if (match !== null) {
          throw new Error(`Disallowed special token found: ${match[0]}`)
        }
      }
  
      return this.bytePairEncodingCoreProcessor.encodeNative(
        lineToEncode,
        allowedSpecial,
      )
    }

    if (disallowedSpecial.size > 0) {
      const regexPattern = getSpecialTokenRegex(disallowedSpecial)
      const match = lineToEncode.map(content => content.text ?? "").join("")?.match(regexPattern)
      if (match !== null) {
        throw new Error(`Disallowed special token found: ${match?.[0]}`)
      }
    }

    return this.bytePairEncodingCoreProcessor.encodeNative(
      lineToEncode.map(content => content.text ?? "").join(""),
      allowedSpecial,
    )
  }

  encode(lineToEncode: string, encodeOptions: EncodeOptions = {}): number[] {
    return [...this.encodeGenerator(lineToEncode, encodeOptions)].flat()
  }

  /**
   * Progressively tokenizes an OpenAI chat.
   * Warning: gpt-3.5-turbo and gpt-4 chat format may change over time.
   * Returns tokens assuming the 'gpt-3.5-turbo-0301' / 'gpt-4-0314' format.
   * Based on OpenAI's guidelines: https://github.com/openai/openai-python/blob/main/chatml.md
   * Also mentioned in section 6 of this document: https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
   */
  *encodeChatGenerator(
    chat: Iterable<ChatMessage>,
    model = this.modelName,
  ): Generator<number[], void, undefined> {
    if (!model) {
      throw new Error(
        'Model name must be provided either during initialization or passed in to the method.',
      )
    }
    const params = chatModelParams[model]
    const chatStartToken = this.specialTokenMapping.get(ImStart)
    const chatEndToken = this.specialTokenMapping.get(ImEnd)

    if (!params || chatStartToken === undefined || chatEndToken === undefined) {
      throw new Error(`Model '${model}' does not support chat.`)
    }
    const allowedSpecial = new Set([ImSep])
    const { messageSeparator, roleSeparator } = params
    const encodedMessageSeparator =
      messageSeparator.length > 0 ? this.encode(messageSeparator) : []
    const encodedRoleSeparator =
      roleSeparator.length > 0
        ? this.encode(roleSeparator, { allowedSpecial })
        : []
    const nameCache = new Map<string, number[]>()

    for (const { role = 'system', name = role, content } of chat) {
      if (content === undefined) {
        throw new Error('Content must be defined for all messages.')
      }

      yield [chatStartToken]
      const encodedName = nameCache.get(name) ?? this.encode(name)
      nameCache.set(name, encodedName)
      yield encodedName
      if (encodedRoleSeparator.length > 0) {
        yield encodedRoleSeparator
      }
      yield* this.encodeGenerator(content)
      yield [chatEndToken]
      yield encodedMessageSeparator
    }

    // every reply is primed with <|start|>assistant<|message|>
    yield [chatStartToken]
    yield* this.encodeGenerator('assistant')
    if (encodedRoleSeparator.length > 0) {
      yield encodedRoleSeparator
    }
  }

  /**
   * Encodes a chat into a single array of tokens.
   * Warning: gpt-3.5-turbo and gpt-4 chat format may change over time.
   * Returns tokens assuming the 'gpt-3.5-turbo-0301' / 'gpt-4-0314' format.
   * Based on OpenAI's guidelines: https://github.com/openai/openai-python/blob/main/chatml.md
   * Also mentioned in section 6 of this document: https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
   */
  encodeChat(chat: readonly ChatMessage[], model = this.modelName): number[] {
    return [...this.encodeChatGenerator(chat, model)].flat()
  }

  /**
   * @returns {false | number} false if token limit is exceeded, otherwise the number of tokens
   */
  isWithinTokenLimit(
    input: string | Iterable<ChatMessage>,
    tokenLimit: number,
  ): false | number {
    const tokenGenerator =
      typeof input === 'string'
        ? this.encodeGenerator(input)
        : this.encodeChatGenerator(input)
    let count = 0
    for (const tokens of tokenGenerator) {
      count += tokens.length
      if (count > tokenLimit) {
        return false
      }
    }
    return count
  }

  /**
   * Gets the width and height of an image from a URL and returns the number of tokens required to process it.
   * @param {number} width - The width of the image.
   * @param {number} height - The height of the image.
   * @param {string} detail - Controls how the model processes the image and generates its textual understanding. (low, high or auto)
   * This algorithm has been adapted from OpenAI's guidelines:
   * https://platform.openai.com/docs/guides/vision/calculating-costs
   */
  visionTokenCountHelper(width: number, height: number, detail = "high"): number {
    let baseWidth = 768,
      baseHeight = 768;
    let aspect_ratio: number;

    if (detail === "low") {
      return 85;
    }

    if (width > 2048 || height > 2048) {
      aspect_ratio = width / height;
      if (aspect_ratio > 1) {
        baseWidth = 2048;
        baseHeight = Math.floor(2048 / aspect_ratio);
      } else {
        baseHeight = 2048;
        baseWidth = Math.floor(2048 * aspect_ratio);
      }
    }
    if (width >= height && height > 768) {
      baseWidth = Math.floor((768 / height) * width);
    } else if (height > width && width > 768) {
      baseHeight = Math.floor((768 / width) * height);
    }

    const tiles_width = Math.ceil(baseWidth / 512);
    const tiles_height = Math.ceil(baseHeight / 512);
    const total_tokens = 85 + 170 * (tiles_width * tiles_height);
    return total_tokens;
  }

  /**
   * 
   */
  async visionTokenCount(input: ChatMessage) {
    if (typeof input.content === "string") {
      throw new Error(
        "Expected a multimodal chat-message content but got a normal string."
      );
    }
    let tokenCount = 0;

    for (const content of input.content) {
      if (content.type === MultiModalContentType.IMAGE_URL) {
        const imageData = await processImageFromUrl(
          content.image_url?.url as string
        );
        tokenCount += this.visionTokenCountHelper(
          imageData?.width as number,
          imageData?.height as number,
          content.image_url?.detail ?? MultiModalContentDetail.AUTO
        );
      } else {
        tokenCount += this.encode(content.text ?? "").length;
      }
    }
    return tokenCount;
  }

  *decodeGenerator(
    inputTokensToDecode: Iterable<number>,
  ): Generator<string, void> {
    const decodedByteGenerator =
      this.bytePairEncodingCoreProcessor.decodeNative(inputTokensToDecode)

    let buffer = ''

    for (const decodedPart of decodedByteGenerator) {
      buffer += this.decoder.decode(decodedPart, { stream: true })

      if (buffer.length === 0 || endsWithIncompleteUtfPairSurrogate(buffer)) {
        // Keep the high surrogate in the buffer and continue with the next token
        // eslint-disable-next-line no-continue
        continue
      } else {
        yield buffer
        // reset buffer
        buffer = ''
      }
    }

    // Yield any remaining characters in the buffer
    if (buffer.length > 0) {
      yield buffer
    }
  }

  async *decodeAsyncGenerator(
    inputTokensToDecode: AsyncIterable<number>,
  ): AsyncGenerator<string, void> {
    const decodedByteGenerator =
      this.bytePairEncodingCoreProcessor.decodeNativeAsync(inputTokensToDecode)

    let buffer = ''

    for await (const decodedPart of decodedByteGenerator) {
      buffer += this.decoder.decode(decodedPart, { stream: true })

      if (buffer.length === 0 || endsWithIncompleteUtfPairSurrogate(buffer)) {
        // Keep the high surrogate in the buffer and continue with the next token
        // eslint-disable-next-line no-continue
        continue
      } else {
        yield buffer
        // reset buffer
        buffer = ''
      }
    }

    // Yield any remaining characters in the buffer
    if (buffer.length > 0) {
      yield buffer
    }
  }

  decode(inputTokensToDecode: Iterable<number>): string {
    return [...this.decodeGenerator(inputTokensToDecode)].join('')
  }
}

