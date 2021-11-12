const { EventEmitter } = require('events')
const { crypto } = require('hypercore-channels')
const Hypercore = require('hypercore')
const Keys = require('./keys')

const CORES_DIR = 'cores'
const KEYS_DIR = 'keys'
const USERDATA_CHANNEL_KEY = '@channelstore/name'
const USERDATA_NAMESPACE_KEY = '@channelstore/namespace'
const USERDATA_PEERKEY_KEY = '@channelstore/peerkey'
const USERDATA_PRIVATE_KEY = '@channelstore/private'
const DEFAULT_NAMESPACE = '@channelstore/default'

module.exports = class Store extends EventEmitter {
  constructor (storage, opts = {}) {
    super()

    this.storage = Hypercore.defaultStorage(storage, { lock: KEYS_DIR + '/default' })

    this.cores = opts._cores || new Map()
    this.keys = opts.keys

    this._namespace = opts._namespace || DEFAULT_NAMESPACE
    this._replicationStreams = opts._streams || []

    if (typeof opts.secretKey === 'string') {
      opts.secretKey = Buffer.from(opts.secretKey, 'hex')
    }
    this._opening = opts._opening ? opts._opening.then(() => this._open()) : this._open(opts)
    this._opening.catch(noop)
    this.ready = () => this._opening
  }

  async _open (opts) {
    if (this.keys) {
      this.keys = await this.keys // opts.keys can be a Promise that resolves to a Keys instance
    } else {
      this.keys = await Keys.fromStorage(p => this.storage(KEYS_DIR + '/' + p), opts)
    }
    this.key = this.keys.publicKey
    this.secretKey = this.keys.secretKey
    this.discoveryKey = this.keys.discoveryKey
  }

  async _generateKeys (opts) {
    return {
      keyPair: {
        publicKey: opts.key,
        secretKey: opts.secretKey
      },
      discoveryKey: opts.key ? crypto.discoveryKey(opts.key) : opts.discoveryKey
    }
  }

  async _postload (core) {
    // const channel = await core.getUserData(USERDATA_CHANNEL_KEY)
    // if (!channel) return
    //
    // // const namespace = await core.getUserData(USERDATA_NAMESPACE_KEY)
    // // const { publicKey, sign } = await this.keys.keyPair()
    // // if (!publicKey.equals(core.key)) throw new Error('Stored core key does not match the provided channel')
    //
    // // TODO: Should Hypercore expose a helper for this, or should postload return keypair/sign?
    // core.sign = m => crypto.sign()
    // core.key = publicKey
    // core.writable = true
  }

  async _preload (opts) {
    await this.ready()

    const { discoveryKey, keyPair, sign } = await this._generateKeys(opts)
    const id = discoveryKey.toString('hex')

    while (this.cores.has(id)) {
      const existing = this.cores.get(id)
      if (existing) {
        if (!existing.closing) return { from: existing, keyPair, sign }
        await existing.close()
      }
    }

    const userData = {}
    if (opts.channel) {
      userData[USERDATA_CHANNEL_KEY] = Buffer.from(opts.channel)
      userData[USERDATA_NAMESPACE_KEY] = Buffer.from(this._namespace)
      if (opts.peerKey) {
        userData[USERDATA_PEERKEY_KEY] = Buffer.from(opts.peerKey)
        userData[USERDATA_PRIVATE_KEY] = opts.private ? Buffer.from([1]) : Buffer.from([0])
      }
    }

    // No more async ticks allowed after this point -- necessary for caching

    const storageRoot = [CORES_DIR, id.slice(0, 2), id.slice(2, 4), id].join('/')
    const core = new Hypercore(p => this.storage(storageRoot + '/' + p), {
      autoClose: true,
      keyPair,
      userData,
      // sign: null,
      // postload: this._postload.bind(this),
      createIfMissing: !!opts.keyPair
    })

    this.cores.set(id, core)
    for (const stream of this._replicationStreams) {
      core.replicate(stream)
    }
    core.once('close', () => {
      this.cores.delete(id)
    })

    return { from: core, keyPair, sign }
  }

  writable (opts = {}) {
    opts.channel = opts.channel || '1'
    const writable = this.keys.writable(opts.channel, opts.peerKey)
    const opts2 = {
      ...opts,
      ...writable
    }
    return new Hypercore(null, {
      ...opts2,
      // channel: undefined,
      // peerKey: undefined,
      preload: () => this._preload(opts2)
    })
  }

  readable (opts = {}) {
    opts.channel = opts.channel || '1'
    const readable = this.keys.readable(opts.channel, opts.peerKey, opts.private)
    const opts2 = {
      ...opts,
      ...readable
    }
    return new Hypercore(null, {
      ...opts2,
      // channel: undefined,
      // peerKey: undefined,
      // private: undefined,
      preload: () => this._preload(opts2)
    })
  }

  replicate (opts = {}) {
    const stream = isStream(opts) ? opts : (opts.stream || Hypercore.createProtocolStream(opts))
    for (const core of this.cores.values()) {
      core.replicate(stream)
    }
    stream.on('discovery-key', discoveryKey => {
      const core = this.get({ discoveryKey })
      core.ready().then(() => {
        core.replicate(stream)
      }, () => {
        stream.close(discoveryKey)
      })
    })
    this._replicationStreams.push(stream)
    stream.once('close', () => {
      this._replicationStreams.splice(this._replicationStreams.indexOf(stream), 1)
    })
    return stream
  }

  // namespace (name='') {
  //   if (!Buffer.isBuffer(name)) name = Buffer.from(name)
  //   return new Store(this.storage, {
  //     _namespace: generateNamespace(this._namespace, name),
  //     _opening: this._opening,
  //     _cores: this.cores,
  //     _streams: this._replicationStreams,
  //     keys: this._opening.then(() => this.keys)
  //   })
  // }

  async _close () {
    if (this._closing) return this._closing
    await this._opening
    const closePromises = []
    for (const core of this.cores.values()) {
      closePromises.push(core.close())
    }
    await Promise.allSettled(closePromises)
    for (const stream of this._replicationStreams) {
      stream.destroy()
    }
    await this.keys.close()
  }

  close () {
    if (this._closing) return this._closing
    this._closing = this._close()
    this._closing.catch(noop)
    return this._closing
  }

  static createToken () {
    return Keys.createToken()
  }
}

