'use strict'

const cacache = require('cacache')
const cacacheMemo = require('cacache/lib/memoization.js')
const cacacheWrite = require('cacache/lib/content/write.js')
const figgyPudding = require('figgy-pudding')
const getStream = require('get-stream')
const libnpm = require('libnpm')
const npa = require('npm-package-arg')
const npmlog = require('npmlog') // NOTE: REMOVE
const path = require('path')
const pkglock = require('./pkglock.js')
const ssri = require('ssri')
const tar = require('tar')

const ONENTRY = Symbol('onEntry')
const CHECKFS = Symbol('checkFs')
const MAKEFS = Symbol('makeFs')
const FILE = Symbol('file')
const UNSUPPORTED = Symbol('unsupported')
const CHECKPATH = Symbol('checkPath')
const ONERROR = Symbol('onError')
const PENDING = Symbol('pending')
const PEND = Symbol('pend')
const UNPEND = Symbol('unpend')
const ENDED = Symbol('ended')
const MAYBECLOSE = Symbol('maybeClose')
const SKIP = Symbol('skip')

class CacacheUnpacker extends tar.Parse {
  constructor (opt) {
    if (!opt) { opt = {} }

    opt.ondone = _ => {
      this[ENDED] = true
      this[MAYBECLOSE]()
    }

    super(opt)

    this.transform = typeof opt.transform === 'function' ? opt.transform : null

    this.writable = true
    this.readable = false

    this[PENDING] = 0
    this[ENDED] = false

    this.dirCache = opt.dirCache || new Map()

    this.cwd = path.resolve(opt.cwd || process.cwd())
    this.strip = +opt.strip || 0
    this.on('entry', entry => this[ONENTRY](entry))

    if (!opt.cache) { throw new Error('cache is required') }
    this.cache = opt.cache
    this.metadata = {
      main: 'index.js',
      hasInstallScripts: false,
      hasNativeBuild: false,
      files: {}
    }
  }

  async [MAYBECLOSE] () {
    if (this[ENDED] && this[PENDING] === 0) {
      this.emit('metadata', this.metadata)
      this.emit('prefinish')
      this.emit('finish')
      this.emit('end')
      this.emit('close')
    }
  }

  [CHECKPATH] (entry) {
    if (this.strip) {
      const parts = entry.path.split(/\/|\\/)
      if (parts.length < this.strip) {
        return false
      }
      entry.path = parts.slice(this.strip).join('/')
    }

    const p = entry.path
    if (p.match(/(^|\/|\\)\.\.(\\|\/|$)/)) {
      this.warn('path contains \'..\'', p)
      return false
    }

    // absolutes on posix are also absolutes on win32
    // so we only need to test this one to get both
    if (path.win32.isAbsolute(p)) {
      const parsed = path.win32.parse(p)
      this.warn('stripping ' + parsed.root + ' from absolute path', p)
      entry.path = p.substr(parsed.root.length)
    }

    if (path.isAbsolute(entry.path)) {
      this.warn('absolute paths are not allowed', entry.path)
    }

    return true
  }

  [ONENTRY] (entry) {
    if (!this[CHECKPATH](entry)) {
      return entry.resume()
    }

    switch (entry.type) {
      case 'Directory':
      case 'GNUDumpDir':
      case 'File':
      case 'OldFile':
      case 'ContiguousFile':
      case 'Link':
      case 'SymbolicLink':
        return this[CHECKFS](entry)

      case 'CharacterDevice':
      case 'BlockDevice':
      case 'FIFO':
        return this[UNSUPPORTED](entry)
    }
  }

  [ONERROR] (er, entry) {
    this.warn(er.message, er)
    this[UNPEND]()
    entry.resume()
  }

