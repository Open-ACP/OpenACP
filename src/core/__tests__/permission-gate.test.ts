import { describe, it, expect } from 'vitest'
import { PermissionGate } from '../permission-gate.js'
import type { PermissionRequest } from '../types.js'

const mockRequest: PermissionRequest = {
  id: 'req-1',
  description: 'Allow file write?',
  options: [
    { id: 'allow', label: 'Allow', isAllow: true },
    { id: 'deny', label: 'Deny', isAllow: false },
  ],
}

describe('PermissionGate', () => {
  it('setPending returns promise that resolves when resolve() is called', async () => {
    const gate = new PermissionGate()
    const promise = gate.setPending(mockRequest)

    expect(gate.isPending).toBe(true)
    expect(gate.currentRequest).toEqual(mockRequest)

    gate.resolve('allow')

    const result = await promise
    expect(result).toBe('allow')
    expect(gate.isPending).toBe(false)
  })

  it('reject() rejects the pending promise', async () => {
    const gate = new PermissionGate()
    const promise = gate.setPending(mockRequest)

    gate.reject('user cancelled')

    await expect(promise).rejects.toThrow('user cancelled')
    expect(gate.isPending).toBe(false)
  })

  it('double-resolve is a no-op (no error)', async () => {
    const gate = new PermissionGate()
    const promise = gate.setPending(mockRequest)

    gate.resolve('allow')
    // Second resolve should not throw
    expect(() => gate.resolve('deny')).not.toThrow()

    const result = await promise
    expect(result).toBe('allow')
  })

  it('resolve without pending is a no-op', () => {
    const gate = new PermissionGate()
    expect(() => gate.resolve('allow')).not.toThrow()
  })

  it('currentRequest is undefined when not pending', () => {
    const gate = new PermissionGate()
    expect(gate.currentRequest).toBeUndefined()
    expect(gate.isPending).toBe(false)
  })

  it('can set a new pending after resolving previous', async () => {
    const gate = new PermissionGate()

    const p1 = gate.setPending(mockRequest)
    gate.resolve('allow')
    await p1

    const request2: PermissionRequest = { ...mockRequest, id: 'req-2' }
    const p2 = gate.setPending(request2)
    expect(gate.currentRequest?.id).toBe('req-2')

    gate.resolve('deny')
    const result = await p2
    expect(result).toBe('deny')
  })
})
