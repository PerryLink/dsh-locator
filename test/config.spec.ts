import { describe, expect, it } from 'vitest'
import { contentLimits } from '../src/config.ts'

describe('contentLimits', () => {
  it('lets contentFullIndex override both caps', () => {
    expect(contentLimits({ contentFullIndex: true, contentMaxTotalBytes: 1_000, contentMaxFiles: 10 })).toEqual({ maxTotalBytes: 0, maxFiles: 0 })
  })
  it('keeps explicit numeric caps when full mode is off', () => {
    expect(contentLimits({ contentFullIndex: false, contentMaxTotalBytes: 1_000, contentMaxFiles: 10 })).toEqual({ maxTotalBytes: 1_000, maxFiles: 10 })
    expect(contentLimits({ contentFullIndex: false, contentMaxTotalBytes: 0, contentMaxFiles: 0 })).toEqual({ maxTotalBytes: 0, maxFiles: 0 })
  })
})
