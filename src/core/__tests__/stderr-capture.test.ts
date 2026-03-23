import { describe, it, expect } from 'vitest'
import { StderrCapture } from '../stderr-capture.js'

describe('StderrCapture', () => {
  it('captures a single line', () => {
    const capture = new StderrCapture()
    capture.append('error line')
    expect(capture.getLastLines()).toBe('error line')
  })

  it('captures multiple lines from a single chunk', () => {
    const capture = new StderrCapture()
    capture.append('line1\nline2\nline3')
    expect(capture.getLastLines()).toBe('line1\nline2\nline3')
  })

  it('captures lines across multiple appends', () => {
    const capture = new StderrCapture()
    capture.append('first')
    capture.append('second')
    expect(capture.getLastLines()).toBe('first\nsecond')
  })

  it('respects maxLines limit', () => {
    const capture = new StderrCapture(3)
    capture.append('line1\nline2\nline3\nline4\nline5')
    expect(capture.getLastLines()).toBe('line3\nline4\nline5')
  })

  it('respects maxLines across multiple appends', () => {
    const capture = new StderrCapture(2)
    capture.append('a')
    capture.append('b')
    capture.append('c')
    expect(capture.getLastLines()).toBe('b\nc')
  })

  it('returns empty string when nothing captured', () => {
    const capture = new StderrCapture()
    expect(capture.getLastLines()).toBe('')
  })

  it('filters empty lines from split', () => {
    const capture = new StderrCapture()
    capture.append('\n\nhello\n\n')
    expect(capture.getLastLines()).toBe('hello')
  })

  it('uses default maxLines of 50', () => {
    const capture = new StderrCapture()
    const lines = Array.from({ length: 60 }, (_, i) => `line${i}`)
    capture.append(lines.join('\n'))
    const result = capture.getLastLines().split('\n')
    expect(result.length).toBe(50)
    expect(result[0]).toBe('line10')
    expect(result[49]).toBe('line59')
  })

  it('handles chunk with only newlines', () => {
    const capture = new StderrCapture()
    capture.append('\n\n\n')
    expect(capture.getLastLines()).toBe('')
  })
})
