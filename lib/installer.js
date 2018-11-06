'use strict'

const BB = require('bluebird')

const binLink = require('bin-links')
const buildLogicalTree = require('npm-logical-tree')
const config = require('./config.js')
const ensurePackage = require('./ensure-package.js')
const fs = require('graceful-fs')
const getPrefix = require('find-npm-prefix')
const glob = BB.promisify(require('glob'))
const { runScript } = require('libnpm')
const lockVerify = require('lock-verify')
const mkdirp = BB.promisify(require('mkdirp'))
const npa = require('npm-package-arg')
const npmlog = require('npmlog')
const path = require('path')
const readPkgJson = BB.promisify(require('read-package-json'))
const rimraf = BB.promisify(require('rimraf'))
const { spawn } = require('child_process')
const ssri = require('ssri')
const stringifyPkg = require('stringify-package')

const readFileAsync = BB.promisify(fs.readFile)
const realpathAsync = BB.promisify(fs.realpath)
const statAsync = BB.promisify(fs.stat)
const symlinkAsync = BB.promisify(fs.symlink)
const writeFileAsync = BB.promisify(fs.writeFile)

class Installer {
  constructor (opts) {
    this.opts = config(opts)

    // Stats
    this.startTime = Date.now()
    this.runTime = 0
    this.timings = { scripts: 0 }
    this.pkgCount = 0

    // Misc
    this.log = this.opts.log ||
      ((level, type, ...msgs) => process.emit(level, type, ...msgs))

    this.pkg = null
    this.tree = null
    this.pkgMap = null
    this.failedDeps = new Set()
  }

  async timedStage (name) {
    const start = Date.now()
    const ret = await this[name].apply(this, [].slice.call(arguments, 1))
    this.timings[name] = Date.now() - start
    this.log('info', name, `Done in ${this.timings[name] / 1000}s`)
    return ret
  }

  async run () {
    try {
      await this.timedStage('prepare')
      if (!this.pkgMap) {
        this.log('info', 'Generating new package map')
        await this.timedStage('fetchTree', this.tree)
        this.pkgMap = await this.timedStage('buildPackageNameMap', this.tree)
        await this.timedStage('writePackageMap', this.pkgMap)
        await this.timedStage('buildTree', this.tree)
        await this.tinkifyBins()
        // await this.timedStage('garbageCollect', this.tree)
        await this.timedStage('runScript', 'prepublish', this.pkg, this.prefix)
        await this.timedStage('runScript', 'prepare', this.pkg, this.prefix)
      } else {
        this.log('info', 'Found valid existing package map. Skipping fetch.')
      }
      await this.timedStage('teardown')
      this.runTime = Date.now() - this.startTime
      this.log(
        'info',
        'run-scripts',
        `total script time: ${this.timings.scripts / 1000}s`
      )
      this.log(
        'info',
        'run-time',
        `total run time: ${this.runTime / 1000}s`
      )
      if (this.pkgCount) {
        this.log(
          'info',
          'package-count',
          `total packages: ${this.pkgCount}`
        )
      }
    } catch (err) {
      if (err.message.match(/aggregate error/)) {
        throw err[0]
      } else {
        throw err
      }
    } finally {
      await this.timedStage('teardown')
    }
    this.opts = null
    return this
  }

  async prepare () {
    this.log('info', 'prepare', 'initializing installer')

    const prefix = (
      this.opts.prefix && this.opts.global
        ? this.opts.prefix
        // There's some Special™ logic around the `--prefix` config when it
        // comes from a config file or env vs when it comes from the CLI
        : process.argv.some(arg => arg.match(/^\s*--prefix\s*/i))
          ? this.opts.prefix
          : await getPrefix(process.cwd())
    )
    this.prefix = prefix
    this.log('verbose', 'prepare', 'installation prefix: ' + prefix)
    await BB.join(
      readJson(prefix, 'package.json'),
      readJson(prefix, 'package-lock.json', true),
      readJson(prefix, 'npm-shrinkwrap.json', true),
      readJson(prefix, '.package-map.json', true),
      (pkg, lock, shrink, map) => {
        if (shrink) {
          this.log('verbose', 'prepare', 'using npm-shrinkwrap.json')
        } else if (lock) {
          this.log('verbose', 'prepare', 'using package-lock.json')
        }
        pkg._shrinkwrap = shrink || lock
        this.pkg = pkg
        this.pkgMap = map
      }
    )
    await this.checkLock()
    this.tree = buildLogicalTree(this.pkg, this.pkg._shrinkwrap)
    this.log('silly', 'tree', this.tree)
    this.expectedTotal = 0
    this.tree.forEach((dep, next) => {
      this.expectedTotal++
      next()
    })
  }

