const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { compile, createSSRApp, h } = require('vue')
const { renderToString } = require('vue/server-renderer')

function load(file, globals = {}, overrides = {}) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const exports = {}
  const localRequire = (name) => {
    if (name in overrides) return overrides[name]
    if (name.startsWith('.'))
      return load(path.resolve(path.dirname(file), `${name}.ts`))
    return require(name)
  }
  new Function('require', 'exports', ...Object.keys(globals), output)(
    localRequire,
    exports,
    ...Object.values(globals),
  )
  return exports
}

test('portrait and landscape metadata use display dimensions', () => {
  const { parseVideoTags } = load('server/services/video/metadata.ts')
  for (const rotation of [90, -90, 270]) {
    const result = parseVideoTags({
      ImageWidth: 1920,
      ImageHeight: 1080,
      Rotation: rotation,
    })
    assert.equal(result.width, 1080)
    assert.equal(result.height, 1920)
    assert.equal(result.exif.ImageWidth, 1080)
  }
  assert.equal(
    parseVideoTags({ ImageWidth: 1920, ImageHeight: 1080, Rotation: 180 })
      .width,
    1920,
  )
})

test('thumbnail fallback never covers an existing image', async () => {
  const source = fs.readFileSync(
    'app/components/photo/GalleryThumbnail.vue',
    'utf8',
  )
  for (const [thumbnailUrl, thumbnailHash, fallback] of [
    ['/image.webp', null, false],
    [null, 'hash', false],
    [null, null, true],
  ]) {
    const app = createSSRApp({
      render: compile(source.match(/<button[\s\S]*?<\/button>/)[0]),
      data: () => ({
        thumbnailList: [
          {
            id: 'test',
            title: 'test',
            storageKey: 'test.jpg',
            thumbnailUrl,
            thumbnailHash,
          },
        ],
        currentThumbnailSize: 64,
        onThumbnailClick() {},
        isVideoStorageKey: () => false,
      }),
    })
    app.component('Icon', { render: () => h('i') })
    app.component('ThumbHash', { render: () => h('b') })
    const html = await renderToString(app)
    assert.equal(html.includes('bg-gray-700'), fallback)
  }
})

test('reindex keeps database-only rating and edited or removed location', async () => {
  for (const latitude of [22, null]) {
    let updates
    const photo = {
      id: 'video_test',
      storageKey: 'test.mov',
      latitude,
      longitude: latitude === null ? null : 114,
      exif: {
        Rating: 5,
        GPSLatitude: latitude,
        GPSLongitude: latitude === null ? null : 114,
      },
    }
    const db = {
      select: () => db,
      from: () => db,
      where: () => db,
      limit: () => Promise.resolve([photo]),
      get: () => photo,
      update: () => db,
      set: (value) => {
        updates = value
        return db
      },
    }
    const globals = {
      eventHandler: (x) => x,
      requireUserSession: async () => {},
      readBody: async () => ({ action: 'single-reindex', photoId: photo.id }),
      useDB: () => db,
      tables: { photos: {} },
      useStorageProvider: () => ({
        storageProvider: { get: async () => Buffer.from('test') },
      }),
      logger: { chrono: { info() {}, error() {} } },
    }
    const handler = load('server/api/photos/exif/reindex.post.ts', globals, {
      '~~/server/services/image/exif': {},
      '~~/shared/utils/media': { isVideoStorageKey: () => true },
      '~~/server/services/video/metadata': {
        extractVideoMetadataFromBuffer: async (
          _buffer,
          _key,
          includeLocation,
        ) => {
          assert.equal(includeLocation, false)
          return {
            exif: { VideoCodec: 'HEVC' },
            dateTaken: null,
            latitude: 30,
            longitude: 120,
            width: 1080,
            height: 1920,
          }
        },
      },
    }).default
    await handler({})
    assert.equal(updates.exif.Rating, 5)
    assert.equal(updates.exif.GPSLatitude, latitude)
    assert.equal('latitude' in updates, false)
    assert.equal('longitude' in updates, false)
    assert.equal(updates.aspectRatio, 1080 / 1920)
  }
})

test('preview cache coalesces requests, invalidates versions, bounds memory and retries failures', async () => {
  const { PreviewCache } = load('server/services/image/preview-cache.ts')
  const cache = new PreviewCache(4)
  let renders = 0
  const render = async () => {
    renders++
    return Buffer.from('1234')
  }
  await Promise.all(
    Array.from({ length: 8 }, () => cache.get('photo:v1', render)),
  )
  await cache.get('photo:v1', render)
  assert.equal(renders, 1)
  await cache.get('photo:v2', render)
  await cache.get('photo:v1', render)
  assert.equal(renders, 3)
  await assert.rejects(
    cache.get('failed', async () => {
      throw new Error('storage failure')
    }),
  )
  await cache.get('failed', render)
  const expired = new PreviewCache(4, -1)
  await expired.get('photo', render)
  await expired.get('photo', render)
  assert.equal(renders, 6)
})

test('single and batch queues preserve per-upload video privacy overrides', async () => {
  for (const batch of [false, true]) {
    for (const eraseLocation of [false, true]) {
      let received
      const payload = { type: 'video', storageKey: 'test.mov', eraseLocation }
      const handler = load(
        `server/api/queue/${batch ? 'add-tasks' : 'add-task'}.post.ts`,
        {
          defineEventHandler: (x) => x,
          requireUserSession: async () => {},
          readValidatedBody: async (_event, parse) =>
            parse(batch ? { tasks: [{ payload }] } : { payload }),
        },
      ).default
      globalThis.__workerPool = {
        addTask: async (value) => {
          received = value
          return 1
        },
      }
      try {
        await handler({})
      } finally {
        delete globalThis.__workerPool
      }
      assert.equal(received.eraseLocation, eraseLocation)
    }
  }
})

test('saving a sanitized source does not duplicate or corrupt storage prefixes', async () => {
  const { saveVideoSource } = load('server/services/video/privacy.ts')
  let saved
  await saveVideoSource(
    {
      config: { prefix: 'photos/' },
      create: async (...args) => {
        saved = args
      },
    },
    'photos/trip/photos/test.MOV',
    Buffer.from('clean'),
  )
  assert.equal(saved[0], 'trip/photos/test.MOV')
  assert.equal(saved[2], 'video/quicktime')
})
