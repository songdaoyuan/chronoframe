// Run in the ChronoFrame image after transpiling display.ts/privacy.ts to /verify.
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { eraseVideoFileLocation } = require('/verify/privacy.cjs')
const { VIDEO_FALLBACK_SCALE } = require('/verify/display.cjs')
const run = (tool, args) =>
  execFileSync(`/usr/bin/${tool}`, args, { encoding: 'utf8', timeout: 60000 })
const probe = (file) =>
  JSON.parse(
    run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]),
  ).streams[0]

;(async () => {
  for (const extension of ['mov', 'mp4']) {
    const file = `/tmp/privacy.${extension}`
    run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-y',
      file,
    ])
    run('exiftool', [
      '-overwrite_original',
      '-Keys:GPSCoordinates=+30.1234+120.5678+005.0/',
      '-XMP:GPSLatitude=30.1234',
      '-XMP:GPSLongitude=120.5678',
      file,
    ])
    const before = JSON.parse(
      run('exiftool', ['-json', '-n', '-GPS*', file]),
    )[0]
    assert.ok(before.GPSCoordinates || before.GPSLatitude)
    const checksum = run('ffmpeg', [
      '-v',
      'error',
      '-i',
      file,
      '-f',
      'framemd5',
      '-',
    ])
    await eraseVideoFileLocation(file)
    const after = JSON.parse(
      run('exiftool', ['-json', '-n', '-ee', '-GPS*', file]),
    )[0]
    assert.deepEqual(Object.keys(after), ['SourceFile'])
    assert.equal(
      run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-']),
      checksum,
    )
    console.log(`${extension}: GPS removed, decoded frames unchanged`)
  }
  for (const [input, width, height] of [
    ['1080x1920', 1080, 1920],
    ['720x1280', 720, 1280],
    ['3840x2160', 1920, 1080],
  ]) {
    run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=size=${input}`,
      '-frames:v',
      '1',
      '-vf',
      VIDEO_FALLBACK_SCALE,
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-y',
      '/tmp/scaled.mp4',
    ])
    const result = probe('/tmp/scaled.mp4')
    assert.equal(result.width, width)
    assert.equal(result.height, height)
    console.log(`${input}: bounded output ${width}x${height}`)
  }
  run('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-y',
    '/tmp/base.mov',
  ])
  run('ffmpeg', [
    '-v',
    'error',
    '-i',
    '/tmp/base.mov',
    '-c',
    'copy',
    '-metadata:s:v:0',
    'rotate=90',
    '-y',
    '/tmp/portrait.mov',
  ])
  run('exiftool', [
    '-overwrite_original',
    '-Keys:GPSCoordinates=+30.1234+120.5678+005.0/',
    '-Rotation=90',
    '/tmp/portrait.mov',
  ])
  assert.ok(
    probe('/tmp/portrait.mov').side_data_list.some(
      (data) => Math.abs(data.rotation) === 90,
    ),
  )
  fs.copyFileSync('/tmp/portrait.mov', '/verify/portrait-gps.mov')
  console.log('Created rotated portrait GPS fixture for browser upload')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