  async teardown () {
    this.log('verbose', 'teardown', 'shutting down')
  }

  async checkLock () {
    this.log('verbose', 'checkLock', 'verifying package-lock data')
    const pkg = this.pkg
    const prefix = this.prefix
    if (
      this.pkgMap &&
      !ssri.checkData(
        JSON.stringify(pkg._shrinkwrap),
        this.pkgMap.lockfile_integrity
      )
    ) {
      this.pkgMap = null
    }
    if (!pkg._shrinkwrap || !pkg._shrinkwrap.lockfileVersion) {
      this.log('warn', 'No lockfile detected. Regenerating.')
      await this.npmInstall()
    }
    if (!pkg._shrinkwrap || !pkg._shrinkwrap.lockfileVersion) {
      throw new Error(`npm install to generate package-lock.json failed. This is a bug.`)
    }
    const result = await lockVerify(prefix)
    if (result.status) {
      result.warnings.forEach(w => this.log('warn', 'lockfile', w))
    } else {
      this.log('warn', 'lockfile', 'some package-lock dependencies are not in sync with package.json.\n' + result.errors.join('\n'))
      if (result.warnings.length) {
        this.log('warn', 'lockfile', result.warnings.map(w => 'Warning: ' + w).join('\n'))
      }
      this.log('warn', 'lockfile', 'Updating package-lock.')
      await this.npmInstall()
    }
  }

  async npmInstall () {
    await BB.fromNode(cb => {
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      spawn(npmBin, [
        'install',
        '--package-lock',
        '--package-lock-only'
      ], {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit'
      }).on('error', cb).on('close', code => cb(null, code))
    })
    this.pkg._shrinkwrap = await readJson(this.prefix, 'package-lock.json')
  }

  async fetchTree (tree) {
    this.log('verbose', 'fetchTree', 'making sure all required deps are in the cache')
    // const cg = this.log('newItem', 'fetchTree', this.expectedTotal)
    await tree.forEachAsync(async (dep, next) => {
      if (!this.checkDepEnv(dep)) { return }
      const depPath = dep.path(this.prefix)
      const spec = npa.resolve(dep.name, dep.version, this.prefix)
      if (dep.isRoot) {
        return next()
      } else if (spec.type === 'directory') {
        const relative = path.relative(path.dirname(depPath), spec.fetchSpec)
        this.log('silly', 'fetchTree', `${dep.name}@${spec.fetchSpec} -> ${depPath} (symlink)`)
        await mkdirp(path.dirname(depPath))
        try {
          await symlinkAsync(relative, depPath, 'junction')
        } catch (e) {
          await rimraf(depPath)
          await symlinkAsync(relative, depPath, 'junction')
        }
        await next()
        this.pkgCount++
        // cg.completeWork(1)
      } else {
        this.log('silly', 'fetchTree', `${dep.name}@${dep.version} -> ${depPath}`)
        if (dep.bundled) {
          // cg.completeWork(1)
          this.pkgCount++
          await next()
        } else {
          dep.metadata = await ensurePackage(
            this.opts.cache, dep.name, dep, this.opts.concat({
              warn: msg => this.opts.log('warn', msg)
            })
          )
          // cg.completeWork(1)
          this.pkgCount++
          await next()
        }
      }
    }, { concurrency: 50, Promise: BB })
    // cg.finish()
  }

  checkDepEnv (dep) {
    const includeDev = (
      this.opts.dev ||
      this.opts.development ||
      (
        !/^prod(uction)?$/.test(this.opts.only) &&
        !this.opts.production
      ) ||
      /^dev(elopment)?$/.test(this.opts.only) ||
      /^dev(elopment)?$/.test(this.opts.also)
    )
    const includeProd = !/^dev(elopment)?$/.test(this.opts.only)
    return (dep.dev && includeDev) || (!dep.dev && includeProd)
  }

  async buildTree (tree) {
    this.log('verbose', 'buildTree', 'finalizing tree and running scripts')
    await tree.forEachAsync(async (dep, next) => {
      if (!this.checkDepEnv(dep)) { return }
      try {
        const spec = npa.resolve(dep.name, dep.version)
        const depPath = dep.path(this.prefix)
        const pkg = await readPkgJson(path.join(depPath, 'package.json'))
        this.log('silly', 'buildTree', `linking ${spec}`)
        await this.runScript('preinstall', pkg, depPath)
        await next() // build children between preinstall and binLink
        // Don't link root bins
        if (
          dep.isRoot ||
          !(pkg.bin || pkg.man || (pkg.directories && pkg.directories.bin))
        ) {
          // We skip the relatively expensive readPkgJson if there's no way
          // we'll actually be linking any bins or mans
          return
        }
        const pkgJson = await readPkgJson(path.join(depPath, 'package.json'))
        await binLink(pkgJson, depPath, false, {
          force: this.opts.force,
          ignoreScripts: this.opts['ignore-scripts'],
          log: npmlog,
          name: pkg.name,
          pkgId: pkg.name + '@' + pkg.version,
          prefix: this.prefix,
          prefixes: [this.prefix]
        })
        await this.runScript('install', pkg, depPath)
        await this.runScript('postinstall', pkg, depPath)
      } catch (e) {
        if (dep.optional) {
          this.failedDeps.add(dep)
        } else {
          return BB.reject(e)
        }
      }
    }, { concurrency: 50, Promise: BB })
  }

