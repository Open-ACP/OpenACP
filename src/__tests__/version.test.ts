import { describe, it, expect } from 'vitest'
import { getCurrentVersion, compareVersions } from '../cli/version.js'

describe('getCurrentVersion', () => {
  it('returns a version string', () => {
    const version = getCurrentVersion()
    expect(typeof version).toBe('string')
    // Should either be a proper semver or the dev fallback
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  it('returns -1 when current is behind (major)', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1)
  })

  it('returns -1 when current is behind (minor)', () => {
    expect(compareVersions('1.0.0', '1.1.0')).toBe(-1)
  })

  it('returns -1 when current is behind (patch)', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
  })

  it('returns 1 when current is ahead (major)', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBe(1)
  })

  it('returns 1 when current is ahead (minor)', () => {
    expect(compareVersions('1.2.0', '1.1.0')).toBe(1)
  })

  it('returns 1 when current is ahead (patch)', () => {
    expect(compareVersions('1.0.2', '1.0.1')).toBe(1)
  })

  it('compares major before minor', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
  })

  it('compares minor before patch', () => {
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1)
  })

  it('handles versions with different segment counts', () => {
    // Missing segments default to 0
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
  })

  it('handles zero versions', () => {
    expect(compareVersions('0.0.0', '0.0.1')).toBe(-1)
    expect(compareVersions('0.0.0', '0.0.0')).toBe(0)
  })

  it('handles large version numbers', () => {
    expect(compareVersions('10.20.30', '10.20.30')).toBe(0)
    expect(compareVersions('10.20.30', '10.20.31')).toBe(-1)
    expect(compareVersions('10.21.0', '10.20.99')).toBe(1)
  })
})
