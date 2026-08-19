import { createStreamTransport, type AgentTransport } from '@samugen/agent-core'
import { t } from '../i18n/locale'
import { pdfPlatform } from '../platform'

/** The shared IPC transport wired to the host's AI port. */
export function createAiTransport(): AgentTransport {
  return createStreamTransport({
    onStream: (listener) => pdfPlatform().ai.onAiStream(listener),
    start: (request) => pdfPlatform().ai.aiStream(request),
    cancel: (requestId) => void pdfPlatform().ai.aiStreamCancel(requestId),
    task: 'chat',
    unknownErrorText: () => t('aiUnknownError'),
    timeoutErrorText: () => t('aiTimeoutError'),
    creditsErrorText: () => t('aiCreditsExhausted'),
  })
}
