import { createStreamTransport, type AgentTransport } from '@samugen/agent-core'
import { t } from '../i18n/locale'
import { docsPlatform } from '../platform'

/** The shared IPC transport wired to the host's AI port. */
export function createAiTransport(): AgentTransport {
  return createStreamTransport({
    onStream: (listener) => docsPlatform().ai.onAiStream(listener),
    start: (request) => docsPlatform().ai.aiStream(request),
    cancel: (requestId) => void docsPlatform().ai.aiStreamCancel(requestId),
    task: 'chat',
    unknownErrorText: () => t('aiUnknownError'),
    timeoutErrorText: () => t('aiTimeoutError'),
    creditsErrorText: () => t('aiCreditsExhausted'),
  })
}
