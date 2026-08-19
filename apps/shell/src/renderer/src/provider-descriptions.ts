/**
 * Translations for the provider descriptions on the AI providers screen.
 *
 * An overlay rather than a dictionary, and deliberately so. Every other string
 * in this app goes through `createI18n`, which has no fallback — a key missing
 * from one language renders `undefined`, so a new string has to be written into
 * all nineteen tables. These descriptions already exist in English, on the other
 * side of a wire: `AI_PROVIDER_DEFINITIONS` carries `description` into the
 * settings snapshot, and the main process serialises it. Copying that English
 * into a dictionary would make two sources of the same sentence and let them
 * drift, so a language with no entry here falls back to what the snapshot
 * already said.
 *
 * The descriptions are also what the provider search box matches, so a reader
 * who searches "이미지" finds the image providers rather than nothing.
 */
import type { Lang } from '@samugen/i18n'

const KO: Record<string, string> = {
  openai: '공식 API를 통해 OpenAI 모델을 사용합니다.',
  anthropic: 'Anthropic API를 통해 Claude 모델을 사용합니다.',
  gemini: 'Google Gemini 모델과 이미지 생성을 사용합니다.',
  deepseek: 'DeepSeek 채팅 및 추론 모델을 사용합니다.',
  openrouter: 'OpenRouter를 통해 채팅과 이미지 요청을 전달합니다.',
  mistral: 'OpenAI 호환 API를 통해 Mistral 모델을 사용합니다.',
  groq: 'Groq의 저지연 추론을 사용합니다.',
  together: 'Together AI를 통해 오픈 모델을 사용합니다.',
  fireworks: 'Fireworks AI를 통해 오픈 모델 추론과 도구 호출을 사용합니다.',
  cerebras: 'OpenAI 호환 API를 통해 Cerebras 추론을 사용합니다.',
  nvidia: 'NVIDIA가 호스팅하거나 직접 호스팅한 NIM 엔드포인트를 사용합니다.',
  xai: 'xAI API를 통해 Grok 모델을 사용합니다.',
  ollama: 'Ollama로 로컬 모델을 실행합니다.',
  lmstudio: '로컬 LM Studio 서버를 사용합니다.',
  vllm: '로컬 또는 호스팅된 vLLM OpenAI 호환 서버를 사용합니다.',
  llamacpp: '로컬 llama.cpp OpenAI 호환 서버를 사용합니다.',
  runware: 'Runware 모델 카탈로그를 통해 이미지를 생성합니다.',
  replicate: 'Replicate가 호스팅하는 공식 및 커뮤니티 이미지 모델을 사용합니다.',
  fal: 'fal의 큐 기반 추론 API를 통해 이미지 모델을 사용합니다.',
  stability: 'Stable Image Core, Ultra 및 Stable Diffusion 3.5를 사용합니다.',
  custom: 'OpenAI 호환 엔드포인트를 연결합니다.',
}

const OVERLAYS: Partial<Record<Lang, Record<string, string>>> = { ko: KO }

/** The description to show for a provider, in `lang`, falling back to the snapshot's own. */
export function providerDescription(lang: Lang, providerId: string, fallback: string): string {
  return OVERLAYS[lang]?.[providerId] ?? fallback
}
