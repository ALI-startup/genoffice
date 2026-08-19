/**
 * The Worker entry point: four lines that hand `serveEngine` the real `self`.
 *
 * Everything it does is in worker-host.ts, which takes a message link as an argument — so
 * the same code is exercised by tests without a Worker, and this file has nothing in it to
 * get wrong.
 */
import { serveEngine } from './worker-host'

serveEngine(self as unknown as Parameters<typeof serveEngine>[0])
