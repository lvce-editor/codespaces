import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

test('restores static authentication once, retries failed initialization, and requests token refresh', async () => {
  const result = await build({
    stdin: {
      contents: `export * from '../src/parts/Auth/Auth.ts';
        export { state } from '@lvce-editor/api';`,
      resolveDir: import.meta.dirname,
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    plugins: [
      {
        name: 'auth-api',
        setup(builder) {
          builder.onResolve({ filter: /^@lvce-editor\/api$/ }, () => ({
            path: 'api',
            namespace: 'test',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: `
              export const state = { calls: [], fail: true, ready: false, token: 'refreshed-lvce-token' };
              export const executeCommand = async command => {
                state.calls.push(command);
                if (state.fail) throw new Error('Initialization failed');
                await Promise.resolve();
                state.ready = true;
              };
              export const getAccessToken = async options => {
                if (!state.ready) throw new Error('Auth backend is not initialized');
                state.calls.push(options);
                return state.token;
              };
            `,
          }))
        },
      },
    ],
  })
  const auth = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
  await assert.rejects(auth.getToken(), /Initialization failed/)
  auth.state.fail = false
  assert.deepEqual(await Promise.all([auth.getToken(), auth.getToken()]), [
    'refreshed-lvce-token',
    'refreshed-lvce-token',
  ])
  assert.deepEqual(auth.state.calls, [
    'Layout.refreshAuthState',
    'Layout.refreshAuthState',
    { refresh: 'if-needed' },
    { refresh: 'if-needed' },
  ])
  auth.state.token = ''
  await assert.rejects(auth.getToken(), /Sign in to LVCE/)
  assert.equal(
    auth.state.calls.filter((call: unknown) => typeof call === 'string').length,
    2,
  )
})
