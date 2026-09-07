import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGithubClient, type Codespace } from '../src/GithubApi.ts'

const codespace: Codespace = {
  name: 'happy-cat',
  state: 'Shutdown',
  repository: { full_name: 'owner/project' },
}
const fixture = (
  respond: (url: URL, init: RequestInit) => Response | Promise<Response>,
) => {
  const controller = new AbortController()
  const requests: Array<{ url: URL; init: RequestInit }> = []
  const client = createGithubClient(
    'github-test-token',
    controller.signal,
    async (input, init = {}) => {
      const url = new URL(String(input))
      requests.push({ url, init })
      assert.equal(url.origin, 'https://api.github.com')
      assert.equal(
        new Headers(init.headers).get('Authorization'),
        'Bearer github-test-token',
      )
      assert.equal(
        new Headers(init.headers).get('X-GitHub-Api-Version'),
        '2022-11-28',
      )
      assert.equal(init.redirect, 'error')
      assert.equal(init.credentials, 'omit')
      assert.equal(url.searchParams.has('token'), false)
      return respond(url, init)
    },
  )
  return { client, controller, requests }
}

test('direct creation, start and stop use GitHub paths, native bodies and empty responses', async () => {
  const { client, requests } = fixture((url) =>
    url.pathname.startsWith('/repos/')
      ? Response.json(codespace, { status: 201 })
      : new Response(null, { status: 204 }),
  )
  try {
    assert.deepEqual(await client.create('owner/project'), codespace)
    await client.start(codespace.name)
    await client.stop(codespace.name)
    assert.deepEqual(
      requests.map(({ url, init }) => [init.method, url.pathname, init.body]),
      [
        ['POST', '/repos/owner/project/codespaces', '{}'],
        ['POST', '/user/codespaces/happy-cat/start', undefined],
        ['POST', '/user/codespaces/happy-cat/stop', undefined],
      ],
    )
  } finally {
    client.dispose()
  }
})

test('repository pagination consumes native arrays and preserves picker metadata', async () => {
  const { client, requests } = fixture((url) => {
    assert.equal(url.pathname, '/user/repos')
    assert.equal(
      url.searchParams.get('affiliation'),
      'owner,collaborator,organization_member',
    )
    const page = Number(url.searchParams.get('page'))
    return Response.json(
      page === 1
        ? Array.from({ length: 100 }, (_, i) => ({
            full_name: `owner/repo-${i}`,
            private: false,
          }))
        : [{ full_name: 'owner/private', private: true, ignored: 'metadata' }],
    )
  })
  try {
    const repositories = await client.listRepositories()
    assert.equal(repositories.length, 101)
    assert.deepEqual(repositories.at(-1), {
      full_name: 'owner/private',
      private: true,
    })
    assert.equal(requests.length, 2)
  } finally {
    client.dispose()
  }
})

test('Codespace listing follows total count over multiple pages', async () => {
  const { client, requests } = fixture((url) =>
    Response.json({
      total_count: 101,
      codespaces:
        url.searchParams.get('page') === '1'
          ? Array.from({ length: 100 }, () => codespace)
          : [codespace],
    }),
  )
  try {
    assert.equal((await client.list()).length, 101)
    assert.deepEqual(
      requests.map(({ url }) => url.pathname),
      ['/user/codespaces', '/user/codespaces'],
    )
  } finally {
    client.dispose()
  }
})

test('startup starts once and polls until available', async () => {
  let polls = 0
  const { client, requests } = fixture((_url, init) =>
    init.method === 'POST'
      ? new Response(null, { status: 204 })
      : Response.json({
          ...codespace,
          state: ++polls === 1 ? 'Starting' : 'Available',
        }),
  )
  try {
    await client.ensureAvailable(codespace)
    assert.equal(polls, 2)
    assert.equal(
      requests.filter(({ init }) => init.method === 'POST').length,
      1,
    )
    assert.equal(requests[1].url.pathname, '/user/codespaces/happy-cat')
  } finally {
    client.dispose()
  }
})

test('failed startup reports state without retrying start', async () => {
  const { client, requests } = fixture(() =>
    Response.json({ ...codespace, state: 'Failed' }),
  )
  try {
    await assert.rejects(
      client.ensureAvailable({ ...codespace, state: 'Starting' }),
      /Codespace is Failed/,
    )
    assert.equal(requests.length, 1)
  } finally {
    client.dispose()
  }
})

test('invalid token and missing scope require authorization and discard the token', async () => {
  for (const response of [
    new Response(null, { status: 401 }),
    Response.json([], { headers: { 'x-oauth-scopes': 'repo, user:email' } }),
  ]) {
    const { client, requests } = fixture(() => response)
    await assert.rejects(client.list(), /Authorize GitHub Access/)
    await assert.rejects(client.list(), /command has finished/)
    assert.equal(requests.length, 1)
  }
})

test('policy and rate limit errors remain useful and mutations never retry', async () => {
  for (const status of [403, 429, 502]) {
    for (const method of ['create', 'start', 'stop'] as const) {
      const { client, requests } = fixture(() =>
        Response.json(
          { message: 'GitHub policy or quota message' },
          { status, headers: { 'x-oauth-scopes': 'repo, codespace' } },
        ),
      )
      try {
        await assert.rejects(
          client[method](method === 'create' ? 'owner/project' : 'happy-cat'),
          /GitHub policy or quota message/,
        )
        assert.equal(requests.length, 1)
      } finally {
        client.dispose()
      }
    }
  }
})

test('invalid repository and Codespace names cannot change the request target', async () => {
  const { client, requests } = fixture(() => Response.json({}))
  try {
    for (const value of [
      '../user',
      'owner/..',
      'https://evil.example',
      'owner/name?token=secret',
      'owner/name/extra',
    ])
      assert.throws(() => client.create(value), /owner\/name/)
    for (const value of [
      '../other',
      'https://evil.example',
      'name?token=secret',
      '',
    ])
      await assert.rejects(client.stop(value), /Invalid Codespace/)
    assert.equal(requests.length, 0)
  } finally {
    client.dispose()
  }
})

test('cancelled commands abort requests and cannot reuse credentials', async () => {
  const { client, controller, requests } = fixture(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          'abort',
          () => reject(new Error('cancelled')),
          { once: true },
        )
      }),
  )
  const pending = client.list()
  controller.abort()
  await assert.rejects(pending, /cancelled/)
  await assert.rejects(client.stop('happy-cat'), /abort/i)
  assert.equal(requests.length, 1)
})

test('cancellation interrupts startup polling and disposal prevents later requests', async () => {
  const { client, controller, requests } = fixture(() =>
    Response.json({ ...codespace, state: 'Starting' }),
  )
  const pending = client.ensureAvailable({ ...codespace, state: 'Starting' })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, /cancelled/)
  assert.equal(requests.length, 1)
  const other = fixture(() => Response.json([]))
  other.client.dispose()
  await assert.rejects(other.client.list(), /command has finished/)
  assert.equal(other.requests.length, 0)
})

test('startup has a bounded deadline', async (t) => {
  let now = 0
  t.mock.method(Date, 'now', () => (now += 5 * 60_000 + 1))
  const { client, requests } = fixture(() => Response.json({}))
  try {
    await assert.rejects(
      client.ensureAvailable({ ...codespace, state: 'Starting' }),
      /startup timed out/,
    )
    assert.equal(requests.length, 0)
  } finally {
    client.dispose()
  }
})