  async tinkifyBins () {
    const bins = await glob('./node_modules/**/.bin/*')
    return BB.map(bins, async bin => {
      const real = await realpathAsync(bin)
      const data = (await readFileAsync(real, 'utf8')).replace(/(#!\s*.*\s*)node/g, '$1tink sh --')
      await writeFileAsync(real, data, 'utf8')
    }, { concurrency: 50, Promise: BB })
  }

  async updateInstallScript (dep, pkg) {
    const depPath = dep.path(this.prefix)
    let stat
    try {
      stat = statAsync(path.join(depPath, 'binding.gyp'))
    } catch (err) {
      if (err.code !== 'ENOENT') { throw err }
    }
    if (stat) {
      if (!pkg.scripts) {
        pkg.scripts = {}
      }
      pkg.scripts.install = 'node-gyp rebuild'
    }
    return pkg
  }

  // A cute little mark-and-sweep collector!
  async garbageCollect (tree) {
    if (!this.failedDeps.size) { return }
    const purged = await sweep(
      tree,
      this.prefix,
      mark(tree, this.failedDeps)
    )
    this.purgedDeps = purged
    this.pkgCount -= purged.size
  }

  async runScript (stage, pkg, pkgPath) {
    const start = Date.now()
    if (!this.opts['ignore-scripts']) {
      // TODO(mikesherov): remove pkg._id when npm-lifecycle no longer relies on it
      pkg._id = pkg.name + '@' + pkg.version
      const ret = await runScript(pkg, stage, pkgPath, {
        dir: this.prefix,
        log: npmlog
      })
      this.timings.scripts += Date.now() - start
      return ret
    }
  }

  async buildPackageNameMap (tree) {
    this.log('verbose', 'buildPkgMap', 'Building package name map for project')
    const lockStr = JSON.stringify(this.pkg._shrinkwrap)
    const lockHash = ssri.fromData(lockStr, { algorithms: ['sha256'] })
    const pkgMap = {
      'lockfile_integrity': lockHash.toString(),
      'path_prefix': '/node_modules'
    }
    tree.forEach((dep, next) => {
      if (dep.isRoot) { return next() }
      const addr = dep.address.split(':')
      addr.reduce((acc, name, i) => {
        if (i > 0) {
          acc.scopes = acc.scopes || {}
          const key = addr[i - 1]
          acc.scopes[key] = acc.scopes[key] || {
            'path_prefix': '/node_modules'
          }
          acc = acc.scopes[key]
        }
        acc.packages = acc.packages || {}
        acc.packages[name] = acc.packages[name] || {}
        if (i === addr.length - 1) {
          Object.assign(acc.packages[name], dep.metadata)
        }
        return acc
      }, pkgMap)
      next()
    })
    return pkgMap
  }

  async writePackageMap (map) {
    await writeFileAsync(path.join(this.prefix, '.package-map.json'), stringifyPkg(map))
  }
}
module.exports = treeFrog
async function treeFrog (opts) {
  return new Installer(opts).run()
}
module.exports.Installer = Installer

function mark (tree, failed) {
  const liveDeps = new Set()
  tree.forEach((dep, next) => {
    if (!failed.has(dep)) {
      liveDeps.add(dep)
      next()
    }
  })
  return liveDeps
}

async function sweep (tree, prefix, liveDeps) {
  const purged = new Set()
  await tree.forEachAsync(async (dep, next) => {
    await next()
    if (
      !dep.isRoot && // never purge root! 🙈
      !liveDeps.has(dep) &&
      !purged.has(dep)
    ) {
      purged.add(dep)
      await rimraf(dep.path(prefix))
    }
  }, { concurrency: 50, Promise: BB })
  return purged
}

function stripBOM (str) {
  return str.replace(/^\uFEFF/, '')
}

module.exports._readJson = readJson
async function readJson (jsonPath, name, ignoreMissing) {
  try {
    const str = await readFileAsync(path.join(jsonPath, name), 'utf8')
    return JSON.parse(stripBOM(str))
  } catch (err) {
    if (err.code !== 'ENOENT' || !ignoreMissing) {
      throw err
    }
  }
}
