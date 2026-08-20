# `hwp2hwpx.jar`

A pre-built fat JAR that converts HWP 5.0 binary documents (`.hwp`) to OWPML
packages (`.hwpx`). `src/convert.ts` runs it as a subprocess; nothing else in
this repository links against it.

## Why a JAR

`.hwp` is an OLE compound document holding compressed record streams. The only
complete reader of it is [`hwplib`], and there is no browser build of it and no
JavaScript port that reads a real file — the npm package that advertises itself
as an HWP reader (`neoali-hwpxjs`'s `HWPReader`) checks the compound-document
signature and then returns a hard-coded sentence, so using it would produce a
document that looks converted and contains nothing of the original.

So `.hwp` support is either a server-side converter or nothing, and this is the
converter. `.hwpx` needs none of this: @samugen/hwpx-convert reads and writes it
in the page.

## What is inside

| Library                          | Version | License    |
| -------------------------------- | ------- | ---------- |
| `kr.dogfoot:hwplib` ([hwplib])   | 1.1.10  | Apache-2.0 |
| `kr.dogfoot:hwpxlib` ([hwpxlib]) | 1.0.8   | Apache-2.0 |
| `hwp2hwpx` ([hwp2hwpx])          | —       | Apache-2.0 |

All three are Apache-2.0, the same license this repository is under.

[hwplib]: https://github.com/neolord0/hwplib
[hwpxlib]: https://github.com/neolord0/hwpxlib
[hwp2hwpx]: https://github.com/neolord0/hwp2hwpx

## Contract

```
java -jar hwp2hwpx.jar <input.hwp> <output.hwpx>
```

Exit 0 on success, non-zero on failure, errors on stderr. `src/convert.ts`
depends on exactly that and on nothing else about the JAR, so replacing it with
a different build — or with the GraalVM native image of the same CLI — needs no
code change, only `SAMUGEN_HWP2HWPX_JAR`.

## Replacing it

The JAR is committed rather than fetched at build time so a build needs no
network and no Maven. To rebuild it from source, `hwp2hwpx`'s own CLI wrapper
plus the two libraries above assemble into a fat JAR with the two-argument
`main` the contract describes; point `SAMUGEN_HWP2HWPX_JAR` at the result.
