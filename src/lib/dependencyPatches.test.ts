import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

// Resolve the patched transitive dependencies actually used by tapimo's docs stack.
const require = createRequire(import.meta.url)
const tapimoRequire = createRequire(require.resolve('tapimo/client'))
const vocsRequire = createRequire(tapimoRequire.resolve('vocs'))

test.each(['cjs', 'mjs'])('image-size %s preserves supported image metadata', async (extension) => {
  const path = vocsRequire.resolve('image-size').replace(/\.cjs$/, `.${extension}`)
  const { imageSize } = (await import(pathToFileURL(path).href)) as {
    imageSize: (input: Uint8Array) => { height: number; width: number }
  }

  const icns = Buffer.alloc(16 + 16 * 16 * 4)
  icns.write('icns')
  icns.writeUInt32BE(icns.length, 4)
  icns.write('icp4', 8)
  icns.writeUInt32BE(icns.length - 8, 12)
  expect(imageSize(icns)).toMatchObject({ height: 16, width: 16 })

  const dimensions = Buffer.alloc(12)
  dimensions.writeUInt32BE(32, 4)
  dimensions.writeUInt32BE(24, 8)
  const heif = Buffer.concat([
    box('ftyp', Buffer.from('heic\0\0\0\0heic')),
    box(
      'meta',
      Buffer.concat([Buffer.alloc(4), box('iprp', box('ipco', box('ispe', dimensions)))]),
    ),
  ])
  expect(imageSize(heif)).toMatchObject({ height: 24, width: 32 })

  // Minimal codestream size metadata for a 1x1 image, in a standard JXL container.
  const codestream = Buffer.from([0xff, 0x0a, 0, 0, 0, 0, 0, 0])
  const header = Buffer.concat([
    box('JXL ', Buffer.from([0x0d, 0x0a, 0x87, 0x0a])),
    box('ftyp', Buffer.from('jxl \0\0\0\0jxl ')),
  ])
  expect(imageSize(Buffer.concat([header, box('jxlc', codestream)]))).toMatchObject({
    height: 1,
    width: 1,
  })
  expect(
    imageSize(Buffer.concat([header, box('jxlp', Buffer.concat([Buffer.alloc(4), codestream]))])),
  ).toMatchObject({ height: 1, width: 1 })
})

test('the TOML upgrade preserves frontmatter values', () => {
  const frontmatterRequire = createRequire(vocsRequire.resolve('remark-mdx-frontmatter'))
  const toml = frontmatterRequire('toml') as { parse: (input: string) => unknown }
  expect(toml.parse('title = "Guide"\n[page]\ndraft = false\ntags = ["api", "tempo"]')).toEqual({
    page: { draft: false, tags: ['api', 'tempo'] },
    title: 'Guide',
  })
})

function box(type: string, payload: Buffer) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(payload.length + header.length)
  header.write(type, 4)
  return Buffer.concat([header, payload])
}