function validateGetOptions (opts) {
  if (Buffer.isBuffer(opts)) return { key: opts, publicKey: opts }
  if (opts.key) {
    opts.publicKey = opts.key
  }
  if (opts.keyPair) {
    opts.publicKey = opts.keyPair.publicKey
    opts.secretKey = opts.keyPair.secretKey
  }
  if (opts.channel && typeof opts.channel !== 'string') throw new Error('channel option must be a String')
  if (opts.channel && opts.secretKey) throw new Error('Cannot provide both a channel and a secret key')
  if (opts.publicKey && !Buffer.isBuffer(opts.publicKey)) throw new Error('publicKey option must be a Buffer')
  if (opts.secretKey && !Buffer.isBuffer(opts.secretKey)) throw new Error('secretKey option must be a Buffer')
  if (opts.discoveryKey && !Buffer.isBuffer(opts.discoveryKey)) throw new Error('discoveryKey option must be a Buffer')
  if (!opts.channel && !opts.publicKey) throw new Error('Must provide either a channel or a publicKey')
  return opts
}

// function generateNamespace (first, second) {
//   if (!Buffer.isBuffer(first)) first = Buffer.from(first)
//   if (second && !Buffer.isBuffer(second)) second = Buffer.from(second)
//   const out = Buffer.allocUnsafe(32)
//   sodium.crypto_generichash(out, second ? Buffer.concat([first, second]) : first)
//   return out
// }

function isStream (s) {
  return typeof s === 'object' && s && typeof s.pipe === 'function'
}

function noop () {}
