/** The Worker entry point: four lines that hand `serveEngine` the real `self`. */
import { serveEngine } from './worker-host'

serveEngine(self as unknown as Parameters<typeof serveEngine>[0])
