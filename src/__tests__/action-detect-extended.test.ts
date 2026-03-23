import { describe, it, expect, beforeEach } from 'vitest'
import { storeAction, getAction, removeAction, buildActionKeyboard } from '../adapters/telegram/action-detect.js'
import type { DetectedAction } from '../adapters/telegram/action-detect.js'

describe('storeAction / getAction / removeAction', () => {
  const newSessionAction: DetectedAction = {
    action: 'new_session',
    agent: 'claude',
    workspace: '~/project',
  }

  const cancelAction: DetectedAction = {
    action: 'cancel_session',
  }

  it('stores and retrieves an action', () => {
    const id = storeAction(newSessionAction)
    expect(typeof id).toBe('string')
    expect(id.length).toBe(10)

    const retrieved = getAction(id)
    expect(retrieved).toEqual(newSessionAction)
  })

  it('returns undefined for non-existent action', () => {
    expect(getAction('nonexistent')).toBeUndefined()
  })

  it('removes an action', () => {
    const id = storeAction(cancelAction)
    expect(getAction(id)).toBeDefined()

    removeAction(id)
    expect(getAction(id)).toBeUndefined()
  })

  it('removeAction is no-op for unknown id', () => {
    removeAction('nonexistent') // should not throw
  })

  it('generates unique ids for each store', () => {
    const id1 = storeAction(newSessionAction)
    const id2 = storeAction(newSessionAction)
    expect(id1).not.toBe(id2)
  })

  it('stores multiple actions independently', () => {
    const id1 = storeAction(newSessionAction)
    const id2 = storeAction(cancelAction)

    expect(getAction(id1)).toEqual(newSessionAction)
    expect(getAction(id2)).toEqual(cancelAction)

    removeAction(id1)
    expect(getAction(id1)).toBeUndefined()
    expect(getAction(id2)).toEqual(cancelAction)
    removeAction(id2)
  })
})

describe('buildActionKeyboard', () => {
  it('builds keyboard for new_session action', () => {
    const action: DetectedAction = { action: 'new_session', agent: 'claude' }
    const keyboard = buildActionKeyboard('action-123', action)

    // InlineKeyboard from grammy has inline_keyboard property
    const raw = (keyboard as any).inline_keyboard
    expect(raw).toBeDefined()
    expect(raw.length).toBeGreaterThan(0)

    // First row should have 2 buttons
    const buttons = raw[0]
    expect(buttons.length).toBe(2)
    expect(buttons[0].text).toContain('Create session')
    expect(buttons[0].callback_data).toBe('a:action-123')
    expect(buttons[1].text).toContain('Cancel')
    expect(buttons[1].callback_data).toBe('a:dismiss:action-123')
  })

  it('builds keyboard for cancel_session action', () => {
    const action: DetectedAction = { action: 'cancel_session' }
    const keyboard = buildActionKeyboard('action-456', action)

    const raw = (keyboard as any).inline_keyboard
    const buttons = raw[0]
    expect(buttons[0].text).toContain('Cancel session')
    expect(buttons[0].callback_data).toBe('a:action-456')
    expect(buttons[1].text).toContain('No')
    expect(buttons[1].callback_data).toBe('a:dismiss:action-456')
  })
})
