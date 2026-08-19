import { createIpcTransport, type AgentTransport } from '@samugen/agent-core'
import { t } from '../i18n/locale'
import { slidesAi } from '../platform'

/** The shared IPC transport wired to the slides preload bridge (window.slidesApi). */
export function createElectronTransport(): AgentTransport {
  return createIpcTransport({
    onStream: (listener) => slidesAi().onAiStream(listener),
    start: (request) => slidesAi().aiStream(request),
    cancel: (requestId) => void slidesAi().aiStreamCancel(requestId),
    task: 'chat',
    unknownErrorText: () => t('aiErrUnknown'),
    timeoutErrorText: () => t('aiErrStreamTimeout'),
    creditsErrorText: () => t('aiCreditsExhausted'),
  })
}
