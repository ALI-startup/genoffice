/** Empty-value formula results display as 0, like Excel. */
import { IFormulaRuntimeService, NumberValueObject } from '@univerjs/engine-formula'

import type { UniverRuntime } from './univer-state'

interface VariantLike {
  isValueObject?(): boolean
  isArray?(): boolean
  isNull?(): boolean
}

export function coerceNullResult<T>(variant: T): T | NumberValueObject {
  const value = variant as VariantLike | null | undefined
  if (value?.isValueObject?.() && !value.isArray?.() && value.isNull?.()) {
    return NumberValueObject.create(0)
  }
  return variant
}

export function installFormulaNullResultFix(runtime: UniverRuntime): { dispose(): void } {
  const runtimeService = runtime.univer.__getInjector().get(IFormulaRuntimeService)
  const original = runtimeService.setRuntimeData.bind(runtimeService)
  runtimeService.setRuntimeData = (variant) => original(coerceNullResult(variant))
  return {
    dispose() {
      runtimeService.setRuntimeData = original
    },
  }
}
