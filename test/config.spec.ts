import { describe, expect, it } from 'vitest'
import { Config, contentLimits, outputBudgetChars, validateHookCommands } from '../src/config.ts'
import type { Config as ConfigType } from '../src/config.ts'

type Resolve = (input: Record<string, unknown>) => ConfigType

/** Resolve the schemastery schema with defaults, exactly as a profile load does. */
const resolveConfig: Resolve = (input) => (Config as unknown as Resolve)(input)

describe('contentLimits', () => {
  it('lets contentFullIndex override both caps', () => {
    expect(contentLimits({ contentFullIndex: true, contentMaxTotalBytes: 1_000, contentMaxFiles: 10 })).toEqual({ maxTotalBytes: 0, maxFiles: 0 })
  })
  it('keeps explicit numeric caps when full mode is off', () => {
    expect(contentLimits({ contentFullIndex: false, contentMaxTotalBytes: 1_000, contentMaxFiles: 10 })).toEqual({ maxTotalBytes: 1_000, maxFiles: 10 })
    expect(contentLimits({ contentFullIndex: false, contentMaxTotalBytes: 0, contentMaxFiles: 0 })).toEqual({ maxTotalBytes: 0, maxFiles: 0 })
  })
})

describe('0.19.0 additive configuration', () => {
  it('defaults the ignore layers and external hooks to off', () => {
    const resolved = resolveConfig({})
    expect(resolved.notIndexed).toEqual([])
    expect(resolved.notSearchable).toEqual([])
    expect(resolved.notReadable).toEqual([])
    expect(resolved.outputBudgetChars).toBe(8000)
    expect(resolved.rerankCommand).toBe('')
    expect(resolved.ocrCommand).toBe('')
    expect(resolved.urlFreshness).toBe(false)
    expect(resolved.contentExtractDocuments).toBe(true)
    expect(resolved.contentExtractMaxBytes).toBe(20_000_000)
    expect(resolved.contentIndexSymbols).toBe(true)
    expect(resolved.contentSymbolMaxBytes).toBe(524_288)
    expect(resolved.refreshIncremental).toBe(true)
  })

  it('keeps explicit values, including an unlimited budget', () => {
    const resolved = resolveConfig({
      notSearchable: ['*.secret'],
      notReadable: ['private/**'],
      notIndexed: ['*.tmp'],
      outputBudgetChars: 0,
      rerankCommand: 'rerank --json',
      ocrCommand: 'tesseract-json',
      urlFreshness: true,
      contentExtractDocuments: false,
      contentExtractMaxBytes: 1_048_576,
      contentIndexSymbols: false,
      contentSymbolMaxBytes: 65_536,
      refreshIncremental: false,
    })
    expect(resolved.notSearchable).toEqual(['*.secret'])
    expect(resolved.notReadable).toEqual(['private/**'])
    expect(resolved.notIndexed).toEqual(['*.tmp'])
    expect(resolved.outputBudgetChars).toBe(0)
    expect(resolved.rerankCommand).toBe('rerank --json')
    expect(resolved.ocrCommand).toBe('tesseract-json')
    expect(resolved.urlFreshness).toBe(true)
    expect(resolved.contentExtractDocuments).toBe(false)
    expect(resolved.contentExtractMaxBytes).toBe(1_048_576)
    expect(resolved.contentIndexSymbols).toBe(false)
    expect(resolved.contentSymbolMaxBytes).toBe(65_536)
    expect(resolved.refreshIncremental).toBe(false)
  })
})

describe('outputBudgetChars', () => {
  it('falls back to the catalog default and keeps 0 as "unlimited"', () => {
    expect(outputBudgetChars({})).toBe(8000)
    expect(outputBudgetChars({ outputBudgetChars: 1234 })).toBe(1234)
    expect(outputBudgetChars({ outputBudgetChars: 0 })).toBe(0)
    expect(outputBudgetChars({ outputBudgetChars: -5 })).toBe(8000)
  })
})

describe('validateHookCommands', () => {
  it('accepts disabled and well-formed commands', () => {
    expect(validateHookCommands({})).toEqual([])
    expect(validateHookCommands({ rerankCommand: '', ocrCommand: '' })).toEqual([])
    expect(validateHookCommands({ rerankCommand: '/opt/rerank --json', ocrCommand: '"C:\\tools\\ocr.exe" --json' })).toEqual([])
  })

  it('reports an unbalanced quote per setting', () => {
    const problems = validateHookCommands({ rerankCommand: '"unclosed', ocrCommand: '' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('rerankCommand')
    expect(problems[0]).toContain('unbalanced')
    const both = validateHookCommands({ rerankCommand: '"a', ocrCommand: "'b" })
    expect(both).toHaveLength(2)
    expect(both[1]).toContain('ocrCommand')
  })
})
