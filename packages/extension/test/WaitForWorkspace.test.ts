import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitForWorkspace } from '../src/parts/WaitForWorkspace/WaitForWorkspace.ts'

test('a lost workspace response times out with a retry instruction', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const result = waitForWorkspace(
    new Promise(() => {}),
    new AbortController().signal,
  )
  const rejected = assert.rejects(result, /timed out.*Connect to Codespace/)
  t.mock.timers.tick(30_000)
  await rejected
})

test('cancellation handles a late rejected workspace response', async () => {
  const pending = Promise.withResolvers<void>()
  const controller = new AbortController()
  const result = waitForWorkspace(pending.promise, controller.signal)
  controller.abort()
  await assert.rejects(result, /Connection cancelled/)
  pending.reject(new Error('Worker disconnected'))
})
