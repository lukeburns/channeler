const ChannelStore = require('.').Store
const Hyperswarm = require('hyperswarm')
const Hyperbee = require('hyperbee')
const ram = require('random-access-memory')

main()

async function main () {
  const myStore = new ChannelStore(ram)
  const peerStore = new ChannelStore(ram)
  await myStore.ready()
  await peerStore.ready()

  const myKey = myStore.key.toString('hex')
  const peerKey = peerStore.key.toString('hex')

  const writableChannel = myStore.writable({ channel: '/' })
  const writablePrivateChannel = myStore.writable({ channel: '/', peerKey })
  const readableChannel = peerStore.readable({ channel: '/', peerKey: myKey })
  const readablePrivateChannel = peerStore.readable({ channel: '/', peerKey: myKey, private: true })

  await writableChannel.ready()
  await writablePrivateChannel.ready()
  await readableChannel.ready()
  await readablePrivateChannel.ready()

  const mySwarm = new Hyperswarm()
  await mySwarm.listen()
  mySwarm.on('connection', socket => {
    console.log('connection!')
    myStore.replicate(socket)
  })
  mySwarm.join(Buffer.alloc(32).fill('hello world'))

  const peerSwarm = new Hyperswarm()
  await peerSwarm.listen()
  peerSwarm.on('connection', socket => {
    console.log('connection.')
    peerStore.replicate(socket)
  })
  peerSwarm.join(Buffer.alloc(32).fill('hello world'))

  const opts = {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  }
  const writableBee = new Hyperbee(writableChannel, opts)
  const writablePrivateBee = new Hyperbee(writablePrivateChannel, opts)
  const readableBee = new Hyperbee(readableChannel, opts)
  const readablePrivateBee = new Hyperbee(readablePrivateChannel, opts)

  writableBee.put('message', 'miss u')
  writablePrivateBee.put('message', 'miss u too')

  await mySwarm.flush()

  console.log((await readableBee.get('message')))
  console.log((await readablePrivateBee.get('message')))
}
