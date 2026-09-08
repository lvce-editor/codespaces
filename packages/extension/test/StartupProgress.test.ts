import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStartupProgress } from '../src/parts/StartupProgress/StartupProgress.ts'

test('updates elapsed time without duplicating stages and retains completion history', async () => {
  let time = 0
  let output = ''
  const update = createStartupProgress(
    'test-codespace',
    async (value) => {
      output = value
    },
    () => time,
  )
  await update('Starting…')
  time = 65_000
  await update('Starting…')
  assert.equal(output.match(/Starting…/g)?.length, 1)
  assert.match(output, /Elapsed: 1m 5s/)
  assert.match(output, /Disconnect to cancel/)
  await update('Opening workspace…')
  await update('Connected.', true)
  assert.match(output, /\[0m 0s\] Starting…/)
  assert.match(output, /\[1m 5s\] Opening workspace…/)
  assert.match(output, /Connected\./)
  assert.doesNotMatch(output, /Disconnect to cancel/)
})

test('keeps failure and cancellation visible and bounds retained history', async () => {
  let output = ''
  const update = createStartupProgress('test-codespace', async (value) => {
    output = value
  })
  for (let i = 0; i < 60; i++) await update(`Stage ${i}.`)
  await update('Connection cancelled.', true)
  assert.doesNotMatch(output, /Stage 0\./)
  assert.match(output, /Stage 59\./)
  assert.match(output, /Connection cancelled\./)
  assert.doesNotMatch(output, /Disconnect to cancel/)
})

test('elapsed progress continues while a connection stage is pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const messages: string[] = []
  const update = createStartupProgress('test-codespace', async (value) => {
    messages.push(value)
  })
  await update('Connecting to the Codespace…')
  t.mock.timers.tick(1000)
  await Promise.resolve()
  assert.match(messages.at(-1)!, /Elapsed: 0m 1s/)
  await update('Connection cancelled.', true)
  const count = messages.length
  t.mock.timers.tick(60_000)
  await Promise.resolve()
  assert.equal(messages.length, count)
})