  async [FILE] (entry) {
    try {
      const tx = this.transform ? this.transform(entry) || entry : entry
      if (tx !== entry) {
        entry.pipe(tx)
      }
      let data = await getStream.buffer(tx)
      if (entry.path === 'package.json') {
        const parsed = JSON.parse(data.toString('utf8'))
        if (parsed.main) { this.metadata.main = parsed.main }
        if (parsed.scripts) {
          if (
            parsed.scripts.install ||
            parsed.scripts.preinstall ||
            parsed.scripts.postinstall
          ) {
            this.metadata.hasInstallScripts = true
          }
        }
        if (parsed.name === 'resolve') {
          this.isResolvePkg = true
        }
        if (parsed.name === 'enhanced-resolve') {
          this.isEnhancedResolvePkg = true
        }
      }
      if (entry.path.match(/\.gyp$/)) {
        this.metadata.hasInstallScripts = true
        this.metadata.hasNativeBuild = true
      }
      const { integrity } = await cacacheWrite(this.cache, data, {
        algorithms: ['sha256']
      })
      cacacheMemo.put.byDigest(this.cache, integrity, data)
      entry.path.split(/[/\\]+/g).reduce((acc, next, i, sections) => {
        if (next === '.') { return acc }
        if (i === sections.length - 1) {
          acc[next] = integrity.toString()
        } else {
          acc[next] = acc[next] || {}
        }
        return acc[next]
      }, this.metadata.files)
      this[UNPEND]()
    } catch (err) {
      this[ONERROR](err, entry)
    }
  }

  [UNSUPPORTED] (entry) {
    this.warn('unsupported entry type: ' + entry.type, entry)
    entry.resume()
  }

  [PEND] () {
    this[PENDING]++
  }

  [UNPEND] () {
    this[PENDING]--
    this[MAYBECLOSE]()
  }

  [SKIP] (entry) {
    this[UNPEND]()
    entry.resume()
  }

  // check if a thing is there, and if so, try to clobber it
  [CHECKFS] (entry) {
    this[PEND]()
    this[MAKEFS](null, entry)
  }

  [MAKEFS] (er, entry) {
    if (er) {
      return this[ONERROR](er, entry)
    }

    switch (entry.type) {
      case 'File':
      case 'OldFile':
      case 'ContiguousFile':
        return this[FILE](entry)

      case 'Link':
      case 'SymbolicLink':
      case 'Directory':
      case 'GNUDumpDir':
        return this[SKIP](entry)
    }
  }
}

const EnsurePkgOpts = figgyPudding({
  restore: { default: true }
})

module.exports = ensurePackage
async function ensurePackage (cache, name, dep, opts) {
  opts = EnsurePkgOpts(opts)
  const spec = npa.resolve(name, dep.version)
  let resolved = dep.resolved
  let integrity = dep.integrity
  if (!dep.resolved || !dep.integrity) {
    const mani = await libnpm.manifest(spec, opts.concat({
      log: npmlog
    }))
    if (!resolved) { resolved = mani._resolved }
    if (!integrity) { integrity = mani._integrity }
  }
  if (integrity && !opts.restore) {
    const info = await cacache.get.info(cache, pkglock.depKey(name, dep))
    if (info) {
      return JSON.parse(info.metadata)
    }
  }
  const tarballStream = libnpm.tarball.stream(spec, opts.concat({
    integrity,
    resolved,
    log: npmlog,
    cache: null
  }))
  let unpacker = new CacacheUnpacker({
    strip: 1,
    cache,
    warn: err => npmlog.warn('ensure-package', err.message)
  })
  if (!integrity) {
    unpacker = ssri.integrityStream({
      algorithms: ['sha256']
    }).on('integrity', i => { integrity = i }).pipe(unpacker)
  }
  return new Promise((resolve, reject) => {
    unpacker.on('error', reject)
    tarballStream.on('error', reject)
    let metadata
    unpacker.on('metadata', (m) => { metadata = m })
    unpacker.on('finish', async () => {
      try {
        const key = pkglock.depKey(name, dep)
        const doc = Object.assign({}, metadata, {
          name: name,
          version: dep.version,
          integrity: integrity.toString(),
          resolved
        })
        await cacache.put(cache, key, '.', {
          memoize: true,
          algorithms: ['sha256'],
          metadata: JSON.stringify(doc)
        })
        resolve(doc)
      } catch (err) {
        reject(err)
      }
    })
    tarballStream.pipe(unpacker)
  })
}
