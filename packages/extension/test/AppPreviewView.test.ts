import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  previewView,
  setAppPreview,
} from '../src/parts/AppPreviewView/AppPreviewView.ts'

test('preview clears the live instance on disconnect and releases closed views', async () => {
  let renders = 0
  assert.ok(previewView.create)
  const instance = await previewView.create({
    uid: 1,
    viewId: previewView.id,
    requestRerender: async () => {
      renders++
    },
    showContextMenu: async () => {},
  })
  await setAppPreview({
    port: 3000,
    label: 'Bad Apple',
    url: 'https://happy-cat-3000.app.github.dev/',
  })
  assert.equal(renders, 1)
  assert.ok(
    (await instance.render()).some(
      (node) => node.src === 'https://happy-cat-3000.app.github.dev/',
    ),
  )
  await setAppPreview(undefined)
  assert.equal(renders, 2)
  assert.ok(!(await instance.render()).some((node) => node.src))
  await instance.dispose?.()
  await setAppPreview(undefined)
  assert.equal(renders, 2)
})
