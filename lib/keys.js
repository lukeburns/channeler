const { crypto, writable, readable } = require('hypercore-channels')

module.exports = class KeyManager {
  constructor (storage, secretKey, opts = {}) {
    this.storage = storage
    this.secretKey = secretKey
    this.crypto = crypto
  }

  get discoveryKey () {
    return crypto.discoveryKey(this.publicKey)
  }

  get publicKey () {
    return crypto.keyPair(this.secretKey).publicKey
  }

  writable (bytes, peerKey) {
    return writable(bytes, this.secretKey, peerKey)
  }

  readable (bytes, peerKey, priv = false) {
    return readable(bytes, peerKey, priv ? this.secretKey : undefined)
  }

  close () {
    return new Promise((resolve, reject) => {
      this.storage.close(err => {
        if (err) return reject(err)
        return resolve()
      })
    })
  }

  static keyPair () {
    return crypto.keyPair()
  }

  static async fromStorage (storage, opts = {}) {
    const keyStorage = storage(opts.channel || 'default')

    const key = await new Promise((resolve, reject) => {
      keyStorage.stat((err, st) => {
        if (err && err.code !== 'ENOENT') return reject(err)
        if (err || st.size < crypto.secretKeySize || opts.overwrite) {
          const { secretKey } = opts.secretKey ? opts : KeyManager.keyPair()
          return keyStorage.write(0, secretKey, err => {
            if (err) return reject(err)
            return resolve(secretKey)
          })
        }
        keyStorage.read(0, crypto.secretKeySize, (err, secretKey) => {
          if (err) return reject(err)
          return resolve(secretKey)
        })
      })
    })

    return new this(keyStorage, key, opts)
  }
}
