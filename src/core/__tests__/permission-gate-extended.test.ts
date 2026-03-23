import { describe, it, expect, vi } from 'vitest'
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

describe('PermissionGate - extended edge cases', () => {
  describe('requestId', () => {
    it('returns undefined when not pending', () => {
      const gate = new PermissionGate()
      expect(gate.requestId).toBeUndefined()
    })

    it('returns request id when pending', () => {
      const gate = new PermissionGate()
      gate.setPending(mockRequest)
      expect(gate.requestId).toBe('req-1')
    })

    it('returns undefined after resolution', async () => {
      const gate = new PermissionGate()
      const p = gate.setPending(mockRequest)
      gate.resolve('allow')
      await p
      expect(gate.requestId).toBeUndefined()
    })
  })

  describe('reject() defaults', () => {
    it('rejects with "Permission rejected" when no reason given', async () => {
      const gate = new PermissionGate()
      const p = gate.setPending(mockRequest)
      gate.reject()
      await expect(p).rejects.toThrow('Permission rejected')
    })

    it('rejects with custom reason', async () => {
      const gate = new PermissionGate()
      const p = gate.setPending(mockRequest)
      gate.reject('custom reason')
      await expect(p).rejects.toThrow('custom reason')
    })
  })

  describe('resolve then reject (idempotent)', () => {
    it('first settlement wins — resolve then reject', async () => {
      const gate = new PermissionGate()
      const p = gate.setPending(mockRequest)

      gate.resolve('allow')
      gate.reject('too late') // should be no-op

      const result = await p
      expect(result).toBe('allow')
    })

    it('first settlement wins — reject then resolve', async () => {
      const gate = new PermissionGate()
      const p = gate.setPending(mockRequest)

      gate.reject('denied')
      gate.resolve('allow') // should be no-op

      await expect(p).rejects.toThrow('denied')
    })
  })

  describe('concurrent setPending', () => {
    it('new setPending overwrites previous without waiting', async () => {
      const gate = new PermissionGate()

      const p1 = gate.setPending(mockRequest)
      // p1 is now the pending request

      const request2 = { ...mockRequest, id: 'req-2' }
      const p2 = gate.setPending(request2)
      // p2 overwrites p1

      expect(gate.currentRequest?.id).toBe('req-2')
      expect(gate.requestId).toBe('req-2')

      gate.resolve('allow')
      const result = await p2
      expect(result).toBe('allow')
    })
  })

  describe('isPending edge cases', () => {
    it('isPending is false initially', () => {
      const gate = new PermissionGate()
      expect(gate.isPending).toBe(false)
    })

    it('isPending becomes true on setPending', () => {
      const gate = new PermissionGate()
      gate.setPending(mockRequest)
      expect(gate.isPending).toBe(true)
    })

    it('isPending becomes false after resolve', async () => {
      const gate = new PermissionGate()
      const p = gate.setPending(mockRequest)
      gate.resolve('allow')
      await p
      expect(gate.isPending).toBe(false)
    })

    it('isPending becomes false after timeout', async () => {
      vi.useFakeTimers()
      const gate = new PermissionGate(100)
      const p = gate.setPending(mockRequest)

      vi.advanceTimersByTime(100)

      try { await p } catch { /* expected */ }
      expect(gate.isPending).toBe(false)

      vi.useRealTimers()
    })
  })

  describe('timeout variations', () => {
    it('uses custom timeout', async () => {
      vi.useFakeTimers()
      const gate = new PermissionGate(200)
      const p = gate.setPending(mockRequest)

      // Not timed out at 199ms
      vi.advanceTimersByTime(199)
      expect(gate.isPending).toBe(true)

      // Timed out at 200ms
      vi.advanceTimersByTime(1)
      await expect(p).rejects.toThrow('timed out')

      vi.useRealTimers()
    })
  })
})
