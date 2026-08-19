# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities privately via GitHub's
[private vulnerability reporting](https://github.com/ALI-startup/genoffice/security/advisories/new)
on this repository. Do not open public issues for security reports. We aim to
acknowledge reports within 72 hours.

## Security Posture

The apps are static pages: they run in the browser's own sandbox, with no server
that sees a document and no process of ours on the user's machine.

- Every app ships its own `Content-Security-Policy` meta tag, and each one is as
  narrow as that app allows: `default-src 'self'`, no inline scripts, and
  `connect-src 'self'` — so a cross-origin request is refused before it is sent.
  `'wasm-unsafe-eval'` appears only where a WebAssembly module is genuinely
  loaded (sheets' xlsx engine, pdf's codecs).
- Documents are opened and saved through the File System Access API, so the page
  holds a handle to exactly the files the user picked and nothing else. Nothing
  is uploaded: there is no document endpoint to upload to.
- Every URL that comes out of a document or out of AI output (a pptx run link, a
  PDF outline entry, a hyperlink in a cell) goes through one gate before it is
  opened — `@samugen/platform-web` → `safeExternalUrl` — which parses it and
  enforces a protocol allowlist (http/https; PDF outline entries additionally
  allow mailto). `file:`, `javascript:`, and custom schemes are always rejected,
  and what is opened gets `noopener,noreferrer` so it has no handle on the page
  holding the user's document.
- No provider credential reaches the page. AI calls go to `services/ai-bff` on
  the same origin, which holds the credentials server-side and never echoes one
  back — the settings route returns a masked summary.
- The editors run inside the shell as same-origin iframes, and they talk to it
  over `postMessage` with an origin check on both ends; the wire is a small
  typed message set (`@samugen/platform-web` → `frame-wire`), not an arbitrary
  RPC.

## Threat Model: AI-Generated Layout Scripts (slides)

The slides AI can adjust slide layouts by emitting a small script that is
parsed with Acorn and evaluated by a constrained AST interpreter
(`apps/slides/src/renderer/ai/layout-script-interpreter.ts`). The source looks
like a small, synchronous subset of JavaScript for model compatibility, but it
is not passed to `eval`, `Function`, a VM context, a worker, or the JavaScript
engine as executable source.

**What the script can do by design:** read prototype-free JSON copies of
`els`/`canvas`, perform bounded arithmetic/control flow, use explicitly
implemented string/array/regular-expression/Math helpers, and call
`setBox/moveBy/resizeBy/setText/setStyle/setFill/setStroke/log`. Every edit
primitive validates its arguments (element existence, read-only flags, finite
numbers, hex colors) and writes only into an op buffer that is applied through
the same command pipeline as manual edits.

**Interpreter boundary:**

1. Identifiers resolve only in interpreter-owned lexical scopes seeded with the
   documented data and callables. There are no ambient globals, module loader,
   DOM, network, storage, timers, or dynamic code primitives.
2. Property reads are dispatched by value type. Data objects expose own JSON
   fields only; arrays, strings, and regexes expose a small method allowlist.
   Host prototypes and function properties are never traversed, including
   through computed property names.
3. Calls accept only interpreter-created functions or explicit builtins. A host
   function obtained through a constructor/prototype chain cannot be
   represented.
4. Inputs and values crossing into edit primitives are recursively copied as
   JSON-like, prototype-free data. Errors discard all buffered operations;
   logs are capped.
5. Execution has statement/expression and call-depth limits to bound runaway
   loops or recursion.

The browser's own sandbox remains defense in depth, but it is not the
layout-script security boundary. The interpreter is designed so a layout
script cannot obtain page capabilities in the first place.

If you find a way for a layout script to reach anything beyond the injected
primitives — the network, storage, the document outside the ops it is given, or
anything else on the page — that is a vulnerability, please report it.

## Out of Scope

- The AI providers the BFF talks to are operated separately and are not part of
  this repository; issues with them should be reported through the provider's
  channels.
- Whatever serves these files and proxies the BFF route (see docker/nginx for
  the reference configuration) is deployment-specific; TLS, headers and access
  control there are the deployer's responsibility.
- Vulnerabilities that require an already-compromised machine, or control of the
  environment the tools run in. This includes the deliberate override points for
  local development and benchmarking (`XLSX_SIDECAR_PATH`), which need control of
  the process environment — equivalent to code execution on that machine.
