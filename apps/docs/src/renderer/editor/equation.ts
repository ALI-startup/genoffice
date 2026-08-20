import { latexToOmml, mathParagraphXml, mathTokensOf, ommlToMathML } from '@samugen/docx-engine'
import { t } from '../i18n/locale'
import type { PmNode } from './convert'

/**
 * Protected display-equation block built from LaTeX (throws on syntax outside the supported
 * subset).
 */
/** MathML for inline flow (ommlToMathML emits display="block" for equations) */
export function inlineMathML(omml: string): string {
  return ommlToMathML(omml).replace(/ display="block"/g, ' display="inline"')
}

/** Atomic inline formula node built from LaTeX (throws on unsupported syntax). */
export function inlineEquationNodeJson(latex: string): PmNode {
  const inner = latexToOmml(latex)
  const omml = `<m:oMath>${inner}</m:oMath>`
  return {
    type: 'docInlineMath',
    attrs: {
      omml,
      mathml: inlineMathML(omml),
      latex: latex.trim(),
      text: mathTokensOf(omml).join(''),
    },
  }
}

export function equationBlockJson(latex: string): PmNode {
  const omml = latexToOmml(latex)
  return {
    type: 'docProtected',
    attrs: {
      docxIndex: null,
      blockType: 'passthrough',
      label: t('editorEquation'),
      previewText: latex.trim(),
      genXml: mathParagraphXml(omml),
      formulaDisplay: {
        tokens: mathTokensOf(omml),
        mathml: ommlToMathML(`<m:oMath>${omml}</m:oMath>`),
        omml: `<m:oMath>${omml}</m:oMath>`,
        latex: latex.trim(),
      },
    },
  }
}
