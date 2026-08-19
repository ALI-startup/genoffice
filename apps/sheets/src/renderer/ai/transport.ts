import { createIpcTransport, type AgentTransport } from '@samugen/agent-core'
import { t } from '../i18n/locale'
import { sheetsAi } from '../platform'

/** The shared streaming transport, wired to whichever host is installed (see ../platform). */
export function createElectronTransport(): AgentTransport {
  return createIpcTransport({
    onStream: (listener) => sheetsAi().onAiStream(listener),
    start: (request) => sheetsAi().aiStream(request),
    cancel: (requestId) => void sheetsAi().aiStreamCancel(requestId),
    task: 'chat',
    unknownErrorText: () => t('aiUnknownError'),
    timeoutErrorText: () => t('aiTimeoutError'),
    creditsErrorText: () => t('aiCreditsExhausted'),
  })
}
